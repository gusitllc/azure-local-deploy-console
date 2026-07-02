'use strict';
// lib/billing.js — Stripe webhook verification + checkout.session.completed handling.
// On a verified paid checkout we create customer + order + a pending run, then hand
// off to provision.js to spin a worker. No card data ever touches us (Stripe holds it).

const crypto = require('node:crypto');
const db = require('./db');
const provision = require('./provision');
const events = require('./events');

// ---- Stripe signature verification (node:crypto HMAC, no SDK) --------------
// Stripe-Signature header: "t=<ts>,v1=<hex>,v1=<hex>,..." — signed payload is
// `${t}.${rawBody}` HMAC-SHA256 with the webhook secret. Constant-time compare.
const SIG_TOLERANCE_S = 300; // reject events older than 5 minutes (replay guard)

function parseSigHeader(sig) {
  const out = { t: null, v1: [] };
  if (typeof sig !== 'string') return out;
  for (const part of sig.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') out.t = v;
    else if (k === 'v1') out.v1.push(v);
  }
  return out;
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Returns the parsed event object on success; throws on any verification failure.
function verifyStripeSignature(rawBody, sig, secret) {
  if (!secret) throw new Error('stripe webhook secret not configured');
  if (rawBody == null) throw new Error('missing raw body');
  const raw = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const parsed = parseSigHeader(sig);
  if (!parsed.t || parsed.v1.length === 0) throw new Error('malformed stripe signature');

  const ts = Number(parsed.t);
  if (!Number.isFinite(ts)) throw new Error('invalid signature timestamp');
  const ageS = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (ageS > SIG_TOLERANCE_S) throw new Error('stripe signature timestamp outside tolerance');

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parsed.t}.${raw}`, 'utf8')
    .digest('hex');
  const match = parsed.v1.some((cand) => timingSafeEq(cand, expected));
  if (!match) throw new Error('stripe signature mismatch');

  let event;
  try {
    event = JSON.parse(raw);
  } catch (_e) {
    throw new Error('stripe payload is not valid JSON');
  }
  return event;
}

// ---- Webhook event handling ------------------------------------------------
const PRICE_CENTS_PER_CLUSTER = 20000; // $200/cluster (blueprint 04)

function extractSession(event) {
  const s = (event && event.data && event.data.object) || {};
  const md = s.metadata || {};
  const clustersQty = Math.max(1, parseInt(md.clusters_qty, 10) || 1);
  return {
    stripeSessionId: s.id || null,
    stripeCustomerId: s.customer || null,
    email:
      (s.customer_details && s.customer_details.email) ||
      s.customer_email ||
      md.email ||
      null,
    company: md.company || null,
    clustersQty,
    amountCents:
      Number.isFinite(s.amount_total) && s.amount_total > 0
        ? s.amount_total
        : PRICE_CENTS_PER_CLUSTER * clustersQty,
  };
}

// Idempotent by stripe_session_id: a Stripe retry must not double-provision.
async function upsertCustomerOrder(client, sd) {
  const existing = sd.stripeSessionId
    ? await client.get('SELECT id FROM console.orders WHERE stripe_session_id=$1', [
        sd.stripeSessionId,
      ])
    : null;
  if (existing) return { orderId: existing.id, isNew: false, customerId: null };

  let customer = sd.email
    ? await client.get('SELECT id FROM console.customers WHERE email=$1', [sd.email])
    : null;
  if (!customer) {
    customer = await client.get(
      `INSERT INTO console.customers (email, company, stripe_customer_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [sd.email, sd.company, sd.stripeCustomerId]
    );
  } else if (sd.stripeCustomerId) {
    await client.run(
      'UPDATE console.customers SET stripe_customer_id=$1 WHERE id=$2 AND stripe_customer_id IS NULL',
      [sd.stripeCustomerId, customer.id]
    );
  }

  const order = await client.get(
    `INSERT INTO console.orders
       (customer_id, stripe_session_id, amount_cents, clusters_qty, status)
     VALUES ($1,$2,$3,$4,'paid') RETURNING id`,
    [customer.id, sd.stripeSessionId, sd.amountCents, sd.clustersQty]
  );
  return { orderId: order.id, isNew: true, customerId: customer.id };
}

// handleWebhook(event) — event already signature-verified by the caller.
// Only checkout.session.completed provisions; other event types are acked no-op.
async function handleWebhook(event) {
  const type = event && event.type;
  if (type !== 'checkout.session.completed') {
    return { ok: true, handled: false, type: type || null };
  }
  const sd = extractSession(event);
  const { orderId, isNew } = await db.q.tx((client) => upsertCustomerOrder(client, sd));

  if (!isNew) {
    return { ok: true, handled: true, orderId, duplicate: true };
  }
  // Provision worker(s) + create pending run — outside the order tx so a slow
  // provider call never holds the orders write open. provision is idempotent.
  const result = await provision.provisionForOrder(orderId).catch(async (err) => {
    await events
      .emit(null, {
        level: 'error',
        type: 'provision',
        message: `provision failed for order ${orderId}: ${err.message}`,
      })
      .catch(() => {});
    return { ok: false, error: err.message };
  });
  return { ok: true, handled: true, orderId, provision: result };
}

module.exports = { verifyStripeSignature, handleWebhook };