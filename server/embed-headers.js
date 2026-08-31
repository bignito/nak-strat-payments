/**
 * Framing policy for the swap page.
 *
 * The Houdini widget occupied an iframe in the Trade section. To replace it in
 * place rather than sending visitors to another tab, this page has to be
 * frameable — but only by naktoken.lol, or anyone could wrap it and pass off
 * our swap as theirs.
 *
 * `frame-ancestors` is the control that matters. X-Frame-Options is
 * deliberately NOT set: its ALLOW-FROM directive is dead in every current
 * browser, and setting DENY or SAMEORIGIN would block the embed outright.
 *
 * Apply to the static page only, never to the API.
 */

const ANCESTORS = (process.env.SWAP_FRAME_ANCESTORS || "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

function embedHeaders() {
  // No ancestors configured means the page is standalone: refuse all framing.
  const frameAncestors = ANCESTORS.length ? ANCESTORS.join(" ") : "'none'";

  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    // The API origin the page calls. Same-origin on Railway; widen only if the
    // page is ever served from somewhere else.
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");

  return (_req, res, next) => {
    res.set({
      "Content-Security-Policy": policy,
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
    next();
  };
}

module.exports = { embedHeaders };
