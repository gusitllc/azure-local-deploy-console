# worker/vpn

How the worker reaches a customer's private iDRAC / node-management networks. Two very different
things live here — keep them straight.

## The real product piece

- **`connect.js`** — the **worker VPN client**. Runs on the worker devstation and connects *out* to
  the **customer's own VPN** (whatever they run), then verifies Redfish reach to every iDRAC over the
  tunnel before the deployment proceeds. Multi-protocol dispatcher:

  | Customer VPN | Client used (pre-staged in the golden image) |
  | --- | --- |
  | WireGuard | WireGuard |
  | OpenVPN | OpenVPN |
  | Cisco AnyConnect | `openconnect --protocol=anyconnect` |
  | Palo Alto GlobalProtect | `openconnect --protocol=gp` |
  | Fortinet | `openconnect --protocol=fortinet` |
  | IPsec / IKEv2 | strongSwan (or Windows built-in IKEv2) |

  The customer supplies a **profile** (protocol + config + credential ref); secrets are read from the
  worker credential store, never logged, never leave the worker. This is how we "connect as if we
  were the customer's own remote worker". The clients are installed by `worker/prestage/stage-worker.ps1`.

## The lab mock (NOT a product)

- **`gateway.js`**, **`relay.js`**, **`gateway-agent.js`** — a **mock** that *simulates a customer's
  VPN gateway* so we can test `connect.js` (and prove the reach model) on our own hardware where we
  lack admin to stand up a real VPN endpoint. Nothing here ships to a customer. `relay.js` may later
  be reused as an internal infra-to-infra rendezvous if we ever need our own site-to-site VPN
  (owner note) — but for the deployment product, the customer's VPN + `connect.js` is the path.

## Proven

An external host (a pod that times out reaching the iDRAC net directly) reached a real iDRAC's
Redfish API — `HTTP/1.1 200 OK` — through the encrypted tunnel to the mock gateway. That validates the
reach model; on a real engagement `connect.js` establishes the same reach through the customer's own
VPN. See blueprint 16 (VPN-NETWORK-ACCESS).
