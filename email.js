/**
 * Transactional email for NAK, via Resend.
 *
 * Templates are deliberately plain: tables, inline styles, no flexbox or
 * grid. Email clients are roughly fifteen years behind browsers and a
 * clever layout is a layout that breaks in Outlook.
 *
 * Transactional mail (order confirmation, payment pending, shipping,
 * submission acknowledgement) sends regardless of marketing consent — it is
 * a direct response to something the person did. Only marketing checks the
 * suppression list.
 */

const { Resend } = require('resend');
const { query } = require('./db');

const { RESEND_API_KEY, FROM_EMAIL, REPLY_TO_EMAIL, SITE_URL } = process.env;

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const FROM = FROM_EMAIL || 'NAK <orders@naktoken.lol>';
const REPLY_TO = REPLY_TO_EMAIL || 'orders@naktoken.lol';
const SITE = (SITE_URL || 'https://www.naktoken.lol').replace(/\/$/, '');

const money = (cents, currency = 'usd') =>
  `${currency.toUpperCase() === 'USD' ? '$' : ''}${(Number(cents || 0) / 100).toFixed(2)}`;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

/** Shared shell. Dark, restrained, matching the institutional site. */
function shell(innerHtml) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#08090a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#08090a;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#0e1011;border:1px solid rgba(255,255,255,0.09);">
<tr><td style="padding:28px 28px 20px;border-bottom:1px solid rgba(255,255,255,0.09);">
<span style="font-family:Helvetica,Arial,sans-serif;font-size:15px;letter-spacing:0.14em;color:#f4f4f5;font-weight:600;">N.A.K.</span>
<span style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#8a8a93;padding-left:10px;">New Age Kapital</span>
</td></tr>
<tr><td style="padding:28px;">${innerHtml}</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid rgba(255,255,255,0.09);">
<span style="font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#8a8a93;">© 2026 New Age Kapital</span>
</td></tr>
</table></td></tr></table></body></html>`;
}

const H = (t) =>
  `<h1 style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:19px;font-weight:500;color:#f4f4f5;">${esc(t)}</h1>`;
const P = (t) =>
  `<p style="margin:0 0 14px;font-family:Helvetica,Arial,sans-serif;font-size:14px;line-height:1.6;color:#a1a1aa;">${t}</p>`;
const REF = (r) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 18px;"><tr>
   <td style="background:#08090a;border:1px solid rgba(255,255,255,0.09);padding:10px 14px;">
   <span style="font-family:'Courier New',monospace;font-size:11px;color:#8a8a93;letter-spacing:0.12em;">ORDER</span><br>
   <span style="font-family:'Courier New',monospace;font-size:15px;color:#f4f4f5;">${esc(r)}</span>
   </td></tr></table>`;

function itemsTable(items = [], { subtotal, tax, shipping, total, currency }) {
  const rows = items.map((i) => `
    <tr>
      <td style="padding:7px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#d4d4d8;">
        ${esc(i.name)} <span style="color:#8a8a93;">× ${Number(i.quantity)}</span>
      </td>
      <td align="right" style="padding:7px 0;font-family:'Courier New',monospace;font-size:13px;color:#d4d4d8;">
        ${money(Number(i.unitAmount) * Number(i.quantity), currency)}
      </td>
    </tr>`).join('');

  const line = (label, value, strong) => `
    <tr>
      <td style="padding:5px 0;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:${strong ? '#f4f4f5' : '#8a8a93'};">${label}</td>
      <td align="right" style="padding:5px 0;font-family:'Courier New',monospace;font-size:${strong ? '15px' : '13px'};color:${strong ? '#f4f4f5' : '#a1a1aa'};">${value}</td>
    </tr>`;

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
    ${rows}
    <tr><td colspan="2" style="border-top:1px solid rgba(255,255,255,0.09);padding-top:8px;"></td></tr>
    ${line('Subtotal', money(subtotal, currency))}
    ${shipping ? line('Shipping', money(shipping, currency)) : ''}
    ${tax ? line('Tax', money(tax, currency)) : ''}
    <tr><td colspan="2" style="border-top:1px solid rgba(255,255,255,0.09);padding-top:8px;"></td></tr>
    ${line('Total', money(total, currency), true)}
  </table>`;
}

