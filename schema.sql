-- NAK payment service — Postgres schema
--
-- Applied automatically on boot by db.js. Safe to re-run: every statement
-- is IF NOT EXISTS.
--
-- What lives here and why: this database holds the things a replicated
-- canister must not. Shipping details are already vetKeys-encrypted before
-- they reach the canister, so they never come here at all — what lands here
-- is order status cache, artist submissions, and email suppression.

CREATE TABLE IF NOT EXISTS orders (
  reference          TEXT PRIMARY KEY,
  status             TEXT NOT NULL DEFAULT 'pending',
  session_id         TEXT,
  payment_reference  TEXT,
  amount_total       BIGINT,
  currency           TEXT DEFAULT 'usd',
  customer_email     TEXT,
  customer_name      TEXT,
  shipping_address   JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
CREATE INDEX IF NOT EXISTS orders_email_idx  ON orders (customer_email);

-- Stripe retries webhooks. Recording processed event ids makes replay a
-- no-op instead of a double-apply.
CREATE TABLE IF NOT EXISTS processed_events (
  event_id     TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS submissions (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  discipline  TEXT NOT NULL,
  link        TEXT NOT NULL,
  message     TEXT,
  consent     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS submissions_created_idx ON submissions (created_at DESC);

-- Marketing consent, recorded with a timestamp. The timestamp is the point:
-- anyone can claim a customer opted in, recording when makes it defensible.
CREATE TABLE IF NOT EXISTS marketing_consent (
  email       TEXT PRIMARY KEY,
  consented   BOOLEAN NOT NULL DEFAULT false,
  source      TEXT,
  consent_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Suppression wins over consent. An address here is never sent marketing
-- email even if a later order re-opts them in.
CREATE TABLE IF NOT EXISTS suppressions (
  email          TEXT PRIMARY KEY,
  suppressed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unsubscribe tokens: 256 bits from crypto.randomBytes, single-use.
CREATE TABLE IF NOT EXISTS unsubscribe_tokens (
  token       TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS unsub_email_idx ON unsubscribe_tokens (email);
