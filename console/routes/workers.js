'use strict';
// routes/workers.js — the console ⇄ worker-agent channel (mTLS in prod; the
// enroll token is the bootstrap secret). Mounted at /api by server.js:
//   POST /api/workers/enroll          {token}                 (allowlisted — token IS the auth)
//   POST /api/workers/:id/heartbeat   {vpn_verified,idrac_reach[]}
//   GET  /api/runs/next?worker=<id>   long-poll job claim
//   POST /api/runs/:id/events         redacted EVENT/RESULT ingest from the worker
// All responses {ok:true,...}|{ok:false,error}. No secret value is accepted or logged.

const express = require('express');
const { ok, fail } = require('../lib/respond');
const dispatch = require('../lib/dispatch');
const runner = require('../lib/runner');

const router = express.Router();

// POST /workers/enroll — one-time token -> worker id. Allowlisted: the token is
// the credential. A bad/used token is a generic 401 (no enumeration).
router.post('/workers/enroll', async (req, res) => {
  const token = req.body && req.body.token;
  if (typeof token !== 'string' || !token) return fail(res, 'token required', 400);
  try {
    const result = await dispatch.enrollWorker(token);
    return ok(res, result);
  } catch (_) {
    return fail(res, 'enrollment rejected', 401);
  }
});

// POST /workers/:id/heartbeat — liveness + reachability.
router.post('/workers/:id/heartbeat', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return fail(res, 'invalid worker id', 400);
  try {
    await dispatch.heartbeat(id, req.body || {});
    return ok(res, { workerId: id });
  } catch (e) {
    return fail(res, e.message, 500);
  }
});

// GET /runs/next?worker=<id> — worker long-poll claim (single-shot; the agent
// re-polls). Returns {ok:true, job:null} when the queue is empty.
router.get('/runs/next', async (req, res) => {
  const id = Number(req.query.worker);
  if (!Number.isInteger(id)) return fail(res, 'worker query param required', 400);
  try {
    const job = await dispatch.nextJob(id);
    return ok(res, { job: job || null });
  } catch (e) {
    return fail(res, e.message, 500);
  }
});

// POST /runs/:id/events — redacted EVENT/RESULT ingest. The worker must name
// itself via ?worker=<id>; the runId in the path is echoed into the event body.
router.post('/runs/:id/events', async (req, res) => {
  const runId = Number(req.params.id);
  const workerId = Number(req.query.worker);
  if (!Number.isInteger(runId)) return fail(res, 'invalid run id', 400);
  if (!Number.isInteger(workerId)) return fail(res, 'worker query param required', 400);
  try {
    const evt = { ...(req.body || {}), runId };
    await dispatch.ingestEvent(workerId, evt);
    // On a RESULT line, nudge the state machine forward (idempotent).
    if ((req.body && req.body.type) === 'result') {
      await runner.advance(runId).catch(() => {});
    }
    return ok(res, { runId });
  } catch (e) {
    return fail(res, e.message, 400);
  }
});

module.exports = router;