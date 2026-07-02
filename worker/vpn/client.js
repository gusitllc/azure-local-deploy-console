'use strict';
/*
 * Worker-side VPN client (the external worker's tunnel endpoint).
 *
 * Dials the customer-site gateway over an encrypted TLS-PSK tunnel and exposes local listeners so the
 * engine reaches the customer's iDRAC/mgmt hosts "as if local" — while the worker itself has NO direct
 * route to those networks. In production this is a native WireGuard client (blueprint 16); here it is
 * the no-admin userspace stand-in.
 *
 * Two modes:
 *   FORWARDS: comma list of localPort:targetHost:targetPort — fixed per-target tunnels.
 *     VPN_GATEWAY=192.168.1.119:51820 VPN_PSK=<key> \
 *     VPN_FORWARDS=8002:192.168.10.2:443,8003:192.168.10.3:443,5985:192.168.1.40:5985 node client.js
 *   PROBE: one-shot reachability test through the tunnel (used by the reachability gate).
 *     VPN_GATEWAY=.. VPN_PSK=.. VPN_PROBE=192.168.10.2:443 node client.js
 */
const tls = require('tls');
const net = require('net');

const PSK = process.env.VPN_PSK || (() => { throw new Error('set VPN_PSK'); })();
const [GW_HOST, GW_PORT] = (process.env.VPN_GATEWAY || '').split(':');
if (!GW_HOST) throw new Error('set VPN_GATEWAY host:port');
const CIPHERS = 'PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256';

function tunnel(targetHost, targetPort) {
  // resolves to a duplex stream already CONNECTed to the target through the gateway
  return new Promise((resolve, reject) => {
    const t = tls.connect({
      host: GW_HOST, port: parseInt(GW_PORT || '51820', 10),
      ciphers: CIPHERS, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
      pskCallback: () => ({ identity: 'worker', psk: Buffer.from(PSK) }),
      checkServerIdentity: () => undefined,
    }, () => {
      t.write(`CONNECT ${targetHost} ${targetPort}\n`);
      let buf = '';
      const onReply = (c) => {
        buf += c.toString('latin1');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        t.removeListener('data', onReply);
        if (!buf.startsWith('OK')) { t.destroy(); return reject(new Error(buf.trim() || 'gateway refused')); }
        const leftover = Buffer.from(buf.slice(nl + 1), 'latin1');
        resolve({ stream: t, leftover });
      };
      t.on('data', onReply);
    });
    t.on('error', reject);
  });
}

async function probe(target) {
  const [h, p] = target.split(':');
  const { stream } = await tunnel(h, parseInt(p, 10));
  // Real proof: TLS to the iDRAC *through* the tunnel, then a Redfish GET → read the HTTP status.
  await new Promise((resolve, reject) => {
    const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(h);
    const idrac = tls.connect({ socket: stream, ...(isIp ? {} : { servername: h }), rejectUnauthorized: false }, () => {
      idrac.write(`GET /redfish/v1 HTTP/1.1\r\nHost: ${h}\r\nAccept: application/json\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    idrac.on('data', (c) => {
      buf += c.toString('latin1');
      if (buf.includes('\r\n')) {
        const status = buf.split('\r\n')[0];
        console.log(`[vpn-client] PROBE ${target} THROUGH tunnel -> Redfish responded: ${status}`);
        idrac.destroy(); resolve();
      }
    });
    idrac.on('error', reject);
    setTimeout(() => { idrac.destroy(); reject(new Error('timeout')); }, 8000);
  });
}

function serveForwards(list) {
  list.forEach((f) => {
    const [lport, thost, tport] = f.split(':');
    net.createServer((local) => {
      tunnel(thost, parseInt(tport, 10)).then(({ stream, leftover }) => {
        if (leftover.length) local.write(leftover);
        local.pipe(stream); stream.pipe(local);
        local.on('error', () => stream.destroy());
        stream.on('error', () => local.destroy());
      }).catch(() => local.destroy());
    }).listen(parseInt(lport, 10), '127.0.0.1',
      () => console.log(`[vpn-client] 127.0.0.1:${lport} -> ${thost}:${tport} (via gateway ${GW_HOST})`));
  });
}

if (process.env.VPN_PROBE) probe(process.env.VPN_PROBE).catch((e) => { console.log('[vpn-client] PROBE FAIL:', e.message); process.exit(1); });
else serveForwards((process.env.VPN_FORWARDS || '').split(',').filter(Boolean));