async function send({ to, subject, html }) {
  if (!resend) throw new Error('RESEND_API_KEY not configured');
  const { data, error } = await resend.emails.send({
    from: FROM,
    to: [to],
    replyTo: REPLY_TO,
    subject,
    html,
  });
  if (error) throw new Error(error.message || 'Resend send failed');
  return data;
}

// --- Order confirmation: payment confirmed, here is what is shipping -------
async function sendOrderConfirmation(body) {
  const { reference, items, subtotal, tax, shipping, total, currency, customerEmail, paymentMethod } = body;
  const methodLabel = {
    card_stripe: 'Card',
    crypto_ckusdc: 'ckUSDC',
    crypto_icp: 'ICP',
    manual: 'Manual',
  }[paymentMethod] || paymentMethod;

  const html = shell(
    H('Order confirmed') +
    P('We received your payment. Your order is being prepared.') +
    REF(reference) +
    itemsTable(items, { subtotal, tax, shipping, total, currency }) +
    P(`Paid by ${esc(methodLabel)}.`) +
    P(`Track this order any time at <a href="${SITE}/order-lookup" style="color:#a78bfa;">${SITE}/order-lookup</a> using the reference above.`)
  );

  return send({ to: customerEmail, subject: `Order confirmed — ${reference}`, html });
}

// --- Payment pending: crypto order created, funds not yet seen ------------
async function sendPaymentPending({ reference, customerEmail }) {
  const html = shell(
    H('Your order is waiting for payment') +
    P('Send the exact amount shown at checkout to the deposit address. Confirmation is automatic once the payment settles on-ledger — you can close the tab.') +
    REF(reference) +
    P(`Keep this reference. You can return to your order at <a href="${SITE}/order-lookup" style="color:#a78bfa;">${SITE}/order-lookup</a>.`) +
    P('If the payment window expires before you send, the order is released and you can start again.')
  );

  return send({ to: customerEmail, subject: `Awaiting payment — ${reference}`, html });
}

// --- Shipping notification ------------------------------------------------
async function sendShipping({ reference, customerEmail, trackingNumber }) {
  const html = shell(
    H('Your order has shipped') +
    REF(reference) +
    (trackingNumber
      ? P(`Tracking number: <span style="font-family:'Courier New',monospace;color:#f4f4f5;">${esc(trackingNumber)}</span>`)
      : P('Tracking information will follow separately.'))
  );

  return send({ to: customerEmail, subject: `Shipped — ${reference}`, html });
}

// --- Submission acknowledgement -------------------------------------------
// Deliberately non-committal. No response time promised, no acceptance
// implied — "no over-promises" has to hold in the automated mail too.
async function sendSubmissionAck({ name, email, discipline, link }) {
  const html = shell(
    H('We received your submission') +
    P(`Thanks ${esc(name)}. Here is what came through:`) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;background:#08090a;border:1px solid rgba(255,255,255,0.09);">
      <tr><td style="padding:14px;">
        <p style="margin:0 0 6px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#8a8a93;">Discipline</p>
        <p style="margin:0 0 12px;font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#f4f4f5;">${esc(discipline)}</p>
        <p style="margin:0 0 6px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#8a8a93;">Link</p>
        <p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:13px;"><a href="${esc(link)}" style="color:#a78bfa;">${esc(link)}</a></p>
      </td></tr>
    </table>` +
    P('We review submissions as we build the roster. If there is a fit, we will reach out.')
  );

  return send({ to: email, subject: 'We received your submission — N.A.K.', html });
}

// --- Internal notification to the team ------------------------------------
async function sendAdminNotification(subject, lines) {
  const to = process.env.ADMIN_NOTIFY_EMAIL;
  if (!to) return null;
  const html = shell(H(subject) + lines.map((l) => P(esc(l))).join(''));
  return send({ to, subject: `[N.A.K.] ${subject}`, html });
}

// --- Suppression ----------------------------------------------------------
async function isSuppressed(email) {
  const { rows } = await query('SELECT 1 FROM suppressions WHERE email = $1', [email]);
  return rows.length > 0;
}

module.exports = {
  sendOrderConfirmation,
  sendPaymentPending,
  sendShipping,
  sendSubmissionAck,
  sendAdminNotification,
  isSuppressed,
};
