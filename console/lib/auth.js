'use strict';
// lib/auth.js — operators, scrypt passwords, server-side sessions, RBAC.
// Secret boundary: ADMIN_KEY (k8s Secret) bootstraps + rotates without redeploy;
// the x-admin-key header grants full capabilities. Passwords are scrypt-hashed;
// sessions are revocable rows with a short TTL. No secret is ever logged.
const crypto = require('node:crypto');
const { q } = require('./db');

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000); // 8h
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const SESSION_COOKIE = 'console_session';

// RBAC: role -> capabilities. admin is a wildcard ('*' => hasCap always true).
const ROLE_CAPS = {
  admin: ['*'],
  operator: [
    'deploy:runs:read', 'deploy:runs:write', 'deploy:runs:approve',
    'deploy:servers:write', 'deploy:clusters:write',
  ],
  viewer: ['deploy:runs:read'],
};

function capsForRole(role) {
  return ROLE_CAPS[role] ? ROLE_CAPS[role].slice() : [];
}

// ---- password hashing (scrypt) ----
function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const derived = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  let derived;
  try {
    derived = crypto.scryptSync(String(password), salt, expected.length);
  } catch { return false; }
  return derived.length === expected.length &&
    crypto.timingSafeEqual(derived, expected);
}

// ---- session token ----
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function readCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

function adminKeyOk(req) {
  const key = process.env.ADMIN_KEY;
  if (!key) return false;
  const provided = req.headers && req.headers['x-admin-key'];
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Resolve the operator behind the session cookie (null if none / expired).
async function operatorFromRequest(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const row = await q.get(
    `SELECT o.id, o.username, o.role, o.capabilities_json, o.disabled, s.expires_at
       FROM console.sessions s
       JOIN console.operators o ON o.id = s.operator_id
      WHERE s.token = $1`,
    [token],
  );
  if (!row || row.disabled) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await q.run(`DELETE FROM console.sessions WHERE token = $1`, [token]);
    return null;
  }
  const caps = Array.isArray(row.capabilities_json) && row.capabilities_json.length
    ? row.capabilities_json
    : capsForRole(row.role);
  return { id: row.id, username: row.username, role: row.role, capabilities: caps };
}

function hasCap(operator, cap) {
  if (!operator) return false;
  const caps = operator.capabilities || [];
  return caps.includes('*') || caps.includes(cap);
}

// ---- express middleware ----
// requireAuth: 401 unless a valid session OR a valid x-admin-key is present.
function requireAuth(req, res, next) {
  if (adminKeyOk(req)) {
    req.operator = { id: 0, username: 'admin-key', role: 'admin', capabilities: ['*'] };
    return next();
  }
  operatorFromRequest(req).then((op) => {
    if (!op) return res.status(401).json({ ok: false, error: 'unauthorized' });
    req.operator = op;
    next();
  }).catch((e) => res.status(500).json({ ok: false, error: 'auth failed' }));
}

// requireCapability: 403 unless the session operator has the cap OR admin key present.
function requireCapability(cap) {
  return function (req, res, next) {
    if (adminKeyOk(req)) {
      req.operator = req.operator ||
        { id: 0, username: 'admin-key', role: 'admin', capabilities: ['*'] };
      return next();
    }
    operatorFromRequest(req).then((op) => {
      if (!op) return res.status(401).json({ ok: false, error: 'unauthorized' });
      req.operator = op;
      if (!hasCap(op, cap)) {
        return res.status(403).json({ ok: false, error: 'forbidden: ' + cap });
      }
      next();
    }).catch(() => res.status(500).json({ ok: false, error: 'auth failed' }));
  };
}

// ---- login / logout / operator CRUD ----
async function login(username, password) {
  const op = await q.get(
    `SELECT id, username, pass_hash, role, capabilities_json, disabled
       FROM console.operators WHERE username = $1`,
    [username],
  );
  if (!op || op.disabled || !verifyPassword(password, op.pass_hash)) return null;
  const token = newToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await q.run(
    `INSERT INTO console.sessions (token, operator_id, expires_at) VALUES ($1,$2,$3)`,
    [token, op.id, expires],
  );
  const caps = Array.isArray(op.capabilities_json) && op.capabilities_json.length
    ? op.capabilities_json : capsForRole(op.role);
  return {
    token,
    operator: { id: op.id, username: op.username, role: op.role, capabilities: caps },
  };
}

async function logout(token) {
  if (!token) return;
  await q.run(`DELETE FROM console.sessions WHERE token = $1`, [token]);
}

async function createOperator({ username, password, role, capabilities }) {
  const r = role || 'viewer';
  const caps = Array.isArray(capabilities) && capabilities.length
    ? capabilities : capsForRole(r);
  const row = await q.get(
    `INSERT INTO console.operators (username, pass_hash, role, capabilities_json, disabled)
     VALUES ($1,$2,$3,$4,false)
     RETURNING id, username, role, capabilities_json, disabled`,
    [username, hashPassword(password), r, JSON.stringify(caps)],
  );
  return {
    id: row.id, username: row.username, role: row.role,
    capabilities: row.capabilities_json, disabled: row.disabled,
  };
}

// bootstrapAdmin: log presence of ADMIN_KEY (never the value). x-admin-key => full caps
// is enforced in the middleware above; nothing to persist.
function bootstrapAdmin() {
  if (process.env.ADMIN_KEY) {
    console.log('[auth] ADMIN_KEY present — x-admin-key bootstrap enabled');
  } else {
    console.warn('[auth] ADMIN_KEY not set — no bootstrap admin; create operators via seed');
  }
}

module.exports = {
  requireAuth,
  requireCapability,
  login,
  logout,
  createOperator,
  bootstrapAdmin,
  // helpers exported for routes/tests
  capsForRole,
  hasCap,
  adminKeyOk,
  operatorFromRequest,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  ROLE_CAPS,
};