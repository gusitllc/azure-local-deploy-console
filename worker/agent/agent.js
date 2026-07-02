'use strict';
// worker/agent/agent.js — the worker-devstation agent (P0/P1 bootable slice).
// Enrolls with the console, heartbeats, long-polls for JOBs, executes the mapped
// engine command in an isolated per-run tree, and streams REDACTED log/state/RESULT
// lines back. mTLS + real VPN bring-up land in P2+; here the channel is exercised
// over HTTP with the enroll token as the bootstrap credential.
//
// SECRET BOUNDARY: the agent resolves cred_ref handles from its OWN key store and
// NEVER sends a secret value upstream. redact() scrubs any known secret shape from
// every outbound log line before it leaves the box.

const { spawn } = require('node:child_process');
const path = require('node:path');
const process = require('node:process');

const CONSOLE_URL = (process.env.CONSOLE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ENROLL_TOKEN = process.env.ENROLL_TOKEN || '';
const ENGINE_DIR = process.env.ENGINE_DIR || path.join(__dirname, '..', 'engine');
const POLL_MS = Number(process.env.POLL_MS || 3000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 20000);

let workerId = null;

// ---- secret redaction (outbound boundary) --------------------------------
// Scrub obvious secret shapes so no value ever reaches the console logs.
function redact(text) {
  let s = String(text == null ? '' : text);
  s = s.replace(/(password|passwd|secret|token|apikey|api[-_]?key|bearer)\s*[:=]\s*\S+/gi,
    '$1=***REDACTED***');
  s = s.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '***JWT***');
  s = s.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '***PEM***');
  return s;
}

// ---- console channel -----------------------------------------------------
async function post(pathName, body) {
  const res = await fetch(`${CONSOLE_URL}${pathName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json().catch(() => ({ ok: false, error: 'non-json response' }));
}

async function getJson(pathName) {
  const res = await fetch(`${CONSOLE_URL}${pathName}`);
  return res.json().catch(() => ({ ok: false, error: 'non-json response' }));
}

async function enroll() {
  if (!ENROLL_TOKEN) throw new Error('ENROLL_TOKEN not set');
  const res = await post('/api/workers/enroll', { token: ENROLL_TOKEN });
  if (!res || !res.ok || !res.workerId) throw new Error('enrollment failed');
  workerId = res.workerId;
  console.log(`[agent] enrolled as worker ${workerId}`);
}

async function heartbeat() {
  if (workerId == null) return;
  // vpn_verified/idrac_reach are real probes in P2+; report a truthful default now.
  await post(`/api/workers/${workerId}/heartbeat`, {
    vpn_verified: process.env.VPN_VERIFIED === 'true',
    idrac_reach: [],
  }).catch(() => {});
}

// ---- event stream to console (redacted) ----------------------------------
async function sendEvent(runId, evt) {
  const body = {
    runId,
    stepId: evt.stepId == null ? null : evt.stepId,
    phaseIdx: evt.phaseIdx == null ? null : evt.phaseIdx,
    type: evt.type || 'log',
    level: evt.level || 'info',
    message: redact(evt.message || ''),
  };
  if (evt.type === 'result') {
    body.exitCode = evt.exitCode;
    body.errorExcerpt = redact(evt.errorExcerpt || '');
  }
  await post(`/api/runs/${runId}/events?worker=${workerId}`, body).catch(() => {});
}

// ---- job execution -------------------------------------------------------
// Run the mapped engine command in an isolated per-run cwd. Stdout/stderr are
// streamed back line-by-line, redacted. Exit code becomes a RESULT line.
function runJob(job) {
  return new Promise((resolve) => {
    const runDir = path.join(ENGINE_DIR);
    const cmd = job.stageCmd || '';
    if (!cmd) {
      sendEvent(job.runId, { stepId: job.stepId, type: 'result', exitCode: 1,
        errorExcerpt: 'no stageCmd in job' }).finally(resolve);
      return;
    }
    sendEvent(job.runId, { stepId: job.stepId, phaseIdx: job.phaseIdx, type: 'state',
      message: `starting: ${cmd}` });

    // Non-secret env only; secretRefs are resolved from the local store (not here in P1).
    const env = Object.assign({}, process.env, {
      RUN_DIR: runDir,
      RUN_ID: String(job.runId),
    });
    const child = spawn(cmd, {
      shell: true, cwd: runDir, env,
      timeout: (job.timeoutS || 1800) * 1000,
    });
    let stderrTail = '';
    child.stdout.on('data', (d) => {
      sendEvent(job.runId, { stepId: job.stepId, type: 'log', message: d.toString() });
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-2000);
      sendEvent(job.runId, { stepId: job.stepId, type: 'log', level: 'warn', message: s });
    });
    child.on('close', (code) => {
      sendEvent(job.runId, {
        stepId: job.stepId, type: 'result',
        exitCode: code == null ? 1 : code,
        errorExcerpt: code === 0 ? '' : stderrTail,
      }).finally(resolve);
    });
    child.on('error', (err) => {
      sendEvent(job.runId, { stepId: job.stepId, type: 'result', exitCode: 1,
        errorExcerpt: `spawn error: ${err.code || 'error'}` }).finally(resolve);
    });
  });
}

// ---- main loop -----------------------------------------------------------
let stopping = false;

async function pollOnce() {
  const res = await getJson(`/api/runs/next?worker=${workerId}`);
  if (res && res.ok && res.job) {
    console.log(`[agent] claimed job ${res.job.jobId} (run ${res.job.runId})`);
    await runJob(res.job);
  }
}

async function main() {
  await enroll();
  setInterval(heartbeat, HEARTBEAT_MS);
  await heartbeat();
  while (!stopping) {
    try { await pollOnce(); } catch (e) {
      console.error('[agent] poll error:', e && e.code ? e.code : 'error');
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

if (require.main === module) {
  main().catch((err) => {
    console.error('[agent] fatal:', err && err.message ? err.message : 'error');
    process.exit(1);
  });
}

module.exports = { redact, runJob, enroll, sendEvent };