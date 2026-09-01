/**
 * NAK — payment, email and submissions service
 *
 * The only place Stripe and Resend credentials live. The Internet Computer
 * canister calls this over HTTPS outcall; it never holds a key, because
 * canister state is replicated across independent node providers.
 *
 * Endpoint paths below are NOT arbitrary — they are exactly what the
 * canister constructs in src/backend/lib/{payment-service,email,submissions,
 * consent}.mo. Renaming one silently breaks that call.
 *
 *   POST /create-checkout-session      Stripe Checkout Session
 *   GET  /order-status/:reference      canister polls to confirm payment
 *   POST /webhook                      Stripe events (no bearer; signature-verified)
 *   POST /orders/:reference/details    store shipping details
 *   GET  /orders/:reference/details    read them back for fulfilment
 *   POST /emails/order-confirmation
 *   POST /emails/payment-pending
 *   POST /emails/shipping
 *   POST /emails/unsubscribe
 *   GET  /emails/consent-list          CSV of consented addresses
 *   POST /submissions                  artist submission
 *   GET  /submissions                  list for admin
 *   GET  /health
 *
 * Every endpoint except /webhook and /health requires:
 *   Authorization: Bearer <CANISTER_SHARED_SECRET>
 */

const express = require('express');
const crypto = require('crypto');
const Stripe = require('stripe');
const db = require('./db');
const mail = require('./email');

const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  CANISTER_SHARED_SECRET,
  SITE_URL,
  PORT = 3000,
} = process.env;

for (const [name, value] of Object.entries({
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  CANISTER_SHARED_SECRET,
})) {
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
const SITE = (SITE_URL || 'https://www.naktoken.lol').replace(/\/$/, '');
const app = express();
app.set('trust proxy', 1);

/* -------------------------------------------------------------------------
 * Stripe webhook — MUST come before express.json() so the raw body survives
 * for signature verification. Order matters; moving this breaks signatures.
 * ---------------------------------------------------------------------- */
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    // Stripe retries. Recording the event id makes replay a no-op.
    const dup = await db.query(
      'INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id',
      [event.id]
    );
    if (dup.rowCount === 0) return res.json({ received: true, duplicate: true });

    const s = event.data.object;
    const reference = s.metadata?.order_id || s.metadata?.reference;

    if (reference) {
      if (event.type === 'checkout.session.completed') {
        await db.query(
          `INSERT INTO orders (reference, status, payment_reference, amount_total, currency, customer_email, customer_name, shipping_address, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
           ON CONFLICT (reference) DO UPDATE SET
             status = EXCLUDED.status,
             payment_reference = EXCLUDED.payment_reference,
             amount_total = EXCLUDED.amount_total,
             currency = EXCLUDED.currency,
             customer_email = COALESCE(EXCLUDED.customer_email, orders.customer_email),
             customer_name = COALESCE(EXCLUDED.customer_name, orders.customer_name),
             shipping_address = COALESCE(EXCLUDED.shipping_address, orders.shipping_address),
             updated_at = now()`,
          [
            reference,
            s.payment_status === 'paid' ? 'paid' : 'pending',
            s.payment_intent || s.id,
            s.amount_total,
            s.currency,
            s.customer_details?.email || s.customer_email || null,
            s.customer_details?.name || null,
            s.collected_information?.shipping_details
              ? JSON.stringify(s.collected_information.shipping_details)
              : null,
          ]
        );
        console.log(`[webhook] ${reference} -> paid`);
      } else if (event.type === 'checkout.session.expired' || event.type === 'payment_intent.payment_failed') {
        const next = event.type === 'checkout.session.expired' ? 'expired' : 'failed';
        // Never downgrade an order that is already paid.
        await db.query(
          `UPDATE orders SET status = $2, updated_at = now()
           WHERE reference = $1 AND status <> 'paid'`,
          [reference, next]
        );
      }
    }
  } catch (err) {
    console.error('[webhook] handler error:', err.message);
    // 200 anyway: Stripe would retry forever on a 500, and the event is
    // already recorded. /order-status falls back to querying Stripe.
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '256kb' }));

