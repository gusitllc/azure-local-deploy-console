# Azure Local Deployment Console — Purpose

## What This App Is

The Azure Local Deployment Console is a **single-container control tower for factory-deploying Azure Local 2-node clusters from bare metal to Arc-registered, validated, running clusters** — many of them at once. It is one image serving three surfaces:

1. **The azurestack.nyc public site** — the live-deployment pages engagement clients already watch.
2. **The backend services** — pipeline runner, run-state store (SQLite), structured log streaming (SSE), Redfish/Azure integrations.
3. **A new operator admin page** — where an operator enters iDRAC IPs, launches parallel cluster deployments, watches every stage live, and approves intervention gates.

It does **not** reimplement deployment logic. It **wraps the proven engine** — [`github.com/gusitllc/azure-local-2node-factory`](https://github.com/gusitllc/azure-local-2node-factory) (stages 00–60, `lib/redfish.sh`, the combined-ISO builder, `onboard-node.ps1`, `gen-arm-parameters.py`, `recover.sh`, `rebuild-cluster.sh`) — executing stages as child processes with structured, per-run logs. The console is the *orchestration, visibility, and safety layer* over an engine that already deployed a real cluster this week.

It runs where the work is: on the on-prem AKS-Arc cluster (`luca-capacity` on fl-1xa2-2node), with L2 reach to server iDRACs, an iDRAC-reachable range-capable HTTP server for virtual media, WinRM reach to node management IPs, and `az` CLI + service-principal credentials — everything the engine needs, packaged once.

---

## Why It Exists

### 1. The engine is proven but expert-only
The factory scripts take a pallet of Dell servers to a running Azure Local cluster — but today only the person who wrote them can drive them. Every deployment means a terminal, environment setup, path traps (MSYS/Windows), manual ISO verification, and hand-run recovery. The console turns that expert workflow into a guided pipeline a **trained-but-non-expert operator** can run from a browser.

### 2. One-at-a-time doesn't scale to the business
AzureStack.NYC's model is deploying clusters for clients, repeatedly. Serial deployments — each ~2.5–3 hours of ECE alone, plus firmware prep and node imaging — cap throughput at one cluster per operator-day. The console runs **multiple independent pipeline runs in parallel**, each with its own state, logs, and gates, so a single operator supervises a fleet of deployments instead of babysitting one.

### 3. Real deployments fail in real, upstream ways
This week's live deployment proved the failure modes are *external and opaque*: cloud validation rejecting GA builds with "Unsupported OS Version" (an open Microsoft-side gate reading edge inventory), extension sync drift, flaky media, RP errors buried in ARM responses. The fix is never hiding the error — it is **surfacing the exact upstream error verbatim**, pausing the run, and offering the known heal paths (ext-sync, recover.sh) as first-class actions. The console exists to make failure *legible and resumable*, not invisible.

### 4. Secrets and safety need enforcement, not discipline
SystemErase wipes servers; SimpleUpdate flashes firmware; deployment secrets unlock Azure tenants. These must be governed by **intervention gates** (configurable per run: pause-for-approval before destructive or expensive states) and by hard secrets hygiene (Key Vault / k8s Secret / env only — never in code, never in logs, never in the SQLite run state). The console makes the safe path the only path.

### 5. Clients are watching
azurestack.nyc already shows live deployments publicly. The console feeds that same window: engagement clients see their cluster progressing through named phases in real time, which is both the delivery artifact and the sales demo.

---

## Who It Serves

| Audience | What they get | What they control |
| --- | --- | --- |
| **AzureStack.NYC operator** (trained, non-expert) | A browser workflow: paste iDRAC IPs → inventory → firmware prep → node build → Arc + Azure prep → validation → cluster create — with live logs and clear gates. | Launching/halting runs; approving intervention gates; retrying/healing failed stages; per-run gate configuration. |
| **Engineering owner (Gus / expert)** | Parallel throughput without being on every deployment; verbatim upstream errors when escalated; the engine unchanged and independently usable from the CLI. | Engine versions; gate policy defaults; heal-path catalog; who has operator capability. |
| **Engagement client (watching)** | The azurestack.nyc live view of *their* deployment: phase-by-phase progress, honest status, no secrets, no internal noise. | Nothing — read-only, scoped to their engagement's runs. |
| **The business** | A repeatable, auditable deployment factory: every run recorded (who, what hardware, which stages, which errors, which approvals) in one place. | — |

Access is enforced, not assumed: auth on all data routes, capability checks on every mutation (launch, approve, erase, halt), and the client view is a strictly read-only projection.

---

## What It Does (The Five Phases)

Each **run = one cluster**, an independent pipeline; N runs execute concurrently. Every phase can be gated for operator approval, and every run can be halted at any point.

| Phase | Name | What happens |
| --- | --- | --- |
| **1** | **iDRAC Prep** | Operator enters iDRAC IPs for many servers. System inventories each (model, serial, health) via Redfish, compares firmware against baseline, and builds + applies an update plan (Redfish SimpleUpdate). |
| **2** | **Node Build** | Image nodes via self-wiping WinPE combined ISOs over iDRAC virtual media; install drivers; set time/NTP; configure NIC IPs + names (Port1..4) and server names — engine stages 18/20/30/32/35. ISO WIM contents are verified before use (never trust filenames; pycdlib extraction, no privileged mounts). |
| **3** | **Arc Registration + Azure Prep** | Arc onboard + the 4 AzureEdge extensions; service principals; resource group/region ("zone"); RP registration; Key Vault + the 3 deployment secrets; witness storage; permissions (the proven assign-deploy-permissions); ACR prep. |
| **4** | **Validation** | Azure Local validation (edge validate + deploymentSettings Validate / ARM template Validate) with known heal paths (ext-sync etc.) offered as one-click actions. RP errors shown **verbatim**. |
| **5** | **Cluster Creation + Monitoring** | Deploy (~2.5–3 h ECE) with live step tracking (track-deployment) and a post-deploy monitoring dashboard. |

---

## What Success Looks Like

The console succeeds when all of the following are routinely true:

| Success criterion | The test |
| --- | --- |
| **Parallel throughput** | N clusters (target: 3+ concurrent) deployed **at the same time** by **one non-expert operator**, each run isolated — one run's failure never touches another. |
| **Low intervention** | **Fewer than 5 operator interventions per cluster**, and every one of them is a *deliberate gate approval or a surfaced decision* — never "SSH in and figure out what's stuck." |
| **Zero secrets exposure** | No secret ever appears in code, logs, SSE streams, run state, or the UI. Secrets live in Key Vault / k8s Secrets / env only. A log grep for any credential returns nothing, ever. |
| **Every failure is legible** | Every failed stage surfaces the **exact upstream error verbatim** (Redfish response, RP error body, stage stderr), attached to the run, with halt/retry/heal offered. No failure is silent, summarized away, or lost. |
| **Resumable, auditable runs** | Any halted or failed run can be resumed or recovered from its exact stage. The full history — inputs, stage outcomes, gate approvals, errors — is queryable per run. |
| **Client-visible delivery** | The engagement client watches their deployment progress live on azurestack.nyc without any operator effort spent producing status updates. |

A concrete acceptance picture: an operator pastes eight iDRAC IPs on Monday morning, launches four 2-node runs, approves the firmware and erase gates, gets paged once for a validation "Unsupported OS Version" (shown verbatim with the heal path), and by evening four Arc-registered clusters are live on the monitoring dashboard — with the client having watched theirs happen.

---

## What It Is NOT

- **Not a general CMDB.** It stores what a *run* needs — iDRAC inventory snapshots, run state, logs, outcomes. It is not the system of record for the hardware fleet, asset lifecycle, or warranty tracking.
- **Not a Microsoft portal replacement.** Azure Portal remains the authority for the tenant, subscriptions, Arc resources, and post-deploy Azure management. The console orchestrates the *deployment pipeline* and hands off; it does not mirror or wrap portal functionality.
- **Not multi-tenant SaaS in v1.** One deployment, one operator team, one Azure context. Client visibility is a read-only window, not a tenant. Multi-tenancy, per-client Azure contexts, and self-service are explicitly out of scope for v1.
- **Not a rewrite of the engine.** The bash stages, Redfish library, ISO builder, and recovery scripts remain the single source of deployment truth, usable standalone from a terminal. The console invokes them; it never forks their logic into JavaScript.
- **Not a firmware authoring or OS build tool.** It applies baselines and verified images; producing them is upstream work.
- **Not an unattended fire-and-forget system.** Intervention gates are a feature, not a gap: destructive steps (SystemErase, firmware flash) and expensive steps (ECE deploy) pause for a human by design, per-run configuration deciding which.

---

## Relationship to the Luca Express Platform

The console follows platform engineering rules — vanilla JS + fetch UI (no React), `{ok:true,...}|{ok:false,error}` response shape, `esc()` on all rendered content, auth on all data routes, capability checks on mutations, parameterized SQL, files < 300 lines — but it is **standalone-deployable**: its own SQLite run store and REST API, its own Dockerfile and k8s manifests (Deployment + Service + Ingress) targeting the `luca-capacity` AKS-Arc cluster, secrets via k8s Secret. It shares the platform's discipline without depending on the platform's runtime — because it must work where it lives: on-prem, next to the iron it deploys.
