/**
 * Houdini Partner API v2 client.
 *
 * Credentials live here and nowhere else. Nothing in this file may be imported
 * by browser code — the Authorization header is `<apiKey>:<apiSecret>` in
 * plaintext, so exposing it exposes the account.
 *
 * Reads HOUDINI_API_KEY and HOUDINI_SECRET_KEY from the environment (already
 * set on the nak-strat-payments service in Railway).
 */

const BASE = process.env.HOUDINI_API_BASE || "https://api-partner.houdiniswap.com/v2";
const API_KEY = process.env.HOUDINI_API_KEY;
const API_SECRET = process.env.HOUDINI_SECRET_KEY;

if (!API_KEY || !API_SECRET) {
  console.warn(
    "[houdini] HOUDINI_API_KEY / HOUDINI_SECRET_KEY are not set. Swap routes will return 503."
  );
}

const credentialsPresent = () => Boolean(API_KEY && API_SECRET);

/** Error carrying an upstream HTTP status so the router can pass it through. */
class HoudiniError extends Error {
  constructor(message, { status = 502, code = "houdini_error", requestId, retryAfterMs } = {}) {
    super(message);
    this.name = "HoudiniError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Houdini requires x-user-ip, x-user-agent and x-user-timezone on every call
 * for AML/KYC compliance; requests without them are rejected with a 400.
 * These must describe the end user, not this server, so they are derived from
 * the inbound browser request.
 */
function complianceHeaders(req) {
  const forwarded = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || req.ip || req.socket?.remoteAddress || "0.0.0.0";

  return {
    "x-user-ip": ip.replace(/^::ffff:/, ""),
    "x-user-agent": req.headers["user-agent"] || "unknown",
    "x-user-timezone": String(req.headers["x-user-timezone"] || "UTC").slice(0, 64),
  };
}

function buildQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      value.forEach((v) => search.append(key, String(v)));
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Houdini's rate limit message carries the wait in plain text, e.g.
 * "FREE tier: 10 readHeavy requests per minute. Try again in 12 seconds."
 * Parsing it beats guessing a backoff.
 */
function retryDelayFrom(message, headerValue) {
  const header = Number(headerValue);
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const match = /try again in (\d+)\s*second/i.exec(message || "");
  return match ? (Number(match[1]) + 1) * 1000 : 5000;
}

async function request(path, { method = "GET", query, body, headers = {}, timeoutMs = 20000, retries = 2 } = {}) {
  if (!credentialsPresent()) {
    throw new HoudiniError("Swap service is not configured", {
      status: 503,
      code: "not_configured",
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${BASE}${path}${buildQuery(query)}`, {
      method,
      headers: {
        Authorization: `${API_KEY}:${API_SECRET}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      throw new HoudiniError("Houdini did not respond in time", {
        status: 504,
        code: "upstream_timeout",
      });
    }
    throw new HoudiniError("Could not reach Houdini", { status: 502, code: "upstream_unreachable" });
  }
  clearTimeout(timer);

  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (response.status === 429 && retries > 0) {
    const wait = retryDelayFrom(payload?.message, response.headers.get("retry-after"));
    // Capped so a boot-time warm-up can't stall the process for minutes.
    await sleep(Math.min(wait, 20000));
    return request(path, { method, query, body, headers, timeoutMs, retries: retries - 1 });
  }

  if (!response.ok) {
    const message = payload?.message || `Houdini returned ${response.status}`;
    throw new HoudiniError(message, {
      // 5xx upstream becomes 502 here; 4xx is usually the caller's fault and passes through.
      status: response.status >= 500 ? 502 : response.status,
      code: response.status === 429 ? "rate_limited" : payload?.code || "houdini_error",
      requestId: payload?.requestId,
      retryAfterMs:
        response.status === 429
          ? retryDelayFrom(payload?.message, response.headers.get("retry-after"))
          : undefined,
    });
  }

  return payload;
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

const searchTokens = (params, req) =>
  request("/tokens", { query: params, headers: req ? complianceHeaders(req) : {} });

const getQuotes = (params, req) =>
  request("/quotes", { query: params, headers: complianceHeaders(req) });

const createExchange = (body, req) =>
  request("/exchanges", { method: "POST", body, headers: complianceHeaders(req) });

const getOrder = (houdiniId, req) =>
  request(`/orders/${encodeURIComponent(houdiniId)}`, { headers: complianceHeaders(req) });

const getMinMax = (params, req) =>
  request("/minmax", { query: params, headers: complianceHeaders(req) });

/* Partner stats — account-scoped, never exposed to the browser. */
const getVolumeStats = () => request("/stats/volume");
const getWeeklyVolumeStats = () => request("/stats/weeklyVolume");
const getChartStats = (params) => request("/stats/chart", { query: params });

module.exports = {
  HoudiniError,
  credentialsPresent,
  complianceHeaders,
  searchTokens,
  getQuotes,
  createExchange,
  getOrder,
  getMinMax,
  getVolumeStats,
  getWeeklyVolumeStats,
  getChartStats,
};