/* ----------------------------- auth ----------------------------------- */
function requireCanisterAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token || token.length !== CANISTER_SHARED_SECRET.length) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  // Constant-time-ish compare so the secret cannot be recovered by timing.
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ CANISTER_SHARED_SECRET.charCodeAt(i);
  }
  if (mismatch !== 0) return res.status(401).json({ error: 'unauthorized' });
  next();
}

/* --------------------------- rate limiting ----------------------------- */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count += 1;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k);
}, 60_000).unref();

/* ------------------- Stripe: create checkout session ------------------- */
app.post('/create-checkout-session', requireCanisterAuth, async (req, res) => {
  try {
    const { orderId, reference, lineItems, currency = 'usd', customerEmail, successUrl, cancelUrl } = req.body;
    const ref = reference || orderId;

    if (!ref || !Array.isArray(lineItems) || lineItems.length === 0) {
      return res.status(400).json({ error: 'reference and a non-empty lineItems array are required' });
    }

    // The canister is the source of truth for pricing. This service passes
    // through what it is given and never computes or adjusts an amount.
    const stripeLineItems = lineItems.map((item) => {
      const unitAmount = Number(item.unitAmount);
      const quantity = Number(item.quantity);
      if (!Number.isInteger(unitAmount) || unitAmount <= 0) throw new Error(`bad unitAmount for ${item.name}`);
      if (!Number.isInteger(quantity) || quantity <= 0) throw new Error(`bad quantity for ${item.name}`);
      return {
        price_data: {
          currency,
          product_data: {
            name: String(item.name || 'Item'),
            ...(item.description ? { description: String(item.description) } : {}),
          },
          unit_amount: unitAmount,
        },
        quantity,
      };
    });

    const success = successUrl || `${SITE}/checkout/success`;
    const cancel = cancelUrl || `${SITE}/checkout/cancelled`;

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: stripeLineItems,
        success_url: `${success}${success.includes('?') ? '&' : '?'}reference=${encodeURIComponent(ref)}`,
        cancel_url: `${cancel}${cancel.includes('?') ? '&' : '?'}reference=${encodeURIComponent(ref)}`,
        ...(customerEmail ? { customer_email: customerEmail } : {}),
        shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'NL', 'IE'] },
        phone_number_collection: { enabled: true },
        metadata: { order_id: ref, reference: ref },
        payment_intent_data: { metadata: { order_id: ref, reference: ref } },
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      },
      // A retried outcall reuses the same session instead of creating a second.
      { idempotencyKey: `checkout:${ref}` }
    );

    await db.query(
      `INSERT INTO orders (reference, status, session_id, customer_email, updated_at)
       VALUES ($1,'pending',$2,$3, now())
       ON CONFLICT (reference) DO UPDATE SET session_id = EXCLUDED.session_id, updated_at = now()`,
      [ref, session.id, customerEmail || null]
    );

    res.json({ checkoutUrl: session.url, url: session.url, sessionId: session.id });
  } catch (err) {
    console.error('[create-checkout-session]', err.message);
    res.status(500).json({ error: 'failed_to_create_session', detail: err.message });
  }
});

