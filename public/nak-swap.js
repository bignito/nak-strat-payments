/* Swap page — browser logic. No credentials here; everything goes through the swap API. */

// Same-origin by default. When this page is served from naktoken.lol instead of
// the Railway service, the <meta> tag in the HTML points it at the Railway origin.
const API =
  document.querySelector('meta[name="nak-swap-api"]')?.content?.trim().replace(/\/$/, "") ||
  "/api/swap";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/* ?embed=1 strips the masthead, intro column and footer so the page drops
   straight into the dapp's Trade section, where that context already exists. */
if (new URLSearchParams(location.search).get("embed") === "1") {
  document.body.classList.add("is-embedded");
}

const $ = (id) => document.getElementById(id);

const el = {
  configError: $("config-error"),
  form: $("swap-form"),
  amount: $("amount"),
  limits: $("limits"),
  sourceButton: $("source-button"),
  sourceSymbol: $("source-symbol"),
  sourceChain: $("source-chain"),
  sourceMenu: $("source-menu"),
  sourceSearch: $("source-search"),
  sourceList: $("source-list"),
  destButton: $("dest-button"),
  destSymbol: $("dest-symbol"),
  destChain: $("dest-chain"),
  destMenu: $("dest-menu"),
  destSearch: $("dest-search"),
  destList: $("dest-list"),
  flip: $("flip"),
  receive: $("receive"),
  quoteNote: $("quote-note"),
  fixed: $("fixed"),
  fixedWrap: $("fixed-wrap"),
  addressTo: $("addressTo"),
  addressNote: $("address-note"),
  refundField: $("refund-field"),
  refundAddress: $("refundAddress"),
  formError: $("form-error"),
  submit: $("submit"),
  panelBuild: $("panel-build"),
  panelOrder: $("panel-order"),
  orderAmount: $("order-amount"),
  depositAddress: $("deposit-address"),
  copyAddress: $("copy-address"),
  depositTag: $("deposit-tag"),
  orderId: $("order-id"),
  orderOut: $("order-out"),
  orderReceiver: $("order-receiver"),
  orderExpiry: $("order-expiry"),
  routeFact: $("route-fact"),
  orderRoute: $("order-route"),
  rail: $("rail"),
  orderStatus: $("order-status"),
  orderError: $("order-error"),
  nextStep: $("next-step"),
  startOver: $("start-over"),
};

const state = {
  featured: [],
  source: null,
  dest: null,
  nextStep: null,
  quote: null,
  order: null,
  quoteSeq: 0,
  pollTimer: null,
  countdownTimer: null,
  catalog: null,
  catalogLoading: null,
};

/**
 * The full token list, fetched once and filtered locally.
 *
 * Searching server-side on every keystroke would spend the same rate-limit
 * budget the quotes need. Falls back to live search if the catalog is down.
 */
async function getCatalog() {
  if (state.catalog) return state.catalog;
  if (!state.catalogLoading) {
    state.catalogLoading = api("/catalog")
      .then(({ tokens }) => (state.catalog = tokens))
      .catch(() => null);
  }
  return state.catalogLoading;
}

/** Rank matches so an exact ticker beats a substring buried in a name. */
function filterTokens(tokens, term) {
  const q = term.trim().toLowerCase();
  if (!q) return tokens.slice(0, 50);

  const scored = [];
  for (const t of tokens) {
    const symbol = t.symbol.toLowerCase();
    const name = (t.name || "").toLowerCase();
    const chain = (t.chain || "").toLowerCase();

    let score = -1;
    if (symbol === q) score = 0;
    else if (symbol.startsWith(q)) score = 1;
    else if (name.startsWith(q)) score = 2;
    else if (symbol.includes(q)) score = 3;
    else if (name.includes(q)) score = 4;
    else if (chain.includes(q)) score = 5;
    if (score >= 0) scored.push([score, t]);
  }

  return scored
    .sort((a, b) => a[0] - b[0] || a[1].symbol.localeCompare(b[1].symbol))
    .slice(0, 60)
    .map(([, t]) => t);
}

