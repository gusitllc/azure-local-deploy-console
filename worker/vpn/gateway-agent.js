'use strict';
/*
 * Per-customer VPN gateway agent — runs at the customer edge (on a box that reaches their iDRAC
 * out-of-band + node management networks). ONE per customer. Dials OUT to the central relay
 * (no inbound firewall change, no admin), registers its siteId, and on demand opens streams from
 * the relay to the requested iDRAC/mgmt host on its LAN.
 *
 * In production this ships as a tiny image the customer runs on their iDRAC LAN. In the lab it runs
 * on the deployer (the only host reaching 192.168.10.0/24).
 *
 *   VPN_RELAY=relay.host:51820 VPN_PSK=<key> VPN_SITE=<customerId> \
 *   VPN_ALLOW=192.168.10.0/24,192.168.1.0/24 node gateway-agent.js
 */
const tls = require('node:tls');
const net = require('node:net');

const PSK = process.env.VPN_PSK || (() => { throw new Error('set VPN_PSK'); })();
const [RH, RP] = (process.env.VPN_RELAY || '').split(':');
if (!RH) throw new Error('set VPN_RELAY host:port');
const SITE = process.env.VPN_SITE || 'default';
const ALLOW = (process.env.VPN_ALLOW || '192.168.10.0/24,192.168.1.0/24').split(',').map(s => s.trim());
const CIPHERS = 'PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256';

function ipToInt(ip) { return ip.split('.').reduce((a, o) => (a << 8 >>> 0) + (+o), 0) >>> 0; }
function inCidr(ip, cidr) {
  const [n, bRaw] = cidr.split('/'); const b = +bRaw;
  const mask = b === 0 ? 0 : (~0 << (32 - b)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(n) & mask);
}
const allowed = (h) => ALLOW.some((c) => { try { return inCidr(h, c); } catch { return false; } });

function connectRelay(firstLine, onReady) {
  const s = tls.connect({
    host: RH, port: Number.parseInt(RP || '51820', 10),
    ciphers: CIPHERS, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
    pskCallback: () => ({ identity: 'worker', psk: Buffer.from(PSK) }),
    checkServerIdentity: () => undefined,
  }, () => { s.write(firstLine); onReady(s); });
  s.on('error', () => {});
  return s;
}

// data connection: relay asked us to OPEN <sid> <host> <port> -> dial the target + splice to relay
function openStream(sid, host, port) {
  if (!allowed(host)) return;
  const relayData = connectRelay(`DAT ${sid}\n`, (rs) => {
    const target = net.connect(Number.parseInt(port, 10), host, () => {
      rs.pipe(target); target.pipe(rs);
    });
    target.on('error', () => rs.destroy());
    rs.on('error', () => target.destroy());
  });
  relayData.on('error', () => {});
}

// control connection: register + receive OPEN commands; auto-reconnect
function control() {
  let buf = '';
  const ctl = connectRelay(`REG ${SITE}\n`, () => {});
  ctl.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      const [verb, sid, host, port] = line.split(/\s+/);
      if (verb === 'OPEN') openStream(sid, host, port);
      else if (verb === 'OK') console.log(`[vpn-gateway-agent] registered site=${SITE} to relay ${RH} (bridging ${ALLOW.join(', ')})`);
    }
  });
  ctl.on('close', () => { console.log('[vpn-gateway-agent] control closed — reconnecting in 3s'); setTimeout(control, 3000); });
  ctl.on('error', () => {});
}
control();