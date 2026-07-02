'use strict';
// lib/dispatch.js — console side of the worker channel (mTLS in prod).
// The console never runs engine commands; it records JOB intents that the worker
// claims by long-poll (nextJob), ingests redacted EVENT lines back (ingestEvent),
// enrolls a worker against a one-time token (enrollWorker), and takes heartbeats.
// Secret refs, not values: JOBs carry cred_ref handles only — no secret is stored
// or logged here.
//
// Contract (pinned):
//   enrollWorker(token)                              -> { workerId, ... }
//   heartbeat(workerId, body)                        -> void
//   dispatchStep(run, phaseIdx, step, cluster, secretRefs) -> void
//   ingestEvent(workerId, evt)                       -> void
//   nextJob(workerId)                                -> job | null

const db = require('./db');
const events = require('./events');
const provision = require('./provision');

// enrollWorker(token): validate a one-time enroll token (matched by hash), bind
// the worker (status provisioning -> ready), return its id. Token is consumed
// (enroll_token_hash cleared) so it cannot be replayed.
async function enrollWorker(token) {
  if (!token || typeof token !== 'string') throw new Error('enroll token required');
  const hash = provision.hashEnrollToken(token);
  const worker = await db.q.get(
    `SELECT id, status FROM console.workers WHERE enroll_token_hash=$1`, [hash]);
  if (!worker) throw new Error('invalid or already-used enroll token');
  await db.q.run(
    `UPDATE console.workers
        SET status='ready', enroll_token_hash=NULL, enrolled_at=now(), last_seen_at=now()
      WHERE id=$1`, [worker.id]);
  return { workerId: worker.id, status: 'ready' };
}

// heartbeat(workerId, body): liveness + reachability. body may carry
// {vpn_verified, idrac_reach[]}. Never throws on a missing worker (a stale agent
// must not 500 the console) — it just no-ops.
async function heartbeat(workerId, body = {}) {
  const id = Number(workerId);
  if (!Number.isInteger(id)) return;
  const vpn = body && typeof body.vpn_verified === 'boolean' ? body.vpn_verified : null;
  if (vpn === null) {
    await db.q.run(`UPDATE console.workers SET last_seen_at=now() WHERE id=$1`, [id]);
  } else {
    await db.q.run(
      `UPDATE console.workers SET last_seen_at=now(), vpn_verified=$2 WHERE id=$1`,
      [id, vpn]);
  }
}

// dispatchStep(run, phaseIdx, step, cluster, secretRefs): record a JOB the worker
// will claim. Config env is non-secret; secretRefs are handles only. Idempotent
// per (run,step): a re-dispatch of the same step replaces a still-queued job.
async function dispatchStep(run, phaseIdx, step, cluster, secretRefs) {
  if (!run || !run.id) throw new Error('dispatchStep: run with id required');
  const refs = Array.isArray(secretRefs) ? secretRefs.filter(Boolean) : [];
  const payload = {
    runId: run.id,
    workerId: run.worker_id || null,
    phaseIdx: phaseIdx == null ? null : Number(phaseIdx),
    stepId: step && step.id != null ? step.id : null,
    stepIdx: step ? step.idx : null,
    stepName: step ? step.name : null,
    stageCmd: step ? step.stage_cmd : null,
    heal: !!(step && step.heal),
    maxAttempts: (step && step.max_attempts) || 1,
    timeoutS: (step && step.timeout_s) || 1800,
    clusterConfig: (cluster && cluster.config_json) || null, // non-secret config
    secretRefs: refs,                                        // handles only
  };
  await db.q.run(
    `INSERT INTO console.worker_jobs (run_id, worker_id, step_id, payload_json, status)
     VALUES ($1,$2,$3,$4::jsonb,'queued')`,
    [run.id, payload.workerId, payload.stepId, JSON.stringify(payload)],
  );
}

// nextJob(workerId): the worker's long-poll claim. Atomically claim the oldest
// queued job for this worker (SKIP LOCKED avoids two pollers grabbing one job).
async function nextJob(workerId) {
  const id = Number(workerId);
  if (!Number.isInteger(id)) return null;
  return db.q.tx(async (c) => {
    const job = await c.get(
      `SELECT id, payload_json FROM console.worker_jobs
        WHERE worker_id=$1 AND status='queued'
        ORDER BY id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1`, [id]);
    if (!job) return null;
    await c.run(
      `UPDATE console.worker_jobs SET status='claimed', claimed_at=now() WHERE id=$1`,
      [job.id]);
    await c.run(`UPDATE console.workers SET last_seen_at=now() WHERE id=$1`, [id]);
    const payload = typeof job.payload_json === 'string'
      ? JSON.parse(job.payload_json) : job.payload_json;
    return { jobId: job.id, ...payload };
  });
}

// ingestEvent(workerId, evt): a worker -> console log/state line, already redacted
// by the worker. Persist via events.emit (which also NOTIFYs SSE) and fold RESULT
// lines (exitCode) back into step/run state minimally (P1: mark step succeeded/
// failed; the runner drives further advance()).
async function ingestEvent(workerId, evt = {}) {
  const id = Number(workerId);
  if (!Number.isInteger(id)) throw new Error('invalid worker id');
  const runId = Number(evt.runId);
  if (!Number.isInteger(runId)) throw new Error('runId required');
  await db.q.run(`UPDATE console.workers SET last_seen_at=now() WHERE id=$1`, [id]);

  const type = evt.type || 'log';
  await events.emit(runId, {
    level: evt.level || 'info',
    phaseIdx: evt.phaseIdx == null ? null : Number(evt.phaseIdx),
    stepId: evt.stepId == null ? null : Number(evt.stepId),
    type: type === 'result' ? 'state' : type,
    message: String(evt.message || '').slice(0, 8000),
  });

  // RESULT: fold exit code into step state (errorVerbatim is secret-scrubbed by worker).
  if (type === 'result' && evt.stepId != null) {
    const ok = Number(evt.exitCode) === 0;
    await db.q.run(
      `UPDATE console.steps
          SET status=$2, exit_code=$3, error_excerpt=$4, finished_at=now()
        WHERE id=$1`,
      [Number(evt.stepId), ok ? 'succeeded' : 'failed',
       Number.isFinite(Number(evt.exitCode)) ? Number(evt.exitCode) : null,
       ok ? null : String(evt.errorExcerpt || '').slice(0, 2000)]);
  }
}

module.exports = {
  enrollWorker,
  heartbeat,
  dispatchStep,
  ingestEvent,
  nextJob,
};