/* ---------------- helpers ---------------- */

async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "x-user-timezone": TZ,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || "Something went wrong. Try again.");
    error.payload = data;
    error.status = res.status;
    throw error;
  }
  return data;
}

function amountFormat(value, max = 8) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  const digits = n >= 1000 ? 2 : n >= 1 ? 4 : max;
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function show(node, message, tone = "error") {
  node.textContent = message;
  node.hidden = !message;
  if (node.dataset) node.dataset.tone = message ? tone : "";
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const selectedType = () => el.form.querySelector('input[name="type"]:checked').value;

/* ---------------- boot ---------------- */

async function boot() {
  try {
    const config = await api("/config");
    state.featured = config.featured;

    const bySymbol = (symbol) => config.featured.find((t) => t.symbol === symbol);
    state.source = bySymbol(config.defaultFrom) || config.featured[0] || null;
    state.dest =
      bySymbol(config.defaultTo) ||
      config.featured.find((t) => t.id !== state.source?.id) ||
      null;

    if (config.defaultType === "standard") {
      el.form.querySelector('input[value="standard"]').checked = true;
    }
    if (!config.supportsFixed) el.fixedWrap.hidden = true;
    state.nextStep = config.nextStep || null;
    if (state.nextStep) {
      el.nextStep.textContent = state.nextStep.label;
      el.nextStep.href = state.nextStep.url;
    }

    renderTokens();
    el.amount.focus();
  } catch (err) {
    show(el.configError, err.message || "Swap is unavailable right now.");
    el.submit.disabled = true;
    el.amount.disabled = true;
  }
}

/* ---------------- token pickers ---------------- */

function renderTokens() {
  if (state.dest) el.addressTo.placeholder = `Your ${state.dest.symbol} address`;
  if (state.source) {
    el.sourceSymbol.textContent = state.source.symbol;
    el.sourceChain.textContent = state.source.chain || "";
  }
  if (state.dest) {
    el.destSymbol.textContent = state.dest.symbol;
    el.destChain.textContent = state.dest.chain || "";
  }
}

/** One picker implementation, bound to whichever side it controls. */
function makePicker(side) {
  const button = side === "source" ? el.sourceButton : el.destButton;
  const menu = side === "source" ? el.sourceMenu : el.destMenu;
  const search = side === "source" ? el.sourceSearch : el.destSearch;
  const list = side === "source" ? el.sourceList : el.destList;

  function renderList(tokens) {
    list.innerHTML = "";
    const other = side === "source" ? state.dest : state.source;
    const options = tokens.filter((t) => t.id !== other?.id);

    if (!options.length) {
      const empty = document.createElement("li");
      empty.className = "menu__empty";
      empty.textContent = "No coins match that search.";
      list.append(empty);
      return;
    }

    for (const token of options) {
      const li = document.createElement("li");
      const item = document.createElement("button");
      item.type = "button";
      item.className = "menu__item";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(token.id === state[side]?.id));

      const symbol = document.createElement("b");
      symbol.textContent = token.symbol;
      const meta = document.createElement("span");
      meta.textContent = token.chain ? `${token.name} · ${token.chain}` : token.name;
      item.append(symbol, meta);

      item.addEventListener("click", () => {
        state[side] = token;
        renderTokens();
        close();
        loadLimits();
        requestQuote();
        if (side === "dest") updateSubmit();
      });
      li.append(item);
      list.append(li);
    }
  }

  async function open() {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    search.value = "";
    renderList(state.featured);
    search.focus();

    // Load the full list in the background; featured tokens are usable meanwhile.
    const catalog = await getCatalog();
    if (catalog && !menu.hidden && !search.value.trim()) {
      search.placeholder = `Search ${catalog.length.toLocaleString()} coins`;
    }
  }

  function close() {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }

  button.addEventListener("click", () => (menu.hidden ? open() : close()));

  document.addEventListener("click", (event) => {
    if (menu.hidden) return;
    if (!menu.contains(event.target) && !button.contains(event.target)) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      close();
      button.focus();
    }
  });

  search.addEventListener(
    "input",
    debounce(async () => {
      const term = search.value.trim();
      if (!term) return renderList(state.featured);

      const catalog = await getCatalog();
      if (catalog) return renderList(filterTokens(catalog, term));

      // Catalog unavailable — fall back to server-side search.
      if (term.length < 2) return renderList(state.featured);
      try {
        const { tokens } = await api(`/tokens?term=${encodeURIComponent(term)}`);
        renderList(tokens);
      } catch {
        renderList([]);
      }
    }, 200)
  );

  return { close };
}

