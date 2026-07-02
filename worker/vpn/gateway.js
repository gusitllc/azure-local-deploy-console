'use strict';
/*
 * ⚠️ LAB MOCK — this is NOT a product. It exists only to SIMULATE a customer's VPN gateway so we can
 * test the worker's VPN client against something. In production the customer runs their OWN VPN
 * (WireGuard, OpenVPN, AnyConnect, GlobalProtect, IPsec…) and our worker connects to it with the
 * multi-protocol client in worker/vpn/connect.js. Nothing here ships to a customer.
 *
 * Mock behaviour: runs on a host that CAN reach the iDRAC out-of-band network (192.168.10.0/24) +
 * the node management network (192.168.1.0/24); accepts an encrypted (TLS-PSK, no certs, no admin)
 * connection and bridges each requested stream onto the LAN — i.e. it pretends to be the customer's
 * VPN endpoint so a test worker can reach the iDRACs "as if external".
 *
 *   VPN_PSK=<shared-key> VPN_BIND=192.168.1.119 VPN_PORT=51820 \
 *   VPN_ALLOW=192.168.10.0/24,192.168.1.0/24 node gateway.js
 */
const tls = require('tls');
const net = require('net');

const PSK = process.env.VPN_PSK || (() => { throw new Error('set VPN_PSK'); })();
const BIND = process.env.VPN_BIND || '0.0.0.0';
const PORT = parseInt(process.env.VPN_PORT || '51820', 10);
const ALLOW = (process.env.VPN_ALLOW || '192.168.10.0/24,192.168.1.0/24').split(',').map(s => s.trim());
const CIPHERS = 'PSK-AES256-GCM-SHA384:PSK-AES128-GCM-SHA256';

function ipToInt(ip) { return ip.split('.').reduce((a, o) => (a << 8 >>> 0) + (+o), 0) >>> 0; }
function inCidr(ip, cidr) {
  const [net_, bitsRaw] = cidr.split('/'); const bits = +bitsRaw;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(net_) & mask);
}
function allowed(host) { return ALLOW.some(c => { try { return inCidr(host, c); } catch { return false; } }); }

const server = tls.createServer({
  ciphers: CIPHERS, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2',
  pskCallback: (_socket, identity) => (identity === 'worker' ? Buffer.from(PSK) : null),
}, (sock) => {
  let header = '';
  const onData = (chunk) => {
    header += chunk.toString('latin1');
    const nl = header.indexOf('\n');
    if (nl < 0) { if (header.length > 256) sock.destroy(); return; }
    sock.removeListener('data', onData);
    const rest = Buffer.from(header.slice(nl + 1), 'latin1');
    const [verb, host, portStr] = header.slice(0, nl).trim().split(/\s+/);
    if (verb !== 'CONNECT' || !host || !allowed(host)) {
      sock.end('ERR forbidden target\n'); return;
    }
    const upstream = net.connect(parseInt(portStr, 10), host, () => {
      sock.write('OK\n');
      if (rest.length) upstream.write(rest);
      sock.pipe(upstream); upstream.pipe(sock);
    });
    upstream.on('error', () => sock.destroy());
    sock.on('error', () => upstream.destroy());
  };
  sock.on('data', onData);
  sock.on('error', () => {});
});
server.on('tlsClientError', () => {});
server.listen(PORT, BIND, () => {
  console.log(`[vpn-gateway] TLS-PSK on ${BIND}:${PORT} bridging to ${ALLOW.join(', ')}`);
});