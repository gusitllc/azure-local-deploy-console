'use strict';

// Canonical response envelope for the whole console API.
// Success:  { ok:true, ...data }
// Failure:  { ok:false, error, [verbatim] }
// `verbatim` carries raw RP/ARM text (secret-scrubbed) on validation/deploy
// failures so an operator sees exactly what the cloud said (blueprint 08).

function ok(res, data = {}) {
  return res.json({ ok: true, ...data });
}

function fail(res, error, status = 400, verbatim = null) {
  const body = { ok: false, error: String(error) };
  if (verbatim) body.verbatim = String(verbatim);
  return res.status(status).json(body);
}

module.exports = { ok, fail };