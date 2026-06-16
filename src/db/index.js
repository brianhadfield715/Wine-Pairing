// src/db/index.js
// Thin Postgres wrapper. Reads DATABASE_URL from env.
// Exposes:
//   - pool      : the raw pg.Pool (may be null if DATABASE_URL is absent)
//   - query()   : parameterized query helper
//   - isEnabled : boolean indicating DB availability
//   - withClient(fn) : transactional/connection-bound helper
//
// IMPORTANT: This module never throws at require time if DATABASE_URL is missing.
// That keeps the existing /recommend route working in environments where the
// analytics DB has not yet been provisioned.

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';
let pool = null;

if (connectionString) {
  // On Render the managed Postgres requires SSL. Allow opting out for local dev
  // via PGSSL=disable.
  const wantsSsl = process.env.PGSSL !== 'disable';
  pool = new Pool({
    connectionString,
    ssl: wantsSsl ? { rejectUnauthorized: false } : false,
    max: parseInt(process.env.PGPOOL_MAX || '5', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on('error', (err) => {
    // Don't crash the server on transient pool errors; just log.
    console.error('[db] idle client error:', err.message);
  });
}

function isEnabled() {
  return Boolean(pool);
}

async function query(text, params) {
  if (!pool) {
    const err = new Error('DATABASE_URL is not configured');
    err.code = 'DB_DISABLED';
    throw err;
  }
  return pool.query(text, params);
}

async function withClient(fn) {
  if (!pool) {
    const err = new Error('DATABASE_URL is not configured');
    err.code = 'DB_DISABLED';
    throw err;
  }
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function ping() {
  if (!pool) return { ok: false, reason: 'DATABASE_URL not set' };
  try {
    const r = await pool.query('select 1 as ok');
    return { ok: r.rows[0].ok === 1 };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

module.exports = { pool, query, withClient, isEnabled, ping };
