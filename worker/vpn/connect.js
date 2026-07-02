'use strict';
/*
 * Worker VPN CLIENT — the real product piece. Runs on the worker devstation and connects OUT to the
 * customer's OWN VPN gateway (whatever they run), then verifies it can reach their iDRAC/mgmt nets
 * before the deployment proceeds. This is how the worker "connects as if it were the customer's own
 * remote worker". (The mock gateway/relay in this folder is only for lab testing.)
 *
 * Multi-protocol: dispatches to the installed client for the customer's VPN. The customer supplies a
 * PROFILE (JSON) describing protocol + config + credential refs; secrets are read from the worker's
 * credential store, never logged, never leave the worker.
 *
 *   node connect.js --profile <profile.json> [--up|--down|--status|--check]
 *
 * profile.json:
 *   {
 *     "protocol": "wireguard|openvpn|anyconnect|globalprotect|fortinet|ipsec|mock",
 *     "config":   "<path to .conf/.ovpn/.p12 etc, or inline for wireguard>",
 *     "server":   "vpn.customer.com",                 // for openconnect family
 *     "credRef":  "cred:vpn",                          // resolved from the worker cred store
 *     "reach":    ["192.168.10.0/24","192.168.1.0/24"],// subnets the tunnel must provide
 *     "probe":    ["192.168.10.2:443","192.168.10.3:443"] // iDRACs to verify over the tunnel
 *   }
 *
 * On a real worker the tunnel clients (wireguard/openvpn/openconnect/strongswan) are pre-staged in
 * the golden image (worker/prestage). This orchestrator picks the right one and runs the reach gate.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const tls = require('node:tls');
const net = require('node:net');

function getSecret(ref) {
  // resolve from the worker credential store — env for the stub; DPAPI/Key Vault on the real worker.
  if (!ref) return '';
  const key = 'CRED_' + ref.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  return process.env[key] || '';
}

// protocol -> the command that brings the tunnel up (client pre-staged in the golden image)
function bringUp(p) {
  const cred = getSecret(p.credRef);
  switch ((p.protocol || '').toLowerCase()) {
    case 'wireguard':   return ['wireguard', ['/installtunnelservice', p.config]];               // Windows WireGuard
    case 'openvpn':     return ['openvpn', ['--config', p.config, ...(cred ? ['--auth-user-pass', cred] : [])]];
    case 'anyconnect':  return ['openconnect', ['--protocol=anyconnect', '--passwd-on-stdin', p.server]];
    case 'globalprotect': return ['openconnect', ['--protocol=gp', '--passwd-on-stdin', p.server]];
    case 'fortinet':    return ['openconnect', ['--protocol=fortinet', '--passwd-on-stdin', p.server]];
    case 'ipsec':       return ['strongswan', ['up', p.config]];
    case 'mock':        return null; // lab: the mock gateway is already reachable; skip client bring-up
    default: throw new Error(`unsupported VPN protocol: ${p.protocol}`);
  }
}

function up(p) {
  const spec = bringUp(p);
  if (!spec) { console.log(`[vpn] protocol=mock — no client to bring up (lab)`); return Promise.resolve(); }
  const [cmd, args] = spec;
  console.log(`[vpn] bringing up ${p.protocol} tunnel via ${cmd}`);
  const cred = getSecret(p.credRef);
  const child = spawn(cmd, args, { stdio: ['pipe', 'inherit', 'inherit'] });
  if (/anyconnect|globalprotect|fortinet/.test(p.protocol) && cred) child.stdin.end(cred + '\n');
  return new Promise((res, rej) => {
    child.on('error', (e) => rej(new Error(`${cmd} not available on this worker: ${e.message}`)));
    // openconnect/openvpn stay in foreground; give the tunnel a moment then hand back to the reach gate
    setTimeout(res, 4000);
  });
}

// reachability gate: prove Redfish reach to every iDRAC over the tunnel before Phase 1
async function check(p) {
  const targets = p.probe || [];
  let ok = 0;
  for (const t of targets) {
    const [h, port] = t.split(':');
    const reached = await probeRedfish(h, Number.parseInt(port || '443', 10)).catch(() => false);
    console.log(`[vpn] reach ${t}: ${reached ? 'OK (' + reached + ')' : 'UNREACHABLE'}`);
    if (reached) ok++;
  }
  const pass = targets.length > 0 && ok === targets.length;
  console.log(`[vpn] reachability gate: ${ok}/${targets.length} — ${pass ? 'PASS' : 'FAIL (holding run)'}`);
  return pass;
}

function probeRedfish(host, port) {
  return new Promise((resolve, reject) => {
    const c = tls.connect({ host, port, rejectUnauthorized: false, timeout: 6000 }, () => {
      c.write(`GET /redfish/v1 HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    c.on('data', (d) => { buf += d.toString('latin1'); if (buf.includes('\r\n')) { resolve(buf.split('\r\n')[0]); c.destroy(); } });
    c.on('timeout', () => { c.destroy(); reject(new Error('timeout')); });
    c.on('error', reject);
  });
}

function down(p) {
  const proto = (p.protocol || '').toLowerCase();
  if (proto === 'wireguard') spawn('wireguard', ['/uninstalltunnelservice', p.name || 'wg0']);
  else if (proto === 'ipsec') spawn('strongswan', ['down', p.config]);
  // openvpn/openconnect: the foreground process is signalled by the agent; no-op here.
  console.log('[vpn] tunnel down requested');
}

async function main() {
  const args = process.argv.slice(2);
  const pf = args[args.indexOf('--profile') + 1];
  if (!pf) { console.error('usage: node connect.js --profile <file> [--up|--down|--status|--check]'); process.exit(2); }
  const p = JSON.parse(fs.readFileSync(pf, 'utf8'));
  const action = args.find((a) => ['--up', '--down', '--status', '--check'].includes(a)) || '--up';
  if (action === '--down') return down(p);
  if (action === '--up') await up(p);
  const pass = await check(p);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error('[vpn] ERROR:', e.message); process.exit(1); });
// silence unused import in some paths
void net;