'use strict';
/*
 * ⚠️ LAB MOCK / optional internal use — pairs with the mock gateway to simulate a customer VPN
 * rendezvous for testing. NOT part of what a customer runs. (May later be reused as an internal
 * infra-to-infra rendezvous if we ever need our own site-to-site VPN — see blueprint 16.)
 *
 * VPN relay / rendezvous.
 *
 * Both ends dial OUT to this relay (no inbound firewall change, no admin anywhere):
 *  - a GATEWAY (on the customer's iDRAC LAN, or the lab deployer) holds a control connection and
 *    registers a siteId; when a worker requests a stream, the relay tells the gateway to open it.
 *  - a WORKER requests "reach host:port on siteId"; the relay brokers a byte-pipe between the
 *    worker and the gateway, which in turn reaches the iDRAC/mgmt host on its LAN.
 * Encrypted with TLS-PSK (no certs). One TCP per stream on each side — no multiplexing.
 *
 *   VPN_PSK=<key> VPN_PORT=51820 node relay.js
 *
 * Wire protocol (first line, then raw bytes):
 *   gateway control : "REG <siteId>\n"                 (long-lived; receives "OPEN <sid> <h> <p>\n")
 *   gateway data     : "DAT <streamId>\n"              (one per stream; spliced to a waiting worker)
 *   worker request   : "REQ <siteId> <host> <port>\n"  (spliced to the gateway's DAT conn)
 */
const tls = require('node:tls');
const crypto = require('node:crypto');

const PSK = process.env.VPN_PSK || (() => { throw new Error('set VPN_PSK'); })();
const PORT = Number.parseInt(process.env.VPN_PORT || '51820', 10);
const CIPHERS = 'PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256';

const gateways = new Map();            // siteId -> control socket
const pendingStreams = new Map();      // streamId -> worker socket awaiting its gateway DAT conn

function readLine(sock, onLine) {
  let buf = '';
  const h = (chunk) => {
    buf += chunk.toString('latin1');
    const nl = buf.indexOf('\n');
    if (nl < 0) { if (buf.length > 512) sock.destroy(); return; }
    sock.removeListener('data', h);
    onLine(buf.slice(0, nl).trim(), Buffer.from(buf.slice(nl + 1), 'latin1'));
  };
  sock.on('data', h);
}

const server = tls.createServer({
  ciphers: CIPHERS, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
  pskCallback: (_s, identity) => (identity === 'worker' ? Buffer.from(PSK) : null),
}, (sock) => {
  sock.on('error', () => {});
  readLine(sock, (line, leftover) => {
    const [verb, a, b, c] = line.split(/\s+/);
    if (verb === 'REG') {                         // gateway control
      gateways.set(a, sock);
      sock.write('OK\n');
      sock.on('close', () => { if (gateways.get(a) === sock) gateways.delete(a); });
      console.log(`[vpn-relay] gateway registered site=${a} (total ${gateways.size})`);
    } else if (verb === 'REQ') {                  // worker wants a stream
      const gw = gateways.get(a);
      if (!gw) { sock.end('ERR no gateway for site\n'); return; }
      const sid = crypto.randomUUID().slice(0, 8);
      pendingStreams.set(sid, { worker: sock, leftover });
      setTimeout(() => { if (pendingStreams.delete(sid)) sock.destroy(); }, 15000);
      gw.write(`OPEN ${sid} ${b} ${c}\n`);
    } else if (verb === 'DAT') {                  // gateway's data conn for a stream
      const p = pendingStreams.get(a);
      if (!p) { sock.destroy(); return; }
      pendingStreams.delete(a);
      p.worker.write('OK\n');
      if (p.leftover.length) sock.write(p.leftover);   // worker's early bytes -> gateway
      p.worker.pipe(sock); sock.pipe(p.worker);
      p.worker.on('error', () => sock.destroy());
      sock.on('error', () => p.worker.destroy());
    } else {
      sock.destroy();
    }
  });
});
server.on('tlsClientError', () => {});
server.listen(PORT, '0.0.0.0', () => console.log(`[vpn-relay] TLS-PSK rendezvous on :${PORT}`));