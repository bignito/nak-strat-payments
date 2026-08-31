/**
 * Token registry.
 *
 * Houdini quotes are keyed by 24-character token IDs, not symbols, so the
 * featured tokens have to be resolved once and cached. Houdini's own guidance
 * is to never call /tokens on a per-user request.
 */

const { searchTokens } = require("./houdini.js");

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Symbols shown in both pickers, in display order.
 *
 * Entries may pin a chain with "SYMBOL:chainShort" — e.g. "ICP:icp". Do this
 * for anything where the wrong chain would be costly, because Houdini lists the
 * same ticker on many chains: ICP exists as a wrapped EVM token on Cronos,
 * ETH on Blast, BTC on Lightning. Picking by ticker alone is not safe.
 */
const FEATURED = (process.env.SWAP_FEATURED_SYMBOLS || "BTC,ETH,USDT,USDC,SOL,XMR,ICP,BNB")
  .split(",")
  .map((entry) => {
    const [symbol, chain] = entry.trim().split(":");
    return { symbol: (symbol || "").toUpperCase(), chain: chain ? chain.trim().toLowerCase() : null };
  })
  .filter((e) => e.symbol);

const FEATURED_SYMBOLS = FEATURED.map((e) => e.symbol);

/**
 * Acceptable chains per symbol when the config doesn't pin one, most preferred
 * first. A symbol with no entry here and no pin falls back to Houdini's own
 * ordering, which is only safe for tickers unique to one chain.
 */
const NATIVE_CHAINS = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "eth", "erc20"],
  USDT: ["ethereum", "eth", "erc20", "tron", "trc20"],
  USDC: ["ethereum", "eth", "erc20"],
  SOL: ["solana", "sol"],
  XMR: ["monero", "xmr"],
  ICP: ["icp", "internetcomputer", "internet-computer", "dfinity"],
  BNB: ["bsc", "bnb", "binance-smart-chain", "bep20"],
};

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

const chainKeys = (token) =>
  [token.chainData?.shortName, token.chain, token.chainData?.name]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase());

/**
 * Choose the right listing for a symbol.
 *
 * Returns null rather than guessing. Offering the wrong chain is worse than
 * offering nothing: a buyer sending BTC to a Lightning address, or receiving
 * "ICP" as a wrapped Cronos token that can never reach the IC, loses the funds
 * or ends up with something unusable. A missing token is a visible gap; a
 * wrong-chain token looks completely normal until it fails.
 */
function pick(symbol, pinnedChain, candidates) {
  const usable = candidates.filter((t) => t.enabled !== false);
  if (!usable.length) return null;

  if (pinnedChain) {
    return usable.find((t) => chainKeys(t).includes(pinnedChain)) || null;
  }

  const allowed = NATIVE_CHAINS[symbol];
  if (allowed) {
    for (const chain of allowed) {
      const hit =
        usable.find((t) => chainKeys(t).includes(chain) && t.mainnet && !t.unverified) ||
        usable.find((t) => chainKeys(t).includes(chain));
      if (hit) return hit;
    }
    return null; // known symbol, no acceptable chain — omit it
  }

  // No rule for this symbol: trust Houdini's ordering.
  return usable.find((t) => t.mainnet && !t.unverified) || usable[0] || null;
}

/**
 * The tokens offered up front on both sides of the swap.
 *
 * One bulk page, not one request per symbol. The partner account is rate
 * limited per minute, and eight sequential lookups at boot exhausted the
 * budget before finishing.
 */
async function resolveFeaturedTokens() {
  if (cache.featured && Date.now() - cache.at < TTL_MS) return cache.featured;

  const wanted = new Set(FEATURED_SYMBOLS);
  const bySymbol = new Map();
  const add = (token) => {
    const symbol = (token.symbol || "").toUpperCase();
    if (!wanted.has(symbol)) return;
    bySymbol.set(symbol, [...(bySymbol.get(symbol) || []), token]);
  };

  try {
    const { tokens } = await searchTokens({ hasCex: true, pageSize: 1000, page: 1 });
    tokens.forEach(add);
  } catch (err) {
    console.error("[tokens] bulk fetch failed:", err.message);
  }

  const resolved = new Map();
  for (const { symbol, chain } of FEATURED) {
    const hit = pick(symbol, chain, bySymbol.get(symbol) || []);
    if (hit) resolved.set(symbol, hit);
  }

  // Targeted lookups only for what the bulk page couldn't satisfy, spaced so
  // the retries don't re-trigger the rate limit.
  const missing = FEATURED.filter((e) => !resolved.has(e.symbol));
  for (const { symbol, chain } of missing) {
    try {
      const { tokens } = await searchTokens({ symbol, hasCex: true, pageSize: 50, page: 1 });
      tokens.forEach(add);
      const hit = pick(symbol, chain, bySymbol.get(symbol) || []);
      if (hit) resolved.set(symbol, hit);
      else {
        const seen = [...new Set((bySymbol.get(symbol) || []).flatMap(chainKeys))];
        console.error(
          `[tokens] ${symbol}: no acceptable chain. Houdini offers: ${seen.join(", ") || "nothing"}. ` +
            `Pin one via SWAP_FEATURED_SYMBOLS="${symbol}:<chain>".`
        );
      }
    } catch (err) {
      console.error(`[tokens] could not resolve ${symbol}:`, err.message);
    }
    if (missing.length > 1) await sleep(1500);
  }

  const found = FEATURED_SYMBOLS.filter((s) => resolved.has(s)).map((s) => publicToken(resolved.get(s)));
  if (!found.length) throw new Error("Could not resolve any tokens from Houdini");

  found.forEach((t) => console.log(`[tokens] ${t.symbol} -> ${t.chain} (${t.chainShort || "?"}) ${t.id}`));

  const stillMissing = FEATURED_SYMBOLS.filter((s) => !resolved.has(s));
  if (stillMissing.length) console.warn(`[tokens] omitted: ${stillMissing.join(", ")}`);

  // A partial result is cached briefly so a transient failure doesn't lock in a
  // short list all day, but still shields the API from retrying every request.
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
