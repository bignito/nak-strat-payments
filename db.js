/**
 * Postgres access for the NAK payment service.
 *
 * Railway injects DATABASE_URL pointing at the private-network address of
 * the nak-strat-db service, so this never crosses the public internet.
 */

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL — add the Postgres service reference in Railway.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Railway's private network is already isolated; its Postgres image does
  // not present a publicly-trusted cert, so verification is relaxed here
  // rather than disabling TLS entirely.
  ssl: DATABASE_URL.includes('railway.internal') ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error:', err.message);
});

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[db] schema applied');
}

const query = (text, params) => pool.query(text, params);

module.exports = { pool, query, migrate };
