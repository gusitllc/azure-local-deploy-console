'use strict';
// routes/auth.js — login / logout. Mounted at /api by server.js, so:
//   POST /api/auth/login  (allowlisted — no requireAuth)
//   POST /api/auth/logout (any authenticated session)
// Login issues an httpOnly, SameSite=Strict session cookie.
const express = require('express');
const { ok, fail } = require('../lib/respond');
const auth = require('../lib/auth');

const router = express.Router();

function sessionCookie(token, maxAgeMs) {
  const parts = [
    `${auth.SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
}

function clearCookie() {
  const parts = [
    `${auth.SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return parts.join('; ');
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

// POST /api/auth/login  { username, password }  (allowlisted)
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' ||
      !username || !password) {
    return fail(res, 'username and password required', 400);
  }
  try {
    const result = await auth.login(username, password);
    if (!result) return fail(res, 'invalid credentials', 401);
    res.setHeader('Set-Cookie', sessionCookie(result.token, auth.SESSION_TTL_MS));
    return ok(res, { operator: result.operator });
  } catch (e) {
    return fail(res, 'login failed', 500);
  }
});

// POST /api/auth/logout  (clears the session server-side + cookie)
router.post('/auth/logout', async (req, res) => {
  try {
    const token = readCookie(req, auth.SESSION_COOKIE);
    if (token) await auth.logout(token);
    res.setHeader('Set-Cookie', clearCookie());
    return ok(res, {});
  } catch (e) {
    res.setHeader('Set-Cookie', clearCookie());
    return ok(res, {});
  }
});

module.exports = router;