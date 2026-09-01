# N.A.K. — payment, email and submissions service

The only place Stripe and Resend credentials live. The Internet Computer
canister calls this over HTTPS outcall; it never holds a key, because canister
state is replicated across independent node providers and is not confidential
storage.

## Deploying

Commit all five files to `bignito/nak-strat-payments`, replacing the existing
`server.js` and `package.json`:

```
server.js      package.json      db.js      email.js      schema.sql
```

Railway redeploys on push. The schema applies automatically at boot — no
migration step to run.

## Environment variables

Already set on the `nak-strat-payments` service:

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_WEBHOOK_SECRET` | Signing secret from the Stripe webhook endpoint |
| `CANISTER_SHARED_SECRET` | Bearer token the canister authenticates with |
| `DATABASE_URL` | Points at `nak-strat-db` over Railway's private network |
| `RESEND_API_KEY` | Resend API key |
| `FROM_EMAIL` | `NAK STRATS <orders@naktoken.lol>` |
| `PORT` | 3000 |

Worth adding:

| Variable | Purpose |
|---|---|
| `SITE_URL` | `https://www.naktoken.lol` — used in email links |
| `REPLY_TO_EMAIL` | An inbox you actually read. Without it, replies go nowhere. |
| `ADMIN_NOTIFY_EMAIL` | Where new-submission notifications land |

## Endpoint paths are not arbitrary

Every path matches exactly what the canister constructs in
`src/backend/lib/{payment-service,email,submissions,consent}.mo`. Renaming one
silently breaks that call — the outcall will 404 and the canister reports a
generic failure.

```
POST /create-checkout-session      Stripe Checkout Session
GET  /order-status/:reference      canister polls to confirm payment
POST /webhook                      Stripe events (signature-verified, no bearer)
POST /orders/:reference/details    store shipping details
GET  /orders/:reference/details    read back for fulfilment
POST /emails/order-confirmation
POST /emails/payment-pending
POST /emails/shipping
POST /emails/unsubscribe
GET  /emails/consent-list          CSV of consented addresses
POST /submissions
GET  /submissions
GET  /health
```

## Two details that will bite if changed

**The webhook route is registered before `express.json()`.** Stripe signature
verification needs the raw request body. Moving that block below the JSON
parser breaks every webhook with a signature error that looks like a wrong
secret.

**Email endpoints return `{"ok":"true"}` — the string, not the boolean.** The
canister parses responses with a string-field extractor and checks for
`"true"`. A JSON boolean would not match and every send would be reported as
failed even when the mail went out.

## After deploying

Check `https://nak-strat-payments-production.up.railway.app/health` — you want
`{"ok":true,"db":true}`. If `db` is false, the schema did not apply; check the
deploy logs for a connection error.

Then place a test order and confirm a confirmation email arrives. Crypto orders
also get a payment-pending email at order creation, which is the one that
matters most — a crypto customer who closes the tab otherwise has no record of
their reference.

## Notes

Suppression always beats consent: an address on the suppression list is
excluded from `/emails/consent-list` even if a later order opts them back in.

Transactional email (order confirmation, payment pending, shipping, submission
acknowledgement) sends regardless of marketing consent. It is a direct response
to something the person did. Only marketing checks suppression.

Submissions use a honeypot field named `company`. When it is filled the request
returns success without storing anything, so a bot gets no signal it was caught.