/* --------------------------- order status ------------------------------ */
// Response shape is deliberately minimal and STABLE: the canister runs this
// through an outcall transform across replicas, so repeated calls must return
// identical bytes. No timestamps, no echoed headers.
app.get('/order-status/:reference', requireCanisterAuth, async (req, res) => {
  const { reference } = req.params;
  try {
    const { rows } = await db.query('SELECT * FROM orders WHERE reference = $1', [reference]);
    const cached = rows[0];

    if (cached?.status === 'paid') {
      return res.json({
        reference,
        orderId: reference,
        status: 'paid',
        paymentReference: cached.payment_reference || '',
        amountTotal: Number(cached.amount_total || 0),
        currency: cached.currency || 'usd',
        customerEmail: cached.customer_email || '',
      });
    }

    // Fallback: ask Stripe directly. Covers webhook delay or a restart.
    let session = null;
    if (cached?.session_id) {
      session = await stripe.checkout.sessions.retrieve(cached.session_id).catch(() => null);
    }
    if (!session) {
      const list = await stripe.checkout.sessions.list({ limit: 100 });
      session = list.data.find((s) => (s.metadata?.order_id || s.metadata?.reference) === reference) || null;
    }

    if (!session) {
      return res.json({
        reference, orderId: reference,
        status: cached?.status || 'unknown',
        paymentReference: '', amountTotal: 0, currency: 'usd', customerEmail: '',
      });
    }

    const status = session.payment_status === 'paid' ? 'paid' : 'pending';
    if (status === 'paid') {
      await db.query(
        `INSERT INTO orders (reference, status, payment_reference, amount_total, currency, customer_email, updated_at)
         VALUES ($1,'paid',$2,$3,$4,$5, now())
         ON CONFLICT (reference) DO UPDATE SET
           status='paid', payment_reference=EXCLUDED.payment_reference,
           amount_total=EXCLUDED.amount_total, currency=EXCLUDED.currency,
           customer_email=COALESCE(EXCLUDED.customer_email, orders.customer_email),
           updated_at=now()`,
        [reference, session.payment_intent || session.id, session.amount_total,
         session.currency, session.customer_details?.email || null]
      );
    }

    res.json({
      reference, orderId: reference, status,
      paymentReference: status === 'paid' ? (session.payment_intent || session.id) : '',
      amountTotal: session.amount_total ?? 0,
      currency: session.currency || 'usd',
      customerEmail: session.customer_details?.email || '',
    });
  } catch (err) {
    console.error('[order-status]', err.message);
    res.status(500).json({ error: 'failed_to_fetch_status' });
  }
});

/* ------------------------ shipping details ----------------------------- */
app.post('/orders/:reference/details', requireCanisterAuth, async (req, res) => {
  const { reference } = req.params;
  const { name, email, line1, line2, city, region, postalCode, country } = req.body || {};
  if (!line1 || !city || !postalCode || !country) {
    return res.status(400).json({ ok: false, error: 'line1, city, postalCode and country are required' });
  }
  try {
    await db.query(
      `INSERT INTO orders (reference, customer_name, customer_email, shipping_address, updated_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (reference) DO UPDATE SET
         customer_name = EXCLUDED.customer_name,
         customer_email = COALESCE(EXCLUDED.customer_email, orders.customer_email),
         shipping_address = EXCLUDED.shipping_address,
         updated_at = now()`,
      [reference, name || null, email || null,
       JSON.stringify({ line1, line2: line2 || null, city, region: region || null, postalCode, country })]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[orders/details POST]', err.message);
    res.status(500).json({ ok: false, error: 'failed_to_store_details' });
  }
});

app.get('/orders/:reference/details', requireCanisterAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      'SELECT customer_name, customer_email, shipping_address FROM orders WHERE reference = $1',
      [req.params.reference]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({
      ok: true,
      name: rows[0].customer_name || '',
      email: rows[0].customer_email || '',
      address: rows[0].shipping_address || null,
    });
  } catch (err) {
    console.error('[orders/details GET]', err.message);
    res.status(500).json({ ok: false, error: 'failed_to_read_details' });
  }
});

/* ------------------------------ emails --------------------------------- */
// The canister checks for {"ok":"true"} as a STRING — it parses the response
// with a string-field extractor. Returning a JSON boolean would not match.
const okTrue = (res) => res.json({ ok: 'true' });
const okFalse = (res, detail) => res.status(500).json({ ok: 'false', detail });

app.post('/emails/order-confirmation', requireCanisterAuth, async (req, res) => {
  try {
    if (!req.body?.customerEmail) return okFalse(res, 'customerEmail missing');
    await mail.sendOrderConfirmation(req.body);
    res.json({ ok: 'true' });
  } catch (err) {
    console.error('[emails/order-confirmation]', err.message);
    okFalse(res, err.message);
  }
});

app.post('/emails/payment-pending', requireCanisterAuth, async (req, res) => {
  try {
    if (!req.body?.customerEmail) return okFalse(res, 'customerEmail missing');
    await mail.sendPaymentPending(req.body);
    res.json({ ok: 'true' });
  } catch (err) {
    console.error('[emails/payment-pending]', err.message);
    okFalse(res, err.message);
  }
});

app.post('/emails/shipping', requireCanisterAuth, async (req, res) => {
  try {
    if (!req.body?.customerEmail) return okFalse(res, 'customerEmail missing');
    await mail.sendShipping(req.body);
    res.json({ ok: 'true' });
  } catch (err) {
    console.error('[emails/shipping]', err.message);
    okFalse(res, err.message);
  }
});

