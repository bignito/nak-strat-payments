/**
 * Token registry.
 *
 * Houdini quotes are keyed by 24-character token IDs, not symbols, so the
 * featured tokens have to be resolved once and cached. Houdini's own guidance
 * is to never call /tokens on a per-user request.
 */

const { searchTokens } = require("./houdini.js");

const TTL_MS = 24 * 60 * 60 * 1000;

/** Symbols shown in both pickers before the user searches, in display order. */
const FEATURED_SYMBOLS = (process.env.SWAP_FEATURED_SYMBOLS || "BTC,ETH,USDT,USDC,SOL,XMR,ICP,BNB")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const cache = { featured: null, at: 0 };

/** Strip Houdini's token object down to what the browser actually needs. */
function publicToken(token) {
  if (!token) return null;
  return {
    id: token.id,
    symbol: token.symbol,
    name: token.name,
    chain: token.chainData?.name || token.chain,
    chainShort: token.chainData?.shortName || null,
    icon: token.icon || null,
    decimals: token.decimals,
    memoNeeded: Boolean(token.chainData?.memoNeeded),
    addressPattern: token.chainData?.addressValidation || null,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pick the most sensible listing when a symbol matches several. */
function bestOf(tokens) {
  return (
    tokens.find((t) => t.mainnet && t.enabled !== false && !t.unverified) ||
    tokens.find((t) => t.mainnet && t.enabled !== false) ||
    tokens.find((t) => t.enabled !== false) ||
    tokens[0] ||
    null
  );
}

/**
 * The tokens offered up front on both sides of the swap.
 *
 * One bulk page, not one request per symbol. The partner account is rate
 * limited per minute, and eight sequential lookups at boot exhausted the
 * budget before finishing — leaving ICP, the default destination, unresolved.
 * A single large page covers every featured symbol in one request.
 */
async function resolveFeaturedTokens() {
  if (cache.featured && Date.now() - cache.at < TTL_MS) return cache.featured;

  const wanted = new Set(FEATURED_SYMBOLS);
  const bySymbol = new Map();

  try {
    const { tokens } = await searchTokens({ hasCex: true, pageSize: 1000, page: 1 });
    for (const token of tokens) {
      const symbol = (token.symbol || "").toUpperCase();
      if (!wanted.has(symbol)) continue;
      const existing = bySymbol.get(symbol) || [];
      existing.push(token);
      bySymbol.set(symbol, existing);
    }
  } catch (err) {
    console.error("[tokens] bulk fetch failed:", err.message);
  }

  // Anything the bulk page missed gets a targeted lookup, spaced out so the
  // retries don't re-trigger the same limit that caused the miss.
  const missing = FEATURED_SYMBOLS.filter((s) => !bySymbol.has(s));
  for (const symbol of missing) {
    try {
      const { tokens } = await searchTokens({ symbol, hasCex: true, pageSize: 50, page: 1 });
      if (tokens.length) bySymbol.set(symbol, tokens);
    } catch (err) {
      console.error(`[tokens] could not resolve ${symbol}:`, err.message);
    }
    if (missing.length > 1) await sleep(1500);
  }

  // Preserve the configured display order.
  const found = FEATURED_SYMBOLS.map((symbol) => {
    const best = bestOf(bySymbol.get(symbol) || []);
    return best ? publicToken(best) : null;
  }).filter(Boolean);

  if (!found.length) throw new Error("Could not resolve any tokens from Houdini");

  const stillMissing = FEATURED_SYMBOLS.filter((s) => !found.some((t) => t.symbol === s));
  if (stillMissing.length) {
    console.warn(`[tokens] not listed or unresolved: ${stillMissing.join(", ")}`);
  }

  // Only cache a complete result for the full day. A partial result is cached
  // briefly so a transient limit doesn't lock in a short token list until
  // tomorrow, but still shields the API from a retry on every request.
  cache.featured = found;
  cache.at = stillMissing.length ? Date.now() - TTL_MS + 5 * 60 * 1000 : Date.now();
  return cache.featured;
}

/** Warm the cache at boot so the first visitor doesn't pay the latency. */
async function warmTokenCache() {
  try {
    await resolveFeaturedTokens();
  } catch (err) {
    console.error("[tokens] warm-up failed:", err.message);
  }
}

function clearTokenCache() {
  cache.featured = null;
  cache.at = 0;
}

module.exports = { publicToken, resolveFeaturedTokens, warmTokenCache, clearTokenCache };
