# CUSTOMER-ONBOARDING — what the customer gives us, what we give them

> Blueprint 15 (addendum). The delivery contract: the exact inputs a customer must provide, the exact
> things we provision for them, and the self-service flow from payment to a running cluster. Designed
> so the customer installs nothing and no secret ever touches our systems.

## The deal in one line

The customer supplies **network reach + three credentials + their cluster's shape**; we supply a
**worker, a console, and a built cluster** — and then the worker (with their secrets) disappears.

## What the customer provides

### A. Three credentials (entered into *their* worker, never our systems)
| # | Credential | Why | Where it's stored |
| --- | --- | --- | --- |
| 1 | **Claude Code OAuth token** | the AI that assists the build (their subscription pays) | worker key store only |
| 2 | **VPN profile** (WireGuard/OpenVPN) to their iDRAC network | so the worker can reach their servers | worker key store only |
| 3 | **Azure sign-in / service-principal consent** (subscription owner or contributor) | to create the cluster's Azure resources | worker key store / their Key Vault |

### B. Server access (entered in Phase 1, pushed to the worker key store)
- **iDRAC IPs** of each server (2 for a 2-node cluster).
- **iDRAC credentials** (user + password) — or a per-server cred handle.
- Confirmation the **storage NICs are cross-cabled** node-to-node (switchless).

### C. The cluster's shape (the console's "new cluster" form → `clusters.config_json`)
| Field | Example |
| --- | --- |
| Node names | `node-a`, `node-b` |
| Management IPs + subnet/gateway/DNS | `10.0.0.40/.41`, `/24`, gw, dns |
| NIC intent (mgmt Port1/2, storage Port3/4) | Broadcom = mgmt, Mellanox = storage |
| Cluster name + Azure subscription + resource group + region | `edge-01`, sub, rg, `eastus` |
| Witness | a cloud storage account (we can create it) |
| Domain vs. workgroup (+ OU if AD) | AD `OU=…` or workgroup |
| Static IP pool (≥6) for infra/ARB | `10.0.0.43–48` |

### D. Eligibility (checked **before** the card is charged)
- Servers on the Azure Local **hardware catalog** (or accepted-risk lab hardware).
- An OS build the RP accepts for **new deployments** (release-table allow-list) — this is the check
  that prevents the "Unsupported OS Version" dead-end from becoming a refund.
- Reachable iDRAC network over the supplied VPN.

## What we provide

1. **A dedicated worker devstation** — pre-staged golden image (engine, toolchain, Claude Code, VPN
   client), spun up on payment, connected to *their* network, torn down at hand-off.
2. **Console access** — a scoped, read-with-approve view of *their* run: the five phases, live logs,
   and the approval gates. Shareable with their team.
3. **The build itself** — firmware baseline → hands-off re-image → Arc + Azure prep → validation →
   the ~3-hour deploy — with every cloud error shown verbatim and known issues auto-healed.
4. **A running cluster + a monitoring view**, and a short hand-off summary.

## The self-service flow

```mermaid
sequenceDiagram
  participant C as Customer
  participant S as azurestack.nyc
  participant K as Stripe
  participant O as Console
  participant W as Worker devstation
  C->>S: Sign up + eligibility pre-check (hardware/OS/network)
  S->>K: Checkout ($200 x clusters)
  K-->>O: webhook: paid -> create order + run(pending)
  O->>W: provision worker from golden image + enroll token
  O-->>C: email: secure onboarding link (per-order token)
  C->>O: onboarding page — enter the 3 credentials + iDRAC access + cluster shape
  O->>W: push secrets to the worker key store (refs only kept by console)
  W->>W: bring up VPN, verify iDRAC reachability
  W-->>O: ready -> run moves to running
  C->>O: watch + approve each gate (wipe, deploy)
  O->>W: dispatch phases; W runs the engine over VPN
  W-->>O: live logs + state (secrets redacted)
  O-->>C: cluster Succeeded + monitoring; worker destroyed
```

## The onboarding surface (to build — P4/P5)

- **Eligibility pre-check** on the sign-up page (before charge): hardware model, OS build, VPN
  reachability self-report → clear go/no-go + refund-safe messaging.
- **Per-order onboarding page** (`/onboard/:orderToken`) — a single secure form that collects A + B +
  C above and posts them **straight to the worker key store** (the console stores only references).
  TLS, one-time token, values never logged.
- **Customer run view** (`/run/:id` scoped by order) — live, read-with-approve.

## Guarantees & policy

- **Nothing installed on the customer side.** All action is remote from the worker over VPN.
- **Secrets never on our systems.** Console holds references; values live only on the ephemeral worker.
- **Charged for a build, refunded on an eligibility miss.** The pre-charge check prevents most; an
  RP-side gate outside our control (verbatim-surfaced) is refund-eligible.
- **Watch and approve.** Destructive steps (wipe, deploy) require the customer/operator's approval.
- **Hand-off and vanish.** The worker — the only place their secrets lived — is destroyed at hand-off.

## Minimal viable onboarding (v1)

For the first paid customers, the "onboarding page" can be an **operator-assisted** intake: the
operator enters A/B/C into the console admin on a screen-share while the customer supplies values,
pushing them to the worker. The fully self-service `/onboard/:orderToken` page follows in P5. Either
way, the storage rule is identical: **secrets to the worker, references to the console.**