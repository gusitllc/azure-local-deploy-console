'use strict';

/**
 * runner.js — run/phase/step state machine (console side).
 *
 * Scope (P1): create a run (locks servers in one tx, inserts run + phases +
 * Phase-1 steps from the DESIGN §6 phase->stage matrix), and drive the
 * DESIGN §4 state machine: advance / approve / halt / retry.
 *
 * States (run/phase/step): pending | running | awaiting-approval | failed |
 * succeeded | skipped.
 *
 * Depends only on lib/db.js (q.tx / q.get / q.all / q.run) and lib/events.js.
 * Secret-free: this module never touches a credential value.
 */

const db = require('./db');
const events = require('./events');

// DESIGN §6 phase -> stage matrix. Phase 1 is authored in full here; phases
// 2..5 are named shells (steps materialised when their dispatch lands, P2+).
// `destructive` marks a step that must sit behind a before-destructive gate.
const PHASE_CATALOG = {
  1: {
    name: 'iDRAC Prep',
    steps: [
      { name: 'reach+inventory', stage_cmd: 'lib/redfish.sh rf_reachable rf_sysinfo rf_health rf_serial rf_bios rf_storage_count', timeout_s: 900, max_attempts: 3 },
      { name: 'fw compare', stage_cmd: 'lib/fw-compare.js && lib/fw-plan.js', timeout_s: 600, max_attempts: 2 },
      { name: 'fw apply', stage_cmd: 'stages/15-firmware-baseline.sh', timeout_s: 5400, max_attempts: 2, destructive: true },
      { name: 'preflight', stage_cmd: 'stages/10-preflight.sh && lib/hw-validate.sh', timeout_s: 1200, max_attempts: 2 },
    ],
  },
  2: { name: 'Node Build', steps: [] },
  3: { name: 'Arc + Azure', steps: [] },
  4: { name: 'Validation', steps: [] },
  5: { name: 'Cluster + Monitor', steps: [] },
};

// Default gate policy: destructive actions gate ON; per-phase-boundary gates
// opt-in via gates.after_phase[]. Callers pass gates at run creation.
function normalizeGates(gates) {
  const g = gates && typeof gates === 'object' ? gates : {};
  return {
    before_destructive: g.before_destructive !== false, // default ON
    after_phase: Array.isArray(g.after_phase) ? g.after_phase.map(Number) : [],
  };
}

// steps for a phase idx, honouring destructive-gate policy (a destructive step
// begins its life needing approval, surfaced when the run reaches it).
function stepsForPhase(idx) {
  const spec = PHASE_CATALOG[idx];
  if (!spec) return { name: `phase-${idx}`, steps: [] };
  return spec;
}

/**
 * createRun — one transaction: lock every server, insert run + phases
 * (phase_from..phase_to) + Phase-1 steps, and the opening event. Aborts (throws)
 * if any requested server is already locked by another run.
 */
async function createRun({ cluster_id, server_ids, gates, phase_from, phase_to, created_by }) {
  const from = Number(phase_from) || 1;
  const to = Number(phase_to) || 5;
  if (from < 1 || to > 5 || from > to) throw new Error('invalid phase range');
  const servers = Array.isArray(server_ids) ? server_ids.map(Number).filter(Boolean) : [];
  if (!cluster_id) throw new Error('cluster_id required');
  if (!servers.length) throw new Error('at least one server required');
  const gatesJson = normalizeGates(gates);

  return db.q.tx(async (c) => {
    // Insert the run in pending; we backfill locks against its id.
    const run = (await c.run(
      `INSERT INTO console.runs
         (cluster_id, status, gates_json, phase_from, phase_to, current_phase,
          halt_requested, created_by, started_at)
       VALUES ($1,'pending',$2,$3,$4,$5,false,$6,now())
       RETURNING *`,
      [cluster_id, JSON.stringify(gatesJson), from, to, from, created_by || null]
    )).rows[0];

    // Lock every server atomically; only rows still free flip to this run.
    const locked = await c.run(
      `UPDATE console.servers SET locked_by_run_id=$1
         WHERE id = ANY($2::bigint[]) AND locked_by_run_id IS NULL AND cluster_id=$3`,
      [run.id, servers, cluster_id]
    );
    if (locked.rowCount !== servers.length) {
      // partial lock -> abort; tx rollback releases the ones we did grab.
      throw new Error('one or more servers are locked by another run or not in this cluster');
    }

    // Materialise phases from..to and steps for each populated phase (P1: phase 1).
    for (let idx = from; idx <= to; idx++) {
      const spec = stepsForPhase(idx);
      const phase = (await c.run(
        `INSERT INTO console.phases (run_id, idx, name, status)
         VALUES ($1,$2,$3,'pending') RETURNING id`,
        [run.id, idx, spec.name]
      )).rows[0];
      for (let s = 0; s < spec.steps.length; s++) {
        const st = spec.steps[s];
        await c.run(
          `INSERT INTO console.steps
             (phase_id, idx, name, stage_cmd, status, attempt, max_attempts, timeout_s)
           VALUES ($1,$2,$3,$4,'pending',0,$5,$6)`,
          [phase.id, s, st.name, st.stage_cmd, st.max_attempts || 1, st.timeout_s || 1800]
        );
      }
    }

    await events.emit(run.id, {
      level: 'info', phaseIdx: from, type: 'state',
      message: `run created: cluster ${cluster_id}, ${servers.length} server(s), phases ${from}-${to}`,
    });
    return run;
  });
}

