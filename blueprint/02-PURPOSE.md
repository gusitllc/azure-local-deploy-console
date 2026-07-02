# PURPOSE — Azure Local Deployment Console

> Blueprint 2 of 14. What it is, why it exists, who it serves, what success and failure look like.

## What it is

A **two-part deployment service** sold at azurestack.nyc for **$200 per cluster**:

1. **The console** — a single-image container app on the on-prem `luca-capacity` AKS-Arc cluster.
   Serves the marketing site, the operator admin page, and the REST/SSE API. Owns the **run state
   machine, the five phases, and the intervention gates**. Backed by **Postgres**.
2. **The worker devstation** — a pre-staged **Windows** golden image, one per customer/cluster, spun
   up on payment. Holds the engine, the toolchain, a VPN client, and Claude Code; connects to the
   customer's iDRAC network and runs the phases the console dispatches.

## Why it exists

Because the market for Azure Local is gated by **expertise, not demand**. The engine already removes
the mechanical difficulty; what remained was:

- **No way to sell it.** A public repo isn't a product. A $200 checkout, a provisioned worker, and a
  supervised console turn automation into a service a business can buy.
- **No supervised operation.** Running the engine meant an expert babysitting a terminal. The
  console gives auditable approval gates and verbatim error surfacing instead.
- **No reach.** Customers aren't on our network. The worker's VPN client lets us build clusters on
  private iDRAC networks anywhere.
- **No parallelism or state.** One expert deployed one cluster at a time with state in scrollback.
  Per-customer workers + a Postgres-backed console give parallel runs with durable, auditable state.

## Who it serves

| Persona | Need | How the product serves it |
| --- | --- | --- |
| **SMB / edge customer** | An Azure Local cluster without hiring a specialist | Pays $200, plugs in three credentials, watches it build |
| **AzureStack.NYC operator** | Run many customer deployments safely | Admin board: parallel runs, gates, halt/retry, verbatim errors |
| **Engagement client** | Visibility into their build | Live console view of their run's phases and logs |
| **Us (the business)** | Repeatable, marginal-cost-near-zero delivery | One golden image + one console; workers are ephemeral |

## What success looks like

- A non-expert operator runs **≥3 clusters in parallel**, each to a healthy deployed state, with
  **≤5 interventions** apiece.
- **Zero** customer secrets ever appear in the repo, the console DB, logs, or SSE streams.
- Every failure is surfaced with the **exact upstream error** (RP/validation text unparaphrased).
- A worker is provisioned within minutes of payment (pre-staged image) and **torn down at hand-off**.
- **Acceptance proof:** the console rebuilds a real 2-node cluster end to end, watched live, from a
  browser.

## What it is NOT

- **Not an appliance or installer.** Nothing runs on the customer's own machines except transiently
  over VPN from the worker.
- **Not a Microsoft portal replacement.** It drives Microsoft's own Arc/ARM/HCI surfaces; it does not
  reimplement them.
- **Not multi-tenant SaaS in v1.** One worker per customer, isolated; a shared control plane, not a
  shared data plane.
- **Not a general fleet/CMDB.** It deploys clusters; day-2 fleet management is out of scope for v1
  (post-deploy monitoring is in).
- **Not a place secrets live.** It is a conductor; credentials stay at the customer boundary.

## Scope boundaries (v1)

- **2-node switchless** clusters (the engine's proven shape). N-node is a later parameterization.
- **Dell servers** with iDRAC 9 Redfish (the validated hardware path).
- **One Azure subscription per customer**, supplied by them.
- Cloud-side gates outside our control (e.g. the current "Unsupported OS Version" RP behavior) are
  surfaced and held, not worked around.
