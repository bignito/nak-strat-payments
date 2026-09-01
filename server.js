/**
 * NAK Strat — Stripe Payment Service
 *
 * This service is the ONLY place the Stripe secret key lives.
 * The Internet Computer canister calls this over HTTPS outcall; it never
 * sees or stores the key.
 *
 * The swap lives in its own service (nakswap-service) so that this process
 * holds no credentials the public-facing swap could reach. Do not add the
 * swap back here.
 *
 * Endpoints:
 *   POST /create-checkout-session  -> creates a Stripe Checkout Session
 *   GET  /order-status/:orderId    -> canister polls this to confirm payment
 *   POST /webhook                  -> Stripe pushes payment events here
 *   GET  /health                   -> uptime check
 *
 * All endpoints except /webhook and /health require:
 *   Authorization: Bearer <CANISTER_SHARED_SECRET>
 */

const express = require('express');
const Stripe = require('stripe');
const {
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  CANISTER_SHARED_SECRET,
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
const app = express();

// Railway terminates TLS upstream. Correct for any service behind its proxy,
// so req.ip and req.protocol reflect the real client rather than the proxy.
app.set('trust proxy', 1);

/**
 * Order status store.
 *
 * In-memory is fine for launch: the webhook is a fast path, and
 * /order-status falls back to querying Stripe directly, so a restart
 * loses nothing that can't be re-derived. Swap for Redis or Postgres
 * when you want history and analytics.
 */
const orders = new Map();
const processedEvents = new Set();

// ---------------------------------------------------------------------------
// Webhook must be registered BEFORE express.json() so the raw body survives
// for signature verification. Order matters here.
// ---------------------------------------------------------------------------
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Idempotency: Stripe retries, and retries must not double-apply.
    if (processedEvents.has(event.id)) {
      return res.json({ received: true, duplicate: true });
    }
    processedEvents.add(event.id);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const orderId = session.metadata?.order_id;
        if (orderId) {
          orders.set(orderId, {
            orderId,
            status: session.payment_status === 'paid' ? 'paid' : 'pending',
            paymentReference: session.payment_intent || session.id,
            amountTotal: session.amount_total,
            currency: session.currency,
            customerEmail:
              session.customer_details?.email || session.customer_email || null,
            customerName: session.customer_details?.name || null,
            shippingAddress: session.collected_information?.shipping_details || null,
            updatedAt: Date.now(),
          });
          console.log(`Order ${orderId} marked paid.`);
        }
        break;
      }

      case 'checkout.session.expired': {
        const session = event.data.object;
        const orderId = session.metadata?.order_id;
        if (orderId) {
          const existing = orders.get(orderId) || { orderId };
          // Never downgrade an already-paid order.
          if (existing.status !== 'paid') {
            orders.set(orderId, {
              ...existing,
              status: 'expired',
              updatedAt: Date.now(),
            });
          }
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const intent = event.data.object;
        const orderId = intent.metadata?.order_id;
        if (orderId) {
          const existing = orders.get(orderId) || { orderId };
          if (existing.status !== 'paid') {
            orders.set(orderId, {
              ...existing,
              status: 'failed',
              failureMessage: intent.last_payment_error?.message || null,
              updatedAt: Date.now(),
            });
          }
        }
        break;
      }

      default:
        break;
    }

    res.json({ received: true });
  }
);

app.use(express.json({ limit: '256kb' }));

// ---------------------------------------------------------------------------
// Shared-secret auth for canister-facing endpoints
// ---------------------------------------------------------------------------
function requireCanisterAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  // Constant-time-ish comparison to avoid leaking the secret via timing.
  if (!token || token.length !== CANISTER_SHARED_SECRET.length) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ CANISTER_SHARED_SECRET.charCodeAt(i);
  }
  if (mismatch !== 0) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ---------------------------------------------------------------------------