makePicker("source");
makePicker("dest");

el.flip.addEventListener("click", () => {
  const { source, dest } = state;
  state.source = dest;
  state.dest = source;
  renderTokens();
  loadLimits();
  requestQuote();
});

/* ---------------- limits ---------------- */

async function loadLimits() {
  el.limits.textContent = "";
  if (!state.source || !state.dest) return;
  try {
    const limits = await api(`/limits?from=${state.source.id}&to=${state.dest.id}`);
    const min = limits.min ?? limits.cex?.min ?? limits.minAmount;
    const max = limits.max ?? limits.cex?.max ?? limits.maxAmount;
    if (min || max) {
      const parts = [];
      if (min) parts.push(`at least ${amountFormat(min)}`);
      if (max) parts.push(`at most ${amountFormat(max)}`);
      el.limits.textContent = `Send ${parts.join(", ")} ${state.source.symbol}.`;
    }
  } catch {
    /* limits are a nicety; a failure here shouldn't block the swap */
  }
}

/* ---------------- quote ---------------- */

const requestQuote = debounce(async () => {
  const amount = Number(el.amount.value.replace(/,/g, ""));
  state.quote = null;
  updateSubmit();

  if (!state.source || !state.dest) return;

  if (!el.amount.value.trim()) {
    el.receive.textContent = "—";
    el.quoteNote.hidden = false;
    el.quoteNote.dataset.tone = "";
    el.quoteNote.textContent = "Enter an amount to see a rate.";
    return;
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    el.receive.textContent = "—";
    show(el.quoteNote, "Enter a number greater than zero.");
    return;
  }

  const seq = ++state.quoteSeq;
  el.receive.textContent = "…";
  el.quoteNote.hidden = false;
  el.quoteNote.dataset.tone = "";
  el.quoteNote.textContent = "Finding the best route…";

  const params = new URLSearchParams({
    amount: String(amount),
    from: state.source.id,
    to: state.dest.id,
    type: selectedType(),
  });
  if (el.fixed.checked) params.set("fixed", "true");

  try {
    const { quote } = await api(`/quote?${params}`);
    if (seq !== state.quoteSeq) return; // a newer keystroke already won
    state.quote = quote;
    el.receive.textContent = amountFormat(quote.amountOut, 4);

    const bits = [];
    if (quote.route) bits.push(`via ${quote.route}`);
    if (quote.durationMinutes) bits.push(`about ${Math.round(quote.durationMinutes)} min`);
    if (quote.amountOutUsd) bits.push(`≈ $${amountFormat(quote.amountOutUsd, 2)}`);
    bits.push(quote.fixed ? "rate locked" : "rate can move");
    el.quoteNote.dataset.tone = "";
    el.quoteNote.textContent = bits.join(" · ");
  } catch (err) {
    if (seq !== state.quoteSeq) return;
    el.receive.textContent = "—";
    let message = err.message;
    const { min, max } = err.payload || {};
    if (min || max) {
      const range = [min && `min ${amountFormat(min)}`, max && `max ${amountFormat(max)}`]
        .filter(Boolean)
        .join(", ");
      message += ` Try ${range} ${state.source.symbol}.`;
    }
    show(el.quoteNote, message);
  } finally {
    updateSubmit();
  }
}, 400);

