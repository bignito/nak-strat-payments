/**
 * Public swap API for the NAK swap page.
 *
 * Mount in the existing nak-strat-payments app:
 *
 *   const swapRouter = require("./server/swap-router.js");
 *   const { embedHeaders } = require("./server/embed-headers.js");
 *   const { warmTokenCache } = require("./server/tokens.js");
 *
 *   app.set("trust proxy", 1);  // Railway sits behind a proxy
 *   app.use("/api/swap", swapRouter);
 *
 * Mount this BELOW the existing express.json() line, which sits below the
 * Stripe webhook's express.raw(). That order is what keeps webhook signature
 * verification working — do not move it.
 *
 * Everything here is a narrowed proxy: the browser never sees a Houdini
 * credential, and responses are reshaped so partner-internal fields
 * (commission, markup, provider allowlists) don't leak.
 */

const { Router } = require("express");
const {
  HoudiniError,
  createExchange,
  credentialsPresent,
  getChartStats,
  getMinMax,
  getOrder,
  getQuotes,
  getVolumeStats,
  getWeeklyVolumeStats,
  searchTokens,
} = require("./houdini.js");
const { publicToken, resolveCatalog, resolveFeaturedTokens } = require("./tokens.js");

const router = Router();

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const HOUDINI_ID = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Cross-origin access, allowlisted.
 *
 * Only needed when the swap page is served from somewhere other than this
 * service — e.g. the Caffeine canister behind www.naktoken.lol. Same-origin
 * hosting never triggers a preflight and never reaches this.
 *
 * The allowlist is exact-match on purpose. A wildcard here would let any site
 * drive quote and order creation against the partner account.
 */
const ALLOWED_ORIGINS = new Set(
  (process.env.SWAP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean)
);

router.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.set({
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-user-timezone",
      "Access-Control-Max-Age": "86400",
      // No Allow-Credentials: this API uses no cookies, so a stolen origin
      // gains nothing beyond what a plain server-side call could already do.
      Vary: "Origin",
    });
  }
  if (req.method === "OPTIONS") return res.sendStatus(origin && ALLOWED_ORIGINS.has(origin) ? 204 : 403);
  next();
});

/** Per-IP sliding window. Quotes are the expensive call, so they get their own budget. */
function rateLimit({ windowMs = 60_000, max = 60 } = {}) {
  const hits = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, times] of hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
  }, windowMs).unref?.();

  return (req, res, next) => {
    const key = req.ip || "anon";
    const now = Date.now();
    const times = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (times.length >= max) {
      res.set("Retry-After", String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: "Too many requests. Wait a moment and try again." });
    }
    times.push(now);
    hits.set(key, times);
    next();
  };
}

/** Stats are partner-account data. Locked to a server-side caller. */
function requireOperator(req, res, next) {
  const expected = process.env.SWAP_ADMIN_TOKEN || process.env.CANISTER_SHARED_SECRET;
  const provided = req.get("x-admin-token") || req.get("x-canister-secret");
  if (!expected || !provided || provided !== expected) {
    return res.status(404).json({ error: "Not found" });
  }
  next();
}

