'use strict';
/*
 * E2E: the external worker runs Phase-1 iDRAC inventory OVER THE VPN and reports it to the console.
 *
 * Runs on the worker (here: the console pod on luca-capacity, which cannot reach the iDRAC net
 * directly). It opens a stream to each iDRAC THROUGH the (mock) VPN gateway, pulls real Redfish
 * system inventory (model, service tag, power, health) with iDRAC Basic auth, and upserts it into the
 * console's servers table — exactly what the dispatched Phase-1 step does in production.
 *
 *   VPN_GATEWAY=192.168.1.119:51820 VPN_PSK=.. IDRAC_USER=root IDRAC_PASS=.. \
 *   DATABASE_URL=.. TARGETS=192.168.10.2,192.168.10.3 node inventory-e2e.js
 */
const tls = require('node:tls');
const { Pool } = require('pg');

const PSK = process.env.VPN_PSK; const [GW, GP] = (process.env.VPN_GATEWAY || '').split(':');
const IDRAC_USER = process.env.IDRAC_USER || 'root';
const IDRAC_PASS = process.env.IDRAC_PASS || '';
const TARGETS = (process.env.TARGETS || '').split(',').filter(Boolean);
const CIPHERS = 'PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256';

// open a raw duplex to host:port through the mock VPN gateway
function tunnel(host, port) {
  return new Promise((resolve, reject) => {
    const t = tls.connect({
      host: GW, port: Number.parseInt(GP || '51820', 10),
      ciphers: CIPHERS, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
      pskCallback: () => ({ identity: 'worker', psk: Buffer.from(PSK) }),
      checkServerIdentity: () => undefined,
    }, () => {
      t.write(`CONNECT ${host} ${port}\n`);
      let buf = '';
      const onReply = (c) => {
        buf += c.toString('latin1'); const nl = buf.indexOf('\n'); if (nl < 0) return;
        t.removeListener('data', onReply);
        if (!buf.startsWith('OK')) { t.destroy(); return reject(new Error(buf.trim())); }
        resolve(t);
      };
      t.on('data', onReply);
    });
    t.on('error', reject);
  });
}

// Redfish GET over the tunnel (TLS to the iDRAC through the tunnel + Basic auth) -> parsed JSON
async function redfish(host, path) {
  const raw = await tunnel(host, 443);
  return new Promise((resolve, reject) => {
    const idrac = tls.connect({ socket: raw, rejectUnauthorized: false }, () => {
      const auth = Buffer.from(`${IDRAC_USER}:${IDRAC_PASS}`).toString('base64');
      idrac.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Basic ${auth}\r\nAccept: application/json\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    idrac.on('data', (c) => { data += c.toString('utf8'); });
    idrac.on('end', () => {
      const status = data.split('\r\n')[0];
      const body = data.slice(data.indexOf('\r\n\r\n') + 4);
      try { resolve({ status, json: JSON.parse(body.slice(body.indexOf('{'))) }); }
      catch { resolve({ status, json: null }); }
    });
    idrac.on('error', reject);
    setTimeout(() => { idrac.destroy(); reject(new Error('timeout')); }, 10000);
  });
}

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL ? { rejectUnauthorized: false } : false });
  for (const ip of TARGETS) {
    try {
      const { status, json } = await redfish(ip, '/redfish/v1/Systems/System.Embedded.1');
      if (!json) { console.log(`[e2e] ${ip}: ${status} (no JSON)`); continue; }
      const model = json.Model || null;
      const svcTag = json.SKU || json.SerialNumber || null;
      const health = (json.Status && json.Status.HealthRollup) || null;
      const power = json.PowerState || null;
      console.log(`[e2e] ${ip} OVER VPN -> ${status} | Model=${model} | ServiceTag=${svcTag} | Power=${power} | Health=${health}`);
      await pool.query(
        `UPDATE console.servers SET model=$2, service_tag=$3, health=$4,
           fw_json=$5, last_inventory_at=now() WHERE idrac_ip=$1`,
        [ip, model, svcTag, health, JSON.stringify({ powerState: power, via: 'vpn' })]);
    } catch (e) { console.log(`[e2e] ${ip}: ERROR ${e.message}`); }
  }
  await pool.end();
})();
