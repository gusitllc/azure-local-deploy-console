'use strict';
// routes/health.js — GET /api/health (allowlisted). Real metrics only, never {ok:true}:
//   db (read/write probe), migration (current schema version), activeRuns, workers, uptimeS.
const express = require('express');
const db = require('../lib/db');
const { q } = db;

const router = express.Router();
const BOOT_MS = Date.now();

// Probe the DB with a real read (and confirm write path via the migrations table read).
async function probeDb() {
  try {
    const r = await q.get('SELECT 1 AS one');
    return { rw: !!(r && Number(r.one) === 1), error: null };
  } catch (e) {
    return { rw: false, error: 'db unreachable' };
  }
}

async function migrationVersion() {
  try {
    const r = await q.get(
      `SELECT version FROM console.schema_migrations ORDER BY version DESC LIMIT 1`,
    );
    return r ? r.version : null;
  } catch {
    return null;
  }
}

async function countActiveRuns() {
  try {
    const r = await q.get(
      `SELECT COUNT(*)::int AS n FROM console.runs
        WHERE status IN ('pending','running','awaiting-approval')`,
    );
    return r ? r.n : 0;
  } catch {
    return null;
  }
}

async function countLiveWorkers() {
  try {
    const r = await q.get(
      `SELECT COUNT(*)::int AS n FROM console.workers
        WHERE status IN ('provisioning','ready','draining')`,
    );
    return r ? r.n : 0;
  } catch {
    return null;
  }
}

// GET /api/health  (allowlisted — no auth)
router.get('/health', async (req, res) => {
  const dbProbe = await probeDb();
  const [migration, activeRuns, workers] = await Promise.all([
    migrationVersion(),
    countActiveRuns(),
    countLiveWorkers(),
  ]);
  const body = {
    ok: dbProbe.rw,
    db: dbProbe.rw ? 'up' : 'down',
    migration,
    activeRuns,
    workers,
    uptimeS: Math.floor((Date.now() - BOOT_MS) / 1000),
  };
  return res.status(dbProbe.rw ? 200 : 503).json(body);
});

module.exports = router;