function fail(res, err) {
  if (err instanceof HoudiniError) {
    if (err.status >= 500) console.error("[swap]", err.code, err.message, err.requestId || "");
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error("[swap] unexpected:", err);
  return res.status(500).json({ error: "Something went wrong on our side. Try again." });
}

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

// GET /api/swap/config — everything the page needs to render before any input.
router.get("/config", async (_req, res) => {
  if (!credentialsPresent()) {
    return res.status(503).json({ error: "Swap is temporarily unavailable." });
  }
  try {
    const featured = await resolveFeaturedTokens();
    res.set("Cache-Control", "public, max-age=300");
    res.json({
      featured,
      defaultFrom: process.env.SWAP_DEFAULT_FROM || "BTC",
      defaultTo: process.env.SWAP_DEFAULT_TO || "ICP",
      defaultType: process.env.SWAP_DEFAULT_QUOTE_TYPE || "private",
      supportsFixed: process.env.SWAP_ALLOW_FIXED !== "false",
      // Shown only once an order finishes: where someone goes next if they want
      // to trade the ICP they just received. Omit the URL to hide it entirely.
      nextStep: process.env.SWAP_NEXT_STEP_URL
        ? {
            url: process.env.SWAP_NEXT_STEP_URL,
            label: process.env.SWAP_NEXT_STEP_LABEL || "Trade on ICPSwap",
          }
        : null,
    });
  } catch (err) {
    if (err instanceof HoudiniError) return fail(res, err);
    console.error("[swap] config:", err.message);
    res.status(503).json({ error: "Swap is not configured yet.", code: "tokens_unresolved" });
  }
});

// GET /api/swap/catalog — every listed token, cached. The picker filters this
// in the browser so typing costs no upstream requests.
router.get("/catalog", rateLimit({ max: 30 }), async (_req, res) => {
  try {
    const tokens = await resolveCatalog();
    res.set("Cache-Control", "public, max-age=3600");
    res.json({ tokens, count: tokens.length });
  } catch (err) {
    if (err instanceof HoudiniError) return fail(res, err);
    res.status(503).json({ error: "Token list is unavailable.", code: "catalog_unavailable" });
  }
});

// GET /api/swap/tokens?term=sol — live search, used only if the catalog fails.
router.get("/tokens", rateLimit({ max: 60 }), async (req, res) => {
  const term = String(req.query.term || "").slice(0, 100);
  if (term.length < 2) return res.json({ tokens: [] });
  try {
    const { tokens } = await searchTokens({ term, hasCex: true, pageSize: 25, page: 1 }, req);
    res.json({ tokens: tokens.filter((t) => t.enabled !== false).map(publicToken) });
  } catch (err) {
    fail(res, err);
  }
});

/* ------------------------------------------------------------------ */
/* Quote                                                               */
/* ------------------------------------------------------------------ */

// GET /api/swap/quote?amount=0.5&from=<tokenId>&to=<tokenId>[&type=private|standard][&fixed=true]
router.get("/quote", rateLimit({ max: 30 }), async (req, res) => {
  const amount = Number(req.query.amount);
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  const type = req.query.type === "standard" ? "standard" : "private";
  const fixed = req.query.fixed === "true";

  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: "Enter an amount greater than zero." });
  }
  if (!OBJECT_ID.test(from) || !OBJECT_ID.test(to)) {
    return res.status(400).json({ error: "Pick both tokens." });
  }
  if (from === to) {
    return res.status(400).json({ error: "Pick two different tokens." });
  }

  try {
    const { quotes } = await getQuotes(
      { amount, from, to, types: [type], fixed: fixed || undefined, sort: "amountOut" },
      req
    );

    const usable = (quotes || []).filter((q) => q.quoteId && !q.error && !q.filtered);
    if (!usable.length) {
      const limits = (quotes || []).find((q) => q.min || q.max);
      return res.status(422).json({
        error: fixed
          ? "No fixed-rate route for this pair right now. Try a floating rate."
          : "No route available for this pair and amount right now.",
        code: "no_route",
        min: limits?.min ?? null,
        max: limits?.max ?? null,
      });
    }

    const best = usable[0];
    res.json({
      quote: {
        quoteId: best.quoteId,
        type: best.type,
        route: best.swapName || null,
        amountIn: best.amountIn,
        amountOut: best.amountOut,
        amountOutUsd: best.amountOutUsd ?? null,
        amountInUsd: best.amountInUsd ?? null,
        durationMinutes: best.duration ?? null,
        min: best.min ?? null,
        max: best.max ?? null,
        fixed: Boolean(best.fixed),
        validUntil: best.validUntil || null,
        requiresRefundAddress: Boolean(best.requiresRefundAddress || best.fixed),
      },
      alternatives: usable.length - 1,
    });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/swap/limits?from=<tokenId>&to=<tokenId>
router.get("/limits", rateLimit({ max: 30 }), async (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (!OBJECT_ID.test(from) || !OBJECT_ID.test(to)) {
    return res.status(400).json({ error: "Pick both tokens." });
  }
  try {
    res.json(await getMinMax({ from, to }, req));
  } catch (err) {
    fail(res, err);
  }
});

/* ------------------------------------------------------------------ */
/* Order                                                               */
/* ------------------------------------------------------------------ */

// POST /api/swap/order  { quoteId, addressTo, refundAddress?, destinationTag? }
router.post("/order", rateLimit({ max: 12 }), async (req, res) => {
  const { quoteId, addressTo, refundAddress, destinationTag, refundExtraId } = req.body || {};

  if (!quoteId || typeof quoteId !== "string") {
    return res.status(400).json({ error: "Get a quote first." });
  }
  if (!addressTo || typeof addressTo !== "string" || addressTo.length > 200) {
    return res.status(400).json({ error: "Enter the wallet address that should receive the funds." });
  }

  try {
    const order = await createExchange(
      {
        quoteId,
        addressTo: addressTo.trim(),
        ...(refundAddress ? { refundAddress: String(refundAddress).trim() } : {}),
        ...(refundExtraId ? { refundExtraId: String(refundExtraId).trim() } : {}),
        ...(destinationTag ? { destinationTag: String(destinationTag).trim() } : {}),
        walletInfo: "naktoken.lol",
      },
      req
    );
    res.status(201).json(shapeOrder(order));
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/swap/order/:houdiniId — poll for status. Houdini keeps orders 48h.
router.get("/order/:houdiniId", rateLimit({ max: 120 }), async (req, res) => {
  const { houdiniId } = req.params;
  if (!HOUDINI_ID.test(houdiniId)) return res.status(400).json({ error: "Unknown order." });
  try {
    const order = await getOrder(houdiniId, req);
    res.set("Cache-Control", "no-store");
    res.json(shapeOrder(order));
  } catch (err) {
    fail(res, err);
  }
});

const STATUS_LABEL = {
  "-2": "INITIALIZING",
  "-1": "NEW",
  0: "WAITING",
  1: "CONFIRMING",
  2: "EXCHANGING",
  3: "ANONYMIZING",
  4: "FINISHED",
  5: "EXPIRED",
  6: "FAILED",
  7: "REFUNDED",
  8: "DELETED",
};

function shapeOrder(order) {
  return {
    houdiniId: order.houdiniId,
    created: order.created,
    expires: order.expires,
    depositAddress: order.depositAddress,
    depositTag: order.depositTag || null,
    receiverAddress: order.receiverAddress,
    receiverTag: order.receiverTag || null,
    inAmount: order.inAmount,
    inSymbol: order.inSymbol,
    outAmount: order.outAmount,
    outSymbol: order.outSymbol,
    outAmountUsd: order.outAmountUsd ?? null,
    status: order.status,
    statusLabel: STATUS_LABEL[String(order.status)] || "UNKNOWN",
    displayStatus: order.displayStatus || null,
    anonymous: Boolean(order.anonymous),
    fixed: Boolean(order.fixed),
    etaMinutes: order.eta ?? null,
    route: order.swapName || null,
    outTxHash: order.outTransactionOutHash || null,
    explorer: order.outToken?.chainData?.hashUrl || null,
  };
}

/* ------------------------------------------------------------------ */
/* Partner stats (operator only)                                       */
/* ------------------------------------------------------------------ */

router.get("/stats/volume", requireOperator, async (_req, res) => {
  try {
    res.json(await getVolumeStats());
  } catch (err) {
    fail(res, err);
  }
});

router.get("/stats/weekly", requireOperator, async (_req, res) => {
  try {
    res.json(await getWeeklyVolumeStats());
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/swap/stats/chart?days=30&granularity=day
router.get("/stats/chart", requireOperator, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const granularity = req.query.granularity === "month" ? "month" : "day";
  try {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - days * 86_400_000).toISOString();
    res.json(await getChartStats({ metric: "volume", from, to, granularity }));
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
