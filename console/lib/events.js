'use strict';
// lib/events.js — append-only event log + SSE fanout via Postgres LISTEN/NOTIFY.
// emit() writes one row to console.events and NOTIFYs channel 'run_events' with
// the new row id; sseHandler() replays rows since Last-Event-ID then streams new
// ones as they arrive. LISTEN/NOTIFY gives cross-pod fanout for free (DESIGN §3).
// Events are already secret-redacted by the caller (worker redacts at boundary).

const db = require('./db');

const CHANNEL = 'run_events';

// A dedicated long-lived client for LISTEN; SSE subscribers register callbacks
// keyed by runId. Lazily established so a unit `require` never opens a socket.
let listenClient = null;
let listening = false;
const subscribers = new Map(); // runId -> Set<fn(row)>

async function ensureListener() {
  if (listening) return;
  listening = true;
  try {
    listenClient = await db.pool.connect();
    await listenClient.query(`LISTEN ${CHANNEL}`);
    listenClient.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      let row;
      try { row = JSON.parse(msg.payload); } catch (_) { return; }
      const subs = subscribers.get(Number(row.run_id));
      if (subs) for (const fn of subs) { try { fn(row); } catch (_) { /* isolate */ } }
    });
    listenClient.on('error', () => { listening = false; });
  } catch (_) {
    listening = false;
  }
}

// emit(runId, {level,phaseIdx,stepId,type,message}) — insert + NOTIFY.
// runId may be null for platform-level events (provisioning/billing) that are not
// tied to a run; those are inserted only when a run exists (FK), else logged.
async function emit(runId, evt = {}) {
  const { level = 'info', phaseIdx = null, stepId = null, type = 'log', message = '' } = evt;
  if (runId == null) {
    // No run to attach to (FK NOT NULL). Surface to stdout for platform audit.
    console.log(`[event:${type}:${level}] ${String(message).slice(0, 500)}`);
    return;
  }
  const row = await db.q.get(
    `INSERT INTO console.events (run_id, level, phase_idx, step_id, type, message)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, run_id, ts, level, phase_idx, step_id, type, message`,
    [runId, level, phaseIdx, stepId, type, message],
  );
  // NOTIFY payload is capped at 8000 bytes; send a compact row (truncate message).
  const payload = JSON.stringify({
    id: row.id, run_id: row.run_id, ts: row.ts, level: row.level,
    phase_idx: row.phase_idx, step_id: row.step_id, type: row.type,
    message: String(row.message || '').slice(0, 6000),
  });
  try {
    await db.q.run(`SELECT pg_notify($1, $2)`, [CHANNEL, payload]);
  } catch (_) { /* NOTIFY best-effort; row is already durable */ }
  return;
}

function sseWrite(res, row) {
  res.write(`id: ${row.id}\n`);
  res.write(`event: ${row.type || 'log'}\n`);
  res.write(`data: ${JSON.stringify(row)}\n\n`);
}

// sseHandler(req, res) — GET /api/runs/:id/events. Replays since Last-Event-ID
// (or ?since=) then streams live rows for this run via the LISTEN subscription.
async function sseHandler(req, res) {
  const runId = Number(req.params.id);
  if (!Number.isInteger(runId)) {
    return res.status(400).json({ ok: false, error: 'invalid run id' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const lastId = Number(req.headers['last-event-id'] || req.query.since || 0) || 0;

  // Replay backlog.
  try {
    const backlog = await db.q.all(
      `SELECT id, run_id, ts, level, phase_idx, step_id, type, message
         FROM console.events
        WHERE run_id=$1 AND id > $2
        ORDER BY id ASC LIMIT 5000`, [runId, lastId]);
    for (const row of backlog) sseWrite(res, row);
  } catch (_) { /* stream continues even if replay fails */ }

  // Live subscription.
  await ensureListener();
  const cb = (row) => { try { sseWrite(res, row); } catch (_) { /* client gone */ } };
  let set = subscribers.get(runId);
  if (!set) { set = new Set(); subscribers.set(runId, set); }
  set.add(cb);

  const keepAlive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (_) { /* closed */ }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    const s = subscribers.get(runId);
    if (s) { s.delete(cb); if (!s.size) subscribers.delete(runId); }
  });
}

module.exports = { emit, sseHandler, CHANNEL };