// find the current step to work on: first non-terminal step in phase order.
async function currentStep(runId) {
  return db.q.get(
    `SELECT s.*, p.idx AS phase_idx, p.id AS phase_id
       FROM console.steps s
       JOIN console.phases p ON p.id = s.phase_id
      WHERE p.run_id = $1 AND s.status IN ('pending','running','failed')
      ORDER BY p.idx, s.idx
      LIMIT 1`,
    [runId]
  );
}

function stepIsDestructive(phaseIdx, stepName) {
  const spec = PHASE_CATALOG[phaseIdx];
  const s = spec && spec.steps.find((x) => x.name === stepName);
  return !!(s && s.destructive);
}

async function gatesJsonFor(runId) {
  const r = await db.q.get(`SELECT gates_json FROM console.runs WHERE id=$1`, [runId]);
  if (!r) return normalizeGates(null);
  const raw = typeof r.gates_json === 'string' ? JSON.parse(r.gates_json) : r.gates_json;
  return normalizeGates(raw);
}

/**
 * advance — move the run forward one increment. Marks the next pending step
 * running, unless a gate blocks it (before-destructive, or after-phase
 * boundary) in which case the run parks at awaiting-approval. When no steps
 * remain, the reached-phase_to run becomes succeeded.
 */
async function advance(runId) {
  const run = await db.q.get(`SELECT * FROM console.runs WHERE id=$1`, [runId]);
  if (!run) throw new Error('run not found');
  if (['succeeded', 'failed'].includes(run.status)) return;
  if (run.status === 'awaiting-approval') return; // held until approve/reject

  const step = await currentStep(runId);
  if (!step) {
    await db.q.run(
      `UPDATE console.runs SET status='succeeded', finished_at=now() WHERE id=$1`, [runId]);
    await events.emit(runId, { level: 'info', type: 'state', message: 'run succeeded', });
    return;
  }

  const gates = await gatesJsonFor(runId);
  const startingNewPhase = step.idx === 0;
  const priorPhaseGate = startingNewPhase && step.phase_idx > run.phase_from &&
    gates.after_phase.includes(step.phase_idx - 1);
  const destructiveGate = gates.before_destructive &&
    stepIsDestructive(step.phase_idx, step.name) && step.status === 'pending';

  if ((priorPhaseGate || destructiveGate) && step.status !== 'running') {
    await db.q.run(`UPDATE console.runs SET status='awaiting-approval', current_phase=$2 WHERE id=$1`,
      [runId, step.phase_idx]);
    await events.emit(runId, {
      level: 'warn', phaseIdx: step.phase_idx, stepId: step.id, type: 'gate',
      message: destructiveGate
        ? `gate: approval required before destructive step "${step.name}"`
        : `gate: approval required after phase ${step.phase_idx - 1}`,
    });
    return;
  }

  // clear to run this step.
  await db.q.tx(async (c) => {
    await c.run(`UPDATE console.runs SET status='running', current_phase=$2 WHERE id=$1`,
      [runId, step.phase_idx]);
    await c.run(`UPDATE console.phases SET status='running', started_at=COALESCE(started_at,now())
                 WHERE id=$1`, [step.phase_id]);
    await c.run(`UPDATE console.steps SET status='running', attempt=attempt+1 WHERE id=$1`, [step.id]);
  });
  await events.emit(runId, {
    level: 'info', phaseIdx: step.phase_idx, stepId: step.id, type: 'state',
    message: `step running: ${step.name}`,
  });
}

