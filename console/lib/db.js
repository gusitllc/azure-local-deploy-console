'use strict';
// lib/db.js — pg-backed facade for schema `console`. The ONLY DB entrypoint;
// every module accesses Postgres through q.{get,all,run,tx} so access is
// uniform, parameterized ($1..), and transaction-capable. LISTEN/NOTIFY-friendly
// (a shared pool) so events.js can fan SSE out across pods. No secret is logged.
//
// Contract (pinned):
//   pool                                   — pg.Pool
//   q.get(sql, params=[])  -> row | null
//   q.all(sql, params=[])  -> rows[]
//   q.run(sql, params=[])  -> { rowCount, rows }
//   q.tx(fn)               -> fn(client)   (client has .get/.all/.run)
//   migrate()              -> applies console/migrations/*.sql in order
//   setting(key, dflt)     -> value
//   setSetting(key, value) -> void

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
const ssl = /sslmode=require/i.test(connectionString || '') ||
  process.env.PGSSL === 'require'
  ? { rejectUnauthorized: false }
  : undefined;

const pool = new Pool({
  connectionString,
  ...(ssl ? { ssl } : {}),
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_MS || 30000),
});

// Never let a stray pool error crash the process; log without any secret.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err && err.code ? err.code : 'unknown');
});

// ---- query helpers -------------------------------------------------------
function makeQ(runner) {
  return {
    get: async (sql, params = []) => {
      const r = await runner.query(sql, params);
      return r.rows[0] || null;
    },
    all: async (sql, params = []) => {
      const r = await runner.query(sql, params);
      return r.rows;
    },
    run: async (sql, params = []) => {
      const r = await runner.query(sql, params);
      return { rowCount: r.rowCount, rows: r.rows };
    },
  };
}

const q = {
  ...makeQ(pool),
  // tx(fn): run fn(client) inside BEGIN/COMMIT; ROLLBACK on throw. client
  // exposes the same get/all/run shape as q so callers are transaction-agnostic.
  tx: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = makeQ(client);
      const result = await fn(scoped);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* already dead */ }
      throw err;
    } finally {
      client.release();
    }
  },
};

// ---- migrations ----------------------------------------------------------
// Apply every console/migrations/*.sql in filename order, once, recorded in
// console.schema_migrations. Each file runs in its own transaction.
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function ensureMigrationsTable() {
  await q.run(`CREATE SCHEMA IF NOT EXISTS console`);
  await q.run(
    `CREATE TABLE IF NOT EXISTS console.schema_migrations (
       version    TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

async function migrate() {
  await ensureMigrationsTable();
  let files = [];
  try {
    files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (_) {
    console.warn('[db] no migrations directory; skipping migrate()');
    return;
  }
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const done = await q.get(
      `SELECT version FROM console.schema_migrations WHERE version=$1`, [version]);
    if (done) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await q.tx(async (c) => {
      await c.run(sql);
      await c.run(
        `INSERT INTO console.schema_migrations (version) VALUES ($1)`, [version]);
    });
    console.log(`[db] applied migration ${version}`);
  }
}

// ---- settings ------------------------------------------------------------
async function setting(key, dflt = null) {
  const row = await q.get(`SELECT value FROM console.settings WHERE key=$1`, [key]);
  if (!row) return dflt;
  return row.value;
}

async function setSetting(key, value) {
  await q.run(
    `INSERT INTO console.settings (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [key, JSON.stringify(value)],
  );
}

module.exports = { pool, q, migrate, setting, setSetting };