// POST /create-checkout-session
// ---------------------------------------------------------------------------
app.post('/create-checkout-session', requireCanisterAuth, async (req, res) => {
  try {
    const {
      orderId,
      lineItems,
      currency = 'usd',
      customerEmail,
      successUrl,
      cancelUrl,
    } = req.body;

    if (!orderId || !Array.isArray(lineItems) || lineItems.length === 0) {
      return res
        .status(400)
        .json({ error: 'orderId and a non-empty lineItems array are required' });
    }
    if (!successUrl || !cancelUrl) {
      return res.status(400).json({ error: 'successUrl and cancelUrl are required' });
    }

    // The canister is the source of truth for pricing. This service passes
    // through what it is given and does not compute or adjust amounts.
    const stripeLineItems = lineItems.map((item) => {
      const unitAmount = Number(item.unitAmount);
      const quantity = Number(item.quantity);

      if (!Number.isInteger(unitAmount) || unitAmount <= 0) {
        throw new Error(`Invalid unitAmount for item ${item.name}`);
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error(`Invalid quantity for item ${item.name}`);
      }

      return {
        price_data: {
          currency,
          product_data: {
            name: item.name,
            ...(item.description ? { description: item.description } : {}),
            ...(item.images?.length ? { images: item.images.slice(0, 8) } : {}),
            metadata: {
              product_id: String(item.productId ?? ''),
              variant: String(item.variant ?? ''),
            },
          },
          unit_amount: unitAmount, // cents
        },
        quantity,
      };
    });

    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: stripeLineItems,
        success_url: `${successUrl}${successUrl.includes('?') ? '&' : '?'}order_id=${encodeURIComponent(orderId)}`,
        cancel_url: `${cancelUrl}${cancelUrl.includes('?') ? '&' : '?'}order_id=${encodeURIComponent(orderId)}`,
        ...(customerEmail ? { customer_email: customerEmail } : {}),
        shipping_address_collection: {
          allowed_countries: ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'NL', 'IE'],
        },
        phone_number_collection: { enabled: true },
        metadata: { order_id: orderId },
        payment_intent_data: { metadata: { order_id: orderId } },
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      },
      // Stripe-level idempotency: a retried outcall reuses the same session
      // instead of creating a second one for the same order.
      { idempotencyKey: `checkout:${orderId}` }
    );

    orders.set(orderId, {
      orderId,
      status: 'pending',
      sessionId: session.id,
      updatedAt: Date.now(),
    });

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (err) {
    console.error('create-checkout-session failed:', err.message);
    res.status(500).json({ error: 'failed_to_create_session' });
  }
});

// ---------------------------------------------------------------------------
// GET /order-status/:orderId
//
// Response shape is deliberately minimal and stable. The canister runs this
// through an HTTPS-outcall transform across replicas, so every field here
// must be identical on repeated calls. No timestamps, no echoed headers.
// ---------------------------------------------------------------------------
app.get('/order-status/:orderId', requireCanisterAuth, async (req, res) => {
  const { orderId } = req.params;

  try {
    const cached = orders.get(orderId);

    // Fast path: webhook already confirmed it.
    if (cached?.status === 'paid') {
      return res.json({
        orderId,
        status: 'paid',
        paymentReference: cached.paymentReference || '',
        amountTotal: cached.amountTotal ?? 0,
        currency: cached.currency || 'usd',
        customerEmail: cached.customerEmail || '',
      });
    }

    // Fallback: ask Stripe directly. Covers webhook delay or a restart.
    const sessions = await stripe.checkout.sessions.list({ limit: 100 });
    const session = sessions.data.find((s) => s.metadata?.order_id === orderId);

    if (!session) {
      return res.json({
        orderId,
        status: cached?.status || 'unknown',
        paymentReference: '',
        amountTotal: 0,
        currency: 'usd',
        customerEmail: '',
      });
    }

    const status = session.payment_status === 'paid' ? 'paid' : 'pending';

    if (status === 'paid') {
      orders.set(orderId, {
        orderId,
        status: 'paid',
        paymentReference: session.payment_intent || session.id,
        amountTotal: session.amount_total,
        currency: session.currency,
        customerEmail: session.customer_details?.email || '',
        updatedAt: Date.now(),
      });
    }

    res.json({
      orderId,
      status,
      paymentReference: status === 'paid' ? session.payment_intent || session.id : '',
      amountTotal: session.amount_total ?? 0,
      currency: session.currency || 'usd',
      customerEmail: session.customer_details?.email || '',
    });
  } catch (err) {
    console.error('order-status failed:', err.message);
    res.status(500).json({ error: 'failed_to_fetch_status' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`NAK Strat payment service listening on port ${PORT}`);
});
