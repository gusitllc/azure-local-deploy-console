'use strict';
// lib/heal.js — heal-hook registry. A heal is a targeted recovery action the worker
// runs against the engine when a stage dead-ends in a known, recoverable way
// (DESIGN §6 / CLI-API POST /api/runs/:id/heal/:hook). Each hook resolves to the exact
// engine command the worker should execute; run(runId, hook) dispatches it to the run's
// worker as a synthetic step and records an audit event. The console never runs the
// command itself — it only tells the worker what to run (secret-free, non-destructive).

const db = require('./db');
const events = require('./events');

// ---- registry --------------------------------------------------------------
// Each entry: cmd = engine-relative command the worker spawns in engine/;
// describes what version drift / stuck state it repairs. Add-only; keep idempotent.
const HOOKS = Object.freeze({
  // Azure Edge extension version drift (Validate fails "ext version mismatch").
  'ext-sync': {
    cmd: 'lib/ext-version-sync.sh',
    label: 'Sync AzureEdge extension versions to the RP-expected baseline',
    destructive: false,
  },
  // Disk-erase stuck / partitions re-appear before wipe — clear the sticky state.
  'erase-unstick': {
    cmd: 'stages/17-wipe-disks.sh --unstick',
    label: 'Clear stuck disk-erase state so the wipe stage can proceed',
    destructive: false, // the unstick itself is safe; the actual wipe stays gated
  },
  // Azure CLI token expired mid-run — re-login the per-run az context.
  'az-relogin': {
    cmd: 'lib/az-relogin.sh',
    label: 'Re-authenticate the per-run az CLI context (token refresh)',
    destructive: false,
  },
});

function extSync() {
  return { hook: 'ext-sync', ...HOOKS['ext-sync'] };
}
function eraseUnstick() {
  return { hook: 'erase-unstick', ...HOOKS['erase-unstick'] };
}
function azRelogin() {
  return { hook: 'az-relogin', ...HOOKS['az-relogin'] };
}

function resolve(hook) {
  const key = String(hook || '').trim();
  // accept both 'ext-sync' and 'ext_sync' spellings
  const norm = key.replace(/_/g, '-');
  return HOOKS[norm] ? { hook: norm, ...HOOKS[norm] } : null;
}

// ---- run(runId, hook) ------------------------------------------------------
// Dispatch a heal to the run's worker (lazy-require dispatch to avoid a cycle:
// dispatch -> runner -> heal in some builds). Records an audit event either way.
async function run(runId, hook) {
  const spec = resolve(hook);
  if (!spec) throw new Error(`unknown heal hook '${hook}'`);

  const runRow = await db.q.get(
    'SELECT id, worker_id, cluster_id, status, current_phase FROM console.runs WHERE id=$1',
    [runId]
  );
  if (!runRow) throw new Error(`run ${runId} not found`);
  if (!runRow.worker_id) throw new Error(`run ${runId} has no worker to heal on`);

  await events.emit(runId, {
    level: 'warn',
    type: 'heal',
    phaseIdx: runRow.current_phase || null,
    message: `heal '${spec.hook}' requested: ${spec.label} (cmd ${spec.cmd})`,
  });

  // Send the heal as a job to the worker. dispatch.dispatchStep is the channel;
  // we frame the heal as a synthetic step so the worker's job loop handles it uniformly.
  const dispatch = require('./dispatch');
  const syntheticStep = {
    id: null,
    idx: 0,
    name: `heal:${spec.hook}`,
    stage_cmd: spec.cmd,
    heal: true,
    max_attempts: 1,
    timeout_s: 900,
  };
  await dispatch.dispatchStep(
    runRow,
    runRow.current_phase || null,
    syntheticStep,
    null, // cluster config resolved worker-side; heals need no cluster mutation
    [] // no secret refs for a heal
  );

  return { ok: true, runId, hook: spec.hook, cmd: spec.cmd };
}

module.exports = {
  HOOKS,
  extSync,
  eraseUnstick,
  azRelogin,
  resolve,
  run,
};