'use strict';

/**
 * routes/runs.js — the run state-machine REST + SSE surface.
 * Mounted at /api by server.js. All responses {ok:true,...}|{ok:false,error}.
 *
 * Caps (blueprint 08): runs:read (list/detail/events/log), runs:write (create/
 * retry), runs:approve (approve/reject/halt).
 */

const express = require('express');
const db = require('../lib/db');
const respond = require('../lib/respond');
const auth = require('../lib/auth');
const events = require('../lib/events');
const runner = require('../lib/runner');

const router = express.Router();

// resolve the acting operator (session) or the admin-key principal, for audit.
function actorOf(req) {
  return (req.operator && (req.operator.username || req.operator.id)) ||
    (req.adminKey ? 'admin-key' : 'unknown');
}

// POST /runs — create a run (locks servers, builds phases+steps).
router.post('/runs', auth.requireCapability('deploy:runs:write'), async (req, res) => {
  try {
    const { cluster_id, server_ids, gates, phase_from, phase_to } = req.body || {};
    if (!cluster_id) return respond.fail(res, 'cluster_id required');
    if (!Array.isArray(server_ids) || !server_ids.length) {
      return respond.fail(res, 'server_ids must be a non-empty array');
    }
    const run = await runner.createRun({
      cluster_id, server_ids, gates,
      phase_from, phase_to, created_by: actorOf(req),
    });
    return respond.ok(res, { run });
  } catch (e) {
    // server-lock contention and validation are client errors (409/400).
    const locked = /locked by another run/i.test(e.message);
    return respond.fail(res, e.message, locked ? 409 : 400);
  }
});

// GET /runs — list (newest first, no secrets).
router.get('/runs', auth.requireCapability('deploy:runs:read'), async (req, res) => {
  try {
    const rows = await db.q.all(
      `SELECT id, cluster_id, worker_id, status, phase_from, phase_to, current_phase,
              halt_requested, created_by, started_at, finished_at
         FROM console.runs
        ORDER BY id DESC
        LIMIT 200`);
    return respond.ok(res, { runs: rows });
  } catch (e) {
    return respond.fail(res, e.message, 500);
  }
});

// GET /runs/:id — detail as a phases+steps tree (single-query, no N+1).
router.get('/runs/:id', auth.requireCapability('deploy:runs:read'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return respond.fail(res, 'invalid run id');
    const run = await db.q.get(
      `SELECT id, cluster_id, worker_id, status, gates_json, phase_from, phase_to,
              current_phase, halt_requested, error_verbatim, created_by,
              started_at, finished_at
         FROM console.runs WHERE id=$1`, [id]);
    if (!run) return respond.fail(res, 'run not found', 404);

    const rows = await db.q.all(
      `SELECT p.idx AS phase_idx, p.name AS phase_name, p.status AS phase_status,
              p.started_at AS phase_started_at, p.finished_at AS phase_finished_at,
              s.id AS step_id, s.idx AS step_idx, s.name AS step_name,
              s.stage_cmd, s.status AS step_status, s.exit_code, s.attempt,
              s.max_attempts, s.timeout_s, s.error_excerpt
         FROM console.phases p
         LEFT JOIN console.steps s ON s.phase_id = p.id
        WHERE p.run_id=$1
        ORDER BY p.idx, s.idx`, [id]);

    const phases = [];
    const byIdx = new Map();
    for (const r of rows) {
      let ph = byIdx.get(r.phase_idx);
      if (!ph) {
        ph = {
          idx: r.phase_idx, name: r.phase_name, status: r.phase_status,
          started_at: r.phase_started_at, finished_at: r.phase_finished_at, steps: [],
        };
        byIdx.set(r.phase_idx, ph);
        phases.push(ph);
      }
      if (r.step_id != null) {
        ph.steps.push({
          id: r.step_id, idx: r.step_idx, name: r.step_name, stage_cmd: r.stage_cmd,
          status: r.step_status, exit_code: r.exit_code, attempt: r.attempt,
          max_attempts: r.max_attempts, timeout_s: r.timeout_s, error_excerpt: r.error_excerpt,
        });
      }
    }
    return respond.ok(res, { run, phases });
  } catch (e) {
    return respond.fail(res, e.message, 500);
  }
});

// GET /runs/:id/events — SSE (events.sseHandler owns headers + LISTEN/replay).
router.get('/runs/:id/events', auth.requireCapability('deploy:runs:read'), (req, res) => {
  return events.sseHandler(req, res);
});

// GET /runs/:id/steps/:sid/log — full log (range-capable via ?from&?to on id).
router.get('/runs/:id/steps/:sid/log',
  auth.requireCapability('deploy:runs:read'), async (req, res) => {
    try {
      const runId = Number(req.params.id);
      const stepId = Number(req.params.sid);
      if (!Number.isInteger(runId) || !Number.isInteger(stepId)) {
        return respond.fail(res, 'invalid id');
      }
      // confirm the step belongs to this run (isolation).
      const owns = await db.q.get(
        `SELECT s.id FROM console.steps s
           JOIN console.phases p ON p.id=s.phase_id
          WHERE s.id=$1 AND p.run_id=$2`, [stepId, runId]);
      if (!owns) return respond.fail(res, 'step not found for this run', 404);

      const fromId = Number(req.query.from) || 0;
      const limit = Math.min(Number(req.query.limit) || 1000, 5000);
      const lines = await db.q.all(
        `SELECT id, ts, level, message FROM console.events
          WHERE run_id=$1 AND step_id=$2 AND type='log' AND id > $3
          ORDER BY id ASC LIMIT $4`, [runId, stepId, fromId, limit]);
      return respond.ok(res, { runId, stepId, lines });
    } catch (e) {
      return respond.fail(res, e.message, 500);
    }
  });

// POST /runs/:id/approve — release a gate.
router.post('/runs/:id/approve', auth.requireCapability('deploy:runs:approve'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    await runner.approve(id, actorOf(req), (req.body && req.body.note) || null);
    return respond.ok(res, { runId: id, action: 'approved' });
  } catch (e) {
    return respond.fail(res, e.message, /not awaiting|not found/i.test(e.message) ? 409 : 400);
  }
});

// POST /runs/:id/reject — deny a gate (run fails, held for inspection).
router.post('/runs/:id/reject', auth.requireCapability('deploy:runs:approve'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    await runner.reject(id, actorOf(req), (req.body && req.body.note) || null);
    return respond.ok(res, { runId: id, action: 'rejected' });
  } catch (e) {
    return respond.fail(res, e.message, /not awaiting|not found/i.test(e.message) ? 409 : 400);
  }
});

// POST /runs/:id/halt — kill current step, hold the run.
router.post('/runs/:id/halt', auth.requireCapability('deploy:runs:approve'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    await runner.halt(id, actorOf(req));
    return respond.ok(res, { runId: id, action: 'halted' });
  } catch (e) {
    return respond.fail(res, e.message, /not found/i.test(e.message) ? 404 : 400);
  }
});

// POST /runs/:id/retry — resume at the failed step.
router.post('/runs/:id/retry', auth.requireCapability('deploy:runs:write'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    await runner.retry(id);
    return respond.ok(res, { runId: id, action: 'retried' });
  } catch (e) {
    return respond.fail(res, e.message, /only a failed|not found/i.test(e.message) ? 409 : 400);
  }
});

module.exports = router;