/* ---------------- form ---------------- */

/**
 * Houdini publishes a per-chain address regex. ICP in particular accepts two
 * formats that look nothing alike — a 64-character account identifier and a
 * principal — and sending to the wrong one is unrecoverable, so this is checked
 * before an order can be created rather than after.
 */
function addressProblem() {
  const value = el.addressTo.value.trim();
  if (!value) return null; // empty is "not ready", not "wrong"

  const pattern = state.dest?.addressPattern;
  if (!pattern) return null;

  let re;
  try {
    re = new RegExp(pattern);
  } catch {
    return null; // an unparseable pattern must not block a valid swap
  }

  return re.test(value)
    ? null
    : `That doesn't look like a ${state.dest.symbol} address on ${state.dest.chain}.`;
}

function updateSubmit() {
  const problem = addressProblem();
  const note = el.addressNote;

  if (problem) {
    note.textContent = problem;
    note.dataset.tone = "error";
  } else {
    note.textContent = "Check it twice. Sent funds can't be recalled.";
    note.dataset.tone = "";
  }

  const ready =
    Boolean(state.quote) &&
    el.addressTo.value.trim().length > 0 &&
    !problem &&
    (!needsRefund() || el.refundAddress.value.trim().length > 0);
  el.submit.disabled = !ready;
}

const needsRefund = () => Boolean(el.fixed.checked || state.quote?.requiresRefundAddress);

function syncRefundField() {
  el.refundField.hidden = !needsRefund();
  updateSubmit();
}

el.amount.addEventListener("input", () => {
  el.amount.value = el.amount.value.replace(/[^\d.,]/g, "");
  requestQuote();
});

el.addressTo.addEventListener("input", updateSubmit);
el.refundAddress.addEventListener("input", updateSubmit);

el.form.querySelectorAll('input[name="type"]').forEach((input) =>
  input.addEventListener("change", requestQuote)
);

el.fixed.addEventListener("change", () => {
  syncRefundField();
  requestQuote();
});

el.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.quote) return;

  el.submit.disabled = true;
  el.submit.textContent = "Creating your order…";
  show(el.formError, "");

  try {
    const order = await api("/order", {
      method: "POST",
      body: JSON.stringify({
        quoteId: state.quote.quoteId,
        addressTo: el.addressTo.value.trim(),
        ...(needsRefund() ? { refundAddress: el.refundAddress.value.trim() } : {}),
      }),
    });
    openOrder(order);
  } catch (err) {
    show(el.formError, err.message);
    el.submit.disabled = false;
  } finally {
    el.submit.textContent = "Get deposit address";
  }
});

/* ---------------- order ---------------- */

function openOrder(order) {
  state.order = order;
  el.panelBuild.hidden = true;
  el.panelOrder.hidden = false;
  window.scrollTo({ top: 0, behavior: "smooth" });

  el.orderAmount.textContent = `${amountFormat(order.inAmount)} ${order.inSymbol}`;
  el.depositAddress.textContent = order.depositAddress;
  el.orderId.textContent = order.houdiniId;
  el.orderOut.textContent = `${amountFormat(order.outAmount, 4)} ${order.outSymbol}`;
  el.orderReceiver.textContent = order.receiverAddress;

  if (order.depositTag) {
    el.depositTag.hidden = false;
    el.depositTag.textContent = `Include this memo or tag with your deposit: ${order.depositTag}. Without it the deposit won't be credited.`;
  }
  if (order.route) {
    el.routeFact.hidden = false;
    el.orderRoute.textContent = order.route;
  }

  // The anonymizing step only exists on a private route.
  el.rail.querySelector('[data-step="ANONYMIZING"]').hidden = !order.anonymous;

  renderProgress(order);
  startCountdown(order.expires);
  startPolling(order.houdiniId);
}

const RAIL_ORDER = ["WAITING", "CONFIRMING", "EXCHANGING", "ANONYMIZING", "FINISHED"];

