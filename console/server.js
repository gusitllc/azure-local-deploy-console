'use strict';
// server.js — Azure Local Deployment Console HTTP entrypoint.
// - JSON body parser (EXCEPT the Stripe webhook, which needs the raw signed bytes)
// - static site at '/' and operator UI at '/admin'
// - all API routers mounted under '/api'
// - db.migrate() + auth.bootstrapAdmin() on boot
// - GET /api/health with real metrics (in routes/health.js)
// Response envelope everywhere: {ok:true,...} | {ok:false,error}.

const path = require('node:path');
const express = require('express');

const db = require('./lib/db');
const auth = require('./lib/auth');
const respond = require('./lib/respond');

const app = express();
app.disable('x-powered-by');

// The Stripe webhook must receive the exact raw bytes it signed; billing.js
// mounts its own express.raw() parser, so exclude that path from global json().
const jsonParser = express.json({ limit: '1mb' });
app.use((req, res, next) => {
  if (req.path === '/api/billing/webhook') return next();
  return jsonParser(req, res, next);
});

// ---- static ----
// Public marketing/entry at '/', operator console at '/admin'. Directories are
// optional in dev; express.static simply 404s a missing file, which is fine.
app.use('/', express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ---- API routers (all under /api) ----
const routes = {
  health: require('./routes/health'),
  auth: require('./routes/auth'),
  runs: require('./routes/runs'),
  servers: require('./routes/servers'),
  workers: require('./routes/workers'),
  billing: require('./routes/billing'),
};
for (const key of Object.keys(routes)) {
  app.use('/api', routes[key]);
}

// ---- fallthrough + error envelope ----
app.use('/api', (req, res) => respond.fail(res, 'not found', 404));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Never leak internals or secrets; log a code only.
  console.error('[server] unhandled:', err && err.code ? err.code : 'error');
  if (res.headersSent) return;
  return respond.fail(res, 'internal error', 500);
});

const PORT = Number(process.env.PORT || 3000);

async function boot() {
  await db.migrate();
  auth.bootstrapAdmin();
  return new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      console.log(`[server] azlocal-deploy-console listening on :${PORT}`);
      resolve(server);
    });
  });
}

// Start only when run directly (require() in tests gets the app without binding).
if (require.main === module) {
  boot().catch((err) => {
    console.error('[server] boot failed:', err && err.message ? err.message : 'error');
    process.exit(1);
  });
}

module.exports = { app, boot };