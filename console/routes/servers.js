'use strict';

/**
 * routes/servers.js — server registry + Phase-1 inventory fan-out.
 * Mounted at /api by server.js. {ok:true,...}|{ok:false,error} always.
 *
 * A server row carries iDRAC reach info + a cred_ref (a HANDLE into the
 * worker key store, never a password — enforced by never accepting a
 * password field here). Inventory kicks a Phase-1-only run whose worker
 * fan-out (rf_* stages) upserts model/serial/health.
 */

const express = require('express');
const db = require('../lib/db');
const respond = require('../lib/respond');
const auth = require('../lib/auth');
const runner = require('../lib/runner');

// dispatch.js is authored by a peer module; require defensively so servers.js
// still loads (and register/list still work) before the worker channel lands.
let dispatch = null;
try { dispatch = require('../lib/dispatch'); } catch (_) { dispatch = null; }

const router = express.Router();

const IP_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

function actorOf(req) {
  return (req.operator && (req.operator.username || req.operator.id)) ||
    (req.adminKey ? 'admin-key' : 'unknown');
}

// POST /servers — register one or many. Body: {cluster_id, servers:[{idrac_ip,
// idrac_user,cred_ref}]} (or a bare array for a single default cluster caller).
router.post('/servers', auth.requireCapability('deploy:servers:write'), async (req, res) => {
  try {
    const body = req.body || {};
    const cluster_id = body.cluster_id;
    const list = Array.isArray(body.servers) ? body.servers
      : (Array.isArray(body) ? body : null);
    if (!cluster_id) return respond.fail(res, 'cluster_id required');
    if (!list || !list.length) return respond.fail(res, 'servers must be a non-empty array');

    const created = [];
    for (const s of list) {
      const idrac_ip = String(s.idrac_ip || '').trim();
      const idrac_user = String(s.idrac_user || '').trim();
      const cred_ref = String(s.cred_ref || '').trim();
      // Refuse anything that looks like a raw secret — cred_ref is a handle only.
      if ('password' in s || 'idrac_password' in s) {
        return respond.fail(res, 'passwords are not accepted here — supply a cred_ref handle only', 400);
      }
      if (!IP_RE.test(idrac_ip)) return respond.fail(res, `invalid idrac_ip: ${idrac_ip}`);
      if (!idrac_user) return respond.fail(res, 'idrac_user required');
      if (!cred_ref) return respond.fail(res, 'cred_ref (worker key-store handle) required');

      // Idempotent register without assuming a (cluster_id,idrac_ip) unique
      // constraint: check-then-insert/update in one tx.
      const row = await db.q.tx(async (c) => {
        const existing = await c.get(
          `SELECT id FROM console.servers WHERE cluster_id=$1 AND idrac_ip=$2`,
          [cluster_id, idrac_ip]);
        const sel = `RETURNING id, cluster_id, idrac_ip, idrac_user, model, service_tag,
                     health, bios_ver, last_inventory_at, locked_by_run_id`;
        if (existing) {
          return (await c.run(
            `UPDATE console.servers SET idrac_user=$2, cred_ref=$3 WHERE id=$1 ${sel}`,
            [existing.id, idrac_user, cred_ref])).rows[0];
        }
        return (await c.run(
          `INSERT INTO console.servers (cluster_id, idrac_ip, idrac_user, cred_ref, health)
           VALUES ($1,$2,$3,$4,'unknown') ${sel}`,
          [cluster_id, idrac_ip, idrac_user, cred_ref])).rows[0];
      });
      created.push(row);
    }
    return respond.ok(res, { servers: created });
  } catch (e) {
    return respond.fail(res, e.message, 500);
  }
});

// GET /servers — list (never returns cred_ref or any secret; ?cluster_id filter).
router.get('/servers', auth.requireCapability('deploy:servers:read'), async (req, res) => {
  try {
    const cluster_id = req.query.cluster_id ? Number(req.query.cluster_id) : null;
    const rows = cluster_id
      ? await db.q.all(
          `SELECT id, cluster_id, idrac_ip, idrac_user, model, service_tag, health,
                  bios_ver, fw_json, last_inventory_at, locked_by_run_id
             FROM console.servers WHERE cluster_id=$1 ORDER BY id`, [cluster_id])
      : await db.q.all(
          `SELECT id, cluster_id, idrac_ip, idrac_user, model, service_tag, health,
                  bios_ver, fw_json, last_inventory_at, locked_by_run_id
             FROM console.servers ORDER BY id`);
    return respond.ok(res, { servers: rows });
  } catch (e) {
    return respond.fail(res, e.message, 500);
  }
});

// POST /servers/inventory — Phase-1 fan-out marker. Creates a Phase-1-only run
// over the given servers (locks them, materialises the reach+inventory step)
// and, if the worker channel is up, dispatches the inventory step. The worker's
// rf_* stages upsert model/serial/health back via the event ingest path.
router.post('/servers/inventory', auth.requireCapability('deploy:servers:write'), async (req, res) => {
  try {
    const body = req.body || {};
    const cluster_id = body.cluster_id;
    const server_ids = Array.isArray(body.server_ids) ? body.server_ids : null;
    if (!cluster_id) return respond.fail(res, 'cluster_id required');
    if (!server_ids || !server_ids.length) {
      return respond.fail(res, 'server_ids must be a non-empty array');
    }

    // A Phase-1-only run; gates.before_destructive stays ON but inventory is
    // non-destructive, so it dispatches straight away.
    const run = await runner.createRun({
      cluster_id, server_ids,
      gates: { before_destructive: true, after_phase: [] },
      phase_from: 1, phase_to: 1, created_by: actorOf(req),
    });

    // The first Phase-1 step is reach+inventory. advance() marks it running.
    await runner.advance(run.id);

    // Best-effort dispatch marker for the worker fan-out (P1: records intent).
    let dispatched = false;
    if (dispatch && typeof dispatch.dispatchStep === 'function') {
      const step = await db.q.get(
        `SELECT s.* FROM console.steps s
           JOIN console.phases p ON p.id=s.phase_id
          WHERE p.run_id=$1 AND p.idx=1 AND s.idx=0`, [run.id]);
      const cluster = await db.q.get(
        `SELECT id, name, config_json FROM console.clusters WHERE id=$1`, [cluster_id]);
      // secretRefs = each server's cred_ref handle (never a value).
      const refs = await db.q.all(
        `SELECT id, cred_ref FROM console.servers WHERE id = ANY($1::bigint[])`, [server_ids]);
      try {
        await dispatch.dispatchStep(run, 1, step, cluster, refs.map((r) => r.cred_ref));
        dispatched = true;
      } catch (_) { dispatched = false; }
    }

    return respond.ok(res, {
      run_id: run.id, phase: 1, step: 'reach+inventory',
      dispatched,
      note: dispatched ? 'inventory dispatched to worker'
        : 'inventory run created; worker channel not yet attached',
    });
  } catch (e) {
    const locked = /locked by another run/i.test(e.message);
    return respond.fail(res, e.message, locked ? 409 : 400);
  }
});

module.exports = router;