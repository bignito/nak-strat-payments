# NAK Strat — Stripe Payment Service

The only place your Stripe secret key lives. Your Internet Computer canister
calls this service over HTTPS outcall; it never holds the key itself.

## Why this exists

Canister state is replicated across independent node providers. Anything you
store in a canister is readable by whoever operates those nodes. A Stripe
secret key there would be exposed, and webhook signature verification would be
unreliable because Stripe can't deliver a raw request body to a canister in a
form that survives replica consensus.

This service sits between them. It's small on purpose.

## Environment variables

| Variable | What it is |
|---|---|
| `STRIPE_SECRET_KEY` | Your Stripe secret key. `sk_test_...` while testing, `sk_live_...` in production. |
| `STRIPE_WEBHOOK_SECRET` | From the Stripe webhook endpoint you create below. Starts `whsec_...`. |
| `CANISTER_SHARED_SECRET` | A long random string you generate. The canister sends it as a bearer token. |
| `PORT` | Optional. Defaults to 3000. Most hosts set this for you. |

Generate the shared secret with:

```bash
openssl rand -hex 32
```

## Deploy

### Railway or Render

1. Push this folder to a Git repository.
2. Create a new service pointed at that repo.
3. Set the three environment variables above.
4. Deploy. Note the public URL you get back.

### Fly.io

```bash
fly launch --no-deploy
fly secrets set STRIPE_SECRET_KEY=sk_test_... \
               STRIPE_WEBHOOK_SECRET=whsec_... \
               CANISTER_SHARED_SECRET=<your random hex>
fly deploy
```

### Vercel

Works, but needs `vercel.json` routing all paths to `server.js` and the raw-body
handling on `/webhook` can be fragile on serverless. Railway or Fly is the
smoother path here.

## Stripe setup

1. **Rotate the key you pasted into chat.** Stripe Dashboard → Developers → API
   keys → roll it. Assume the old one is compromised.
2. Create the webhook: Developers → Webhooks → Add endpoint.
   - URL: `https://your-service-url/webhook`
   - Events: `checkout.session.completed`, `checkout.session.expired`,
     `payment_intent.payment_failed`
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET` and redeploy.

## Wire it to the canister

In your NAK Strat admin panel, set:

- `PAYMENT_SERVICE_URL` → `https://your-service-url`
- `PAYMENT_SERVICE_TOKEN` → the same `CANISTER_SHARED_SECRET`

## Test before going live

Use Stripe test mode and card `4242 4242 4242 4242` with any future expiry and
any CVC. Walk the whole path: add a cologne to the cart, check out with card,
complete payment, land on the success page, and confirm the order flips to paid
in your canister — not just in Stripe.

Then run the failure cases, because these are the ones that bite:

- Cancel at Stripe Checkout and confirm the order does not mark paid.
- Card `4000 0000 0000 0002` (generic decline).
- Let a session expire without paying, and confirm reserved inventory releases.
- Refresh the success page several times, and confirm inventory decrements once.

Only switch `STRIPE_SECRET_KEY` to a live key after all of those behave.

## Notes

Order state is in memory. That's deliberate — `/order-status` falls back to
querying Stripe directly, so a restart loses nothing that can't be re-derived.
Move to Redis or Postgres when you want order history and analytics in one
place rather than reading them out of the Stripe dashboard.
