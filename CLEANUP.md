# Reverting nak-strat-payments to payments-only

## 1. Replace one file

Upload `server.js` (overwrites the current one).

## 2. Delete two folders from the repo

    server/     (houdini.js, tokens.js, swap-router.js, embed-headers.js)
    public/     (index.html, nak-swap.css, nak-swap.js, assets/fonts/*)

Both now live in the nakswap repo. Leaving them here means the Houdini client
still sits in the same repo as the Stripe key, which is what the split removes.

## 3. Delete 10 variables from the nak-strat-payments Railway service

    HOUDINI_API_KEY
    HOUDINI_SECRET_KEY
    SWAP_FEATURED_SYMBOLS
    SWAP_DEFAULT_FROM
    SWAP_DEFAULT_TO
    SWAP_DEFAULT_QUOTE_TYPE
    SWAP_ALLOW_FIXED
    SWAP_FRAME_ANCESTORS
    SWAP_NEXT_STEP_URL
    SWAP_NEXT_STEP_LABEL

Keep everything else: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
CANISTER_SHARED_SECRET, DATABASE_URL, RESEND_API_KEY, FROM_EMAIL, PORT.

Deleting HOUDINI_API_KEY and HOUDINI_SECRET_KEY here is the step that actually
creates the boundary. Everything before it is housekeeping.

## 4. Verify after the deploy

    /health                        -> 200 {"ok":true}
    /order-status/anything         -> 401
    /create-checkout-session       -> 401 without a bearer token
    /                              -> 404 (the swap page is gone)
    /api/swap/config               -> 404

## What changed in server.js

Removed: the `path` require, the three swap requires, the `/api/swap` mount, the
static `public/` mount, and the `warmTokenCache()` call.

Kept: `app.set('trust proxy', 1)`. It is correct for any service behind Railway's
proxy so that `req.ip` and `req.protocol` reflect the real client. It has no
effect on the Stripe routes.

Untouched: every Stripe route, the webhook's `express.raw()` ordering, the
`express.json()` placement below it, `requireCanisterAuth`, the order store and
the idempotency handling. Verified by booting this exact file — webhook signature
verification still rejects a bad signature with 400, both canister endpoints still
return 401 without a token and pass auth with one, and no swap path responds.