const STATUS_COPY = {
  INITIALIZING: "Setting up your route.",
  NEW: "Waiting for your deposit.",
  WAITING: "Waiting for your deposit.",
  CONFIRMING: "Deposit spotted. Waiting for confirmations.",
  EXCHANGING: "Exchanging now.",
  ANONYMIZING: "Routing through the privacy leg.",
  FINISHED: "Done. Funds have been sent.",
  EXPIRED: "The deposit window closed before funds arrived. Start a new swap.",
  FAILED: "This swap failed. Contact support with the order number above.",
  REFUNDED: "This swap was refunded to your refund address.",
  DELETED: "This order is no longer available.",
};

function renderProgress(order) {
  const label = order.statusLabel;
  const terminalBad = ["EXPIRED", "FAILED", "REFUNDED", "DELETED"].includes(label);
  const index = RAIL_ORDER.indexOf(label === "NEW" || label === "INITIALIZING" ? "WAITING" : label);

  RAIL_ORDER.forEach((step, i) => {
    const node = el.rail.querySelector(`[data-step="${step}"]`);
    if (!node || node.hidden) return;
    if (terminalBad) node.dataset.state = i === 0 ? "failed" : "";
    else if (label === "FINISHED") node.dataset.state = "complete";
    else if (i < index) node.dataset.state = "done";
    else if (i === index) node.dataset.state = "current";
    else node.dataset.state = "";
  });

  const copy =
    label === "FINISHED"
      ? `Done. Your ${order.outSymbol} has been sent.`
      : STATUS_COPY[label] || `Status: ${label}`;
  el.orderStatus.textContent = copy;
  if (terminalBad) show(el.orderError, STATUS_COPY[label] || `Status: ${label}`);
  el.nextStep.hidden = !(label === "FINISHED" && state.nextStep);
}

function startCountdown(expires) {
  clearInterval(state.countdownTimer);
  const deadline = new Date(expires).getTime();

  const tick = () => {
    const left = deadline - Date.now();
    if (left <= 0) {
      el.orderExpiry.textContent = "Closed";
      clearInterval(state.countdownTimer);
      return;
    }
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    el.orderExpiry.textContent = `${mins}:${String(secs).padStart(2, "0")} left to send`;
  };

  tick();
  state.countdownTimer = setInterval(tick, 1000);
}

function startPolling(houdiniId) {
  clearInterval(state.pollTimer);
  const poll = async () => {
    try {
      const order = await api(`/order/${encodeURIComponent(houdiniId)}`);
      state.order = order;
      renderProgress(order);
      if (["FINISHED", "EXPIRED", "FAILED", "REFUNDED", "DELETED"].includes(order.statusLabel)) {
        clearInterval(state.pollTimer);
        clearInterval(state.countdownTimer);
        if (order.statusLabel === "FINISHED") el.orderExpiry.textContent = "Complete";
      }
    } catch {
      /* a dropped poll is not worth surfacing; the next one will land */
    }
  };
  state.pollTimer = setInterval(poll, 20000);
}

el.copyAddress.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.order.depositAddress);
    el.copyAddress.textContent = "Copied";
    setTimeout(() => (el.copyAddress.textContent = "Copy"), 1600);
  } catch {
    el.copyAddress.textContent = "Select it manually";
  }
});

el.startOver.addEventListener("click", () => {
  clearInterval(state.pollTimer);
  clearInterval(state.countdownTimer);
  state.order = null;
  state.quote = null;
  el.form.reset();
  el.receive.textContent = "—";
  el.quoteNote.textContent = "Enter an amount to see a rate.";
  el.quoteNote.dataset.tone = "";
  show(el.formError, "");
  show(el.orderError, "");
  syncRefundField();
  updateSubmit();
  el.nextStep.hidden = true;
  el.panelOrder.hidden = true;
  el.panelBuild.hidden = false;
  el.amount.focus();
});

syncRefundField();
boot().then(loadLimits);
