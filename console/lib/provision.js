'use strict';
// lib/provision.js — worker devstation lifecycle (DB + enrollment-token; cloud VM STUBBED).
// On a paid order we: (1) create a pending run row per cluster ordered, (2) create a
// workers row in status 'provisioning', (3) mint a one-time enroll token (only its hash
// is stored), (4) ask the cloud provider to spin the golden-image VM (STUB behind PROVIDER).
// The worker-agent later calls enrollWorker(token) in lib/dispatch to bind an mTLS fp.

const crypto = require('node:crypto');
const db = require('./db');
const events = require('./events');

// ---- enroll-token helpers --------------------------------------------------
// Token is a high-entropy secret handed to the worker at boot; we persist only a
// SHA-256 hash so a DB read can never reproduce the token (mirrors password rules).
function mintEnrollToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = hashEnrollToken(token);
  return { token, hash };
}
function hashEnrollToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

// ---- provider seam (STUB) --------------------------------------------------
// The real call spins a Windows golden-image VM (default provider) or targets an
// on-prem Hyper-V host. We do NOT bake any provider SDK in P1 — this returns a
// synthetic provider_ref so the DB + token lifecycle is fully exercised.
function provider() {
  return (process.env.PROVIDER || 'stub').toLowerCase();
}

async function providerCreateVm({ workerId, orderId, enrollToken }) {
  const kind = provider();
  // TODO(P4): implement the real worker create per PROVIDER. DEFAULT is on-prem (owner policy:
  // local-first, NOT public cloud):
  //   - 'hyperv'   : (DEFAULT) New-VM on our on-prem Hyper-V host from the golden VHDX — ephemeral,
  //                  torn down at hand-off. Near-zero marginal cost.
  //   - 'azure-vm' : EXCEPTION only when no on-prem capacity is free — az vm create from the golden
  //                  image; more expensive, metered.
  // The VM boots the worker-agent, which POSTs the enrollToken to /workers/enroll.
  if (kind === 'stub') {
    return { provider_ref: `stub-vm-${workerId}`, note: 'provider=stub (no VM created)' };
  }
  // Unknown provider configured but not yet implemented -> fail closed, do not
  // pretend a VM exists. The order stays paid; ops can retry after configuring.
  throw new Error(`PROVIDER='${kind}' not implemented (P1 stub); set PROVIDER=stub for dev`);
}

async function providerDestroyVm(providerRef) {
  const kind = provider();
  // TODO(P4): real teardown (az vm delete / Remove-VM) keyed by providerRef.
  if (kind === 'stub' || !providerRef) return { destroyed: true, note: 'stub teardown' };
  throw new Error(`PROVIDER='${kind}' destroy not implemented (P1 stub)`);
}

// ---- core lifecycle --------------------------------------------------------
// provisionWorker(order) — create the workers row (status 'provisioning') + enroll
// token, then attempt the provider VM create. Returns { workerId, enrollToken, provider_ref }.
// enrollToken is returned ONCE (for the caller to inject into the VM) and never re-derivable.
async function provisionWorker(order) {
  if (!order || !order.id) throw new Error('provisionWorker: order with id required');
  const { token, hash } = mintEnrollToken();

  const worker = await db.q.get(
    `INSERT INTO console.workers (order_id, status, enroll_token_hash, vpn_verified)
     VALUES ($1,'provisioning',$2,false) RETURNING id`,
    [order.id, hash]
  );
  const workerId = worker.id;

  let providerRef = null;
  try {
    const vm = await providerCreateVm({ workerId, orderId: order.id, enrollToken: token });
    providerRef = vm.provider_ref;
    await db.q.run('UPDATE console.workers SET provider_ref=$1 WHERE id=$2', [
      providerRef,
      workerId,
    ]);
    await events.emit(null, {
      level: 'info',
      type: 'provision',
      message: `worker ${workerId} provisioning (order ${order.id}, ref ${providerRef})`,
    });
  } catch (err) {
    // VM create failed: keep the workers row for audit but mark it gone so it is
    // never enrolled. Surface the failure to the caller.
    await db.q.run("UPDATE console.workers SET status='gone' WHERE id=$1", [workerId]);
    await events.emit(null, {
      level: 'error',
      type: 'provision',
      message: `worker ${workerId} vm-create failed: ${err.message}`,
    });
    throw err;
  }

  return { workerId, enrollToken: token, provider_ref: providerRef };
}

// provisionForOrder(orderId) — the billing entrypoint. Creates one pending run per
// cluster ordered and one worker (one worker per run — see DESIGN §1). Clusters may
// not yet be configured at pay time; runs bind a cluster later, so runs here are
// created cluster_id=NULL 'pending' placeholders the operator attaches config to.
async function provisionForOrder(orderId) {
  const order = await db.q.get(
    'SELECT id, customer_id, clusters_qty FROM console.orders WHERE id=$1',
    [orderId]
  );
  if (!order) throw new Error(`order ${orderId} not found`);

  const created = [];
  const qty = Math.max(1, order.clusters_qty || 1);
  for (let i = 0; i < qty; i += 1) {
    const w = await provisionWorker(order);
    const run = await db.q.get(
      `INSERT INTO console.runs
         (cluster_id, worker_id, status, gates_json, current_phase, created_by)
       VALUES (NULL,$1,'pending',$2,0,$3) RETURNING id`,
      [w.workerId, JSON.stringify({ after_phase: [], before_destructive: true }), `order:${order.id}`]
    );
    created.push({ runId: run.id, workerId: w.workerId, provider_ref: w.provider_ref });
    // NOTE: w.enrollToken is intentionally NOT returned here — it is injected into
    // the VM by providerCreateVm and never re-exposed via any API surface.
  }
  return { ok: true, orderId, workers: created.length, runs: created };
}

// destroyWorker(workerId) — tear the VM down at hand-off and mark the row gone.
// Refuses while the worker's run is still 'running' (worker outlives its run only
// until the run leaves running — DB-DATA §integrity).
async function destroyWorker(workerId) {
  const w = await db.q.get('SELECT id, provider_ref, status FROM console.workers WHERE id=$1', [
    workerId,
  ]);
  if (!w) throw new Error(`worker ${workerId} not found`);
  const live = await db.q.get(
    "SELECT id FROM console.runs WHERE worker_id=$1 AND status='running' LIMIT 1",
    [workerId]
  );
  if (live) throw new Error(`worker ${workerId} has a running run (${live.id}); halt it first`);

  await db.q.run("UPDATE console.workers SET status='draining' WHERE id=$1", [workerId]);
  await providerDestroyVm(w.provider_ref);
  await db.q.run("UPDATE console.workers SET status='gone', enroll_token_hash=NULL WHERE id=$1", [
    workerId,
  ]);
  await events.emit(null, {
    level: 'info',
    type: 'provision',
    message: `worker ${workerId} destroyed (ref ${w.provider_ref || 'n/a'})`,
  });
  return { ok: true, workerId, status: 'gone' };
}

module.exports = {
  provisionWorker,
  provisionForOrder,
  destroyWorker,
  hashEnrollToken, // used by dispatch.enrollWorker to match a presented token
  mintEnrollToken,
};