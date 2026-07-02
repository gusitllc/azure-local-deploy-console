'use strict';
// routes/billing.js — Stripe billing surface.
//   POST /billing/webhook  (allowlisted, Stripe-signed) — raw body + signature verified
//     -> billing.handleWebhook -> order + pending run + provision worker.
//   GET  /orders/:id        (deploy:settings:admin) — order status.
// Mounted at /api by server.js, so effective paths are /api/billing/webhook and /api/orders/:id.

const express = require('express');
const db = require('../lib/db');
const { ok, fail } = require('../lib/respond');
const auth = require('../lib/auth');
const billing = require('../lib/billing');

const router = express.Router();

// The webhook MUST see the exact raw bytes Stripe signed — express.json() would
// re-serialize and break the HMAC. We mount a route-local raw parser here so the
// global json() body parser in server.js does not consume this body first
// (server.js excludes /api/billing/webhook from json parsing; see server.js).
const rawParser = express.raw({ type: '*/*', limit: '1mb' });

router.post('/billing/webhook', rawParser, async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.get('stripe-signature');
  let event;
  try {
    // req.body is a Buffer here (raw parser). Verify signature over the raw bytes.
    event = billing.verifyStripeSignature(req.body, sig, secret);
  } catch (err) {
    // Do not leak internals; a bad signature is a 400 with a generic message.
    return fail(res, 'webhook signature verification failed', 400);
  }

  try {
    const result = await billing.handleWebhook(event);
    // Always 200 a verified event so Stripe stops retrying; carry handling detail.
    return ok(res, { received: true, ...result });
  } catch (err) {
    // Verified-but-processing-error: 500 so Stripe retries (idempotent handler).
    return fail(res, `webhook processing error: ${err.message}`, 500);
  }
});

router.get(
  '/orders/:id',
  auth.requireAuth,
  auth.requireCapability('deploy:settings:admin'),
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return fail(res, 'invalid order id', 400);

    const order = await db.q.get(
      `SELECT o.id, o.customer_id, o.stripe_session_id, o.amount_cents,
              o.clusters_qty, o.status, o.created_at,
              c.email AS customer_email, c.company AS customer_company
         FROM console.orders o
         JOIN console.customers c ON c.id = o.customer_id
        WHERE o.id = $1`,
      [id]
    );
    if (!order) return fail(res, 'order not found', 404);

    // Worker + run rollup for this order (no secrets: enroll_token_hash omitted).
    const workers = await db.q.all(
      `SELECT w.id, w.provider_ref, w.status, w.vpn_verified, w.last_seen_at,
              r.id AS run_id, r.status AS run_status, r.current_phase
         FROM console.workers w
         LEFT JOIN console.runs r ON r.worker_id = w.id
        WHERE w.order_id = $1
        ORDER BY w.id`,
      [id]
    );
    return ok(res, { order, workers });
  }
);

module.exports = router;