/* -------------------------- consent / unsubscribe ---------------------- */
app.post('/emails/unsubscribe', requireCanisterAuth, async (req, res) => {
  const token = String(req.body?.token || '');
  if (!token) return res.status(400).json({ status: 'invalid' });
  if (!rateLimit(`unsub:${req.ip}`, 20, 60_000)) {
    return res.status(429).json({ status: 'rate_limited' });
  }
  try {
    const { rows } = await db.query(
      'SELECT email, used_at FROM unsubscribe_tokens WHERE token = $1',
      [token]
    );
    if (!rows[0]) return res.status(404).json({ status: 'invalid' });

    await db.query(
      'INSERT INTO suppressions (email) VALUES ($1) ON CONFLICT DO NOTHING',
      [rows[0].email]
    );
    await db.query(
      'UPDATE unsubscribe_tokens SET used_at = now() WHERE token = $1 AND used_at IS NULL',
      [token]
    );
    res.json({ status: 'unsubscribed' });
  } catch (err) {
    console.error('[emails/unsubscribe]', err.message);
    res.status(500).json({ status: 'error' });
  }
});

// CSV of consented, non-suppressed addresses. Suppression always wins.
app.get('/emails/consent-list', requireCanisterAuth, async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT c.email, c.consent_at FROM marketing_consent c
       LEFT JOIN suppressions s ON s.email = c.email
       WHERE c.consented = true AND s.email IS NULL
       ORDER BY c.consent_at DESC`
    );
    const csv = ['email,consented_at']
      .concat(rows.map((r) => `${r.email},${r.consent_at.toISOString()}`))
      .join('\n');
    res.type('text/csv').send(csv);
  } catch (err) {
    console.error('[emails/consent-list]', err.message);
    res.status(500).send('error');
  }
});

/* ---------------------------- submissions ------------------------------ */
app.post('/submissions', requireCanisterAuth, async (req, res) => {
  const { name, email, discipline, link, message, consent, company } = req.body || {};

  // Honeypot: a real person never fills a field they cannot see. Return
  // success so a bot has no signal that it was caught.
  if (company) return res.json({ ok: 'true' });

  if (!name || !email || !discipline || !link) {
    return res.status(400).json({ ok: 'false', error: 'name, email, discipline and link are required' });
  }
  if (!rateLimit(`sub:${req.ip}`, 5, 10 * 60_000)) {
    return res.status(429).json({ ok: 'false', error: 'rate_limited' });
  }

  try {
    await db.query(
      `INSERT INTO submissions (name, email, discipline, link, message, consent)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [name, email, discipline, link, message || null, Boolean(consent)]
    );

    if (consent) {
      await db.query(
        `INSERT INTO marketing_consent (email, consented, source)
         VALUES ($1, true, 'submission')
         ON CONFLICT (email) DO UPDATE SET consented = true, consent_at = now()`,
        [email]
      );
    }

    // Acknowledgement is transactional — it is a direct reply to an action
    // they took, so it sends regardless of marketing consent.
    mail.sendSubmissionAck({ name, email, discipline, link })
      .catch((e) => console.error('[submissions] ack failed:', e.message));
    mail.sendAdminNotification('New submission', [`${name} — ${discipline}`, link])
      .catch(() => {});

    res.json({ ok: 'true' });
  } catch (err) {
    console.error('[submissions POST]', err.message);
    res.status(500).json({ ok: 'false', error: 'failed_to_store' });
  }
});

app.get('/submissions', requireCanisterAuth, async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, email, discipline, link, message, consent, created_at
       FROM submissions ORDER BY created_at DESC LIMIT 500`
    );
    res.json({ ok: 'true', submissions: rows });
  } catch (err) {
    console.error('[submissions GET]', err.message);
    res.status(500).json({ ok: 'false', error: 'failed_to_list' });
  }
});

/* ------------------------------ health --------------------------------- */
app.get('/health', async (_req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch {
    res.status(503).json({ ok: false, db: false });
  }
});

/* ------------------------------- boot ---------------------------------- */
db.migrate()
  .then(() => {
    app.listen(PORT, () => console.log(`NAK payment service listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Startup failed — could not apply schema:', err.message);
    process.exit(1);
  });

module.exports = app;
