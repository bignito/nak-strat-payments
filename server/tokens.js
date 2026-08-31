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

/** The tokens offered up front on both sides of the swap. */
async function resolveFeaturedTokens() {
  if (cache.featured && Date.now() - cache.at < TTL_MS) return cache.featured;

  const found = [];
  for (const symbol of FEATURED_SYMBOLS) {
    try {
      const { tokens } = await searchTokens({ symbol, hasCex: true, pageSize: 50, page: 1 });
      const best =
        tokens.find((t) => t.mainnet && t.enabled !== false) ||
        tokens.find((t) => t.enabled !== false) ||
        tokens[0];
      if (best) found.push(publicToken(best));
    } catch (err) {
      console.error(`[tokens] could not resolve ${symbol}:`, err.message);
    }
  }

  if (!found.length) throw new Error("Could not resolve any tokens from Houdini");

  cache.featured = found;
  cache.at = Date.now();
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