/**
 * approve — release a gate. Records the actor as an audit event, returns the
 * run to running, and advances into the pending step.
 */
async function approve(runId, actor, note) {
  const run = await db.q.get(`SELECT status FROM console.runs WHERE id=$1`, [runId]);
  if (!run) throw new Error('run not found');
  if (run.status !== 'awaiting-approval') throw new Error('run is not awaiting approval');
  await db.q.run(`UPDATE console.runs SET status='running' WHERE id=$1`, [runId]);
  await events.emit(runId, {
    level: 'warn', type: 'gate',
    message: `APPROVED by ${actor || 'unknown'}${note ? `: ${note}` : ''}`,
  });
  await advance(runId);
}

/**
 * reject — deny a gate: the run fails, servers stay locked for inspection
 * until an explicit halt/retry decision.
 */
async function reject(runId, actor, note) {
  const run = await db.q.get(`SELECT status FROM console.runs WHERE id=$1`, [runId]);
  if (!run) throw new Error('run not found');
  if (run.status !== 'awaiting-approval') throw new Error('run is not awaiting approval');
  await db.q.tx(async (c) => {
    await c.run(`UPDATE console.runs SET status='failed', finished_at=now() WHERE id=$1`, [runId]);
    await c.run(`UPDATE console.steps s SET status='failed'
                   FROM console.phases p
                  WHERE s.phase_id=p.id AND p.run_id=$1 AND s.status='running'`, [runId]);
  });
  await events.emit(runId, {
    level: 'error', type: 'gate',
    message: `REJECTED by ${actor || 'unknown'}${note ? `: ${note}` : ''}`,
  });
}

/**
 * halt — request the worker kill the current step process group and hold the
 * run. Sets halt_requested; the dispatch layer relays HALT to the worker. The
 * running step becomes failed(halted); the run becomes failed and holds.
 */
async function halt(runId, actor) {
  const run = await db.q.get(`SELECT status FROM console.runs WHERE id=$1`, [runId]);
  if (!run) throw new Error('run not found');
  if (['succeeded', 'failed'].includes(run.status)) return;
  await db.q.tx(async (c) => {
    await c.run(`UPDATE console.runs SET halt_requested=true, status='failed', finished_at=now()
                 WHERE id=$1`, [runId]);
    await c.run(`UPDATE console.steps s SET status='failed', error_excerpt='halted by operator'
                   FROM console.phases p
                  WHERE s.phase_id=p.id AND p.run_id=$1 AND s.status='running'`, [runId]);
  });
  await events.emit(runId, {
    level: 'error', type: 'state',
    message: `HALT requested by ${actor || 'unknown'} — worker will kill current step`,
  });
}

/**
 * retry — resume at the failed step: clear halt, reset the failed step to
 * pending (attempt preserved for backoff), clear run error, return to running.
 * All engine stages are idempotent, so a re-run is safe.
 */
async function retry(runId) {
  const run = await db.q.get(`SELECT status FROM console.runs WHERE id=$1`, [runId]);
  if (!run) throw new Error('run not found');
  if (run.status !== 'failed') throw new Error('only a failed run can be retried');
  await db.q.tx(async (c) => {
    await c.run(
      `UPDATE console.steps s SET status='pending', error_excerpt=NULL, exit_code=NULL
         FROM console.phases p
        WHERE s.phase_id=p.id AND p.run_id=$1 AND s.status='failed'`, [runId]);
    await c.run(`UPDATE console.runs SET status='running', halt_requested=false,
                   error_verbatim=NULL, finished_at=NULL WHERE id=$1`, [runId]);
  });
  await events.emit(runId, { level: 'info', type: 'state', message: 'retry: resuming at failed step' });
  await advance(runId);
}

module.exports = {
  createRun,
  advance,
  approve,
  reject,
  halt,
  retry,
  PHASE_CATALOG, // exported for routes/tests (read-only)
};