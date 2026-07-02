# Azure Local Deployment Console — Cost Model

> Bottom-up cost/impact model for the console that wraps the proven `azure-local-2node-factory` engine (bash stages 00–60 + Redfish lib) in a multi-run, gated, operator-facing pipeline UI on the on-prem `luca-capacity` AKS-Arc cluster. Read alongside [DESIGN.md](DESIGN.md) and [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md). Azure list prices are planning figures **flagged for validation** in §7. There are **no LLM/token costs** at launch — the console has no AI features (if any are added later they route via `token-engine.js` per Golden Rule 1 and get costed then).

---

## 1. Cost Posture at a Glance

| Bucket | One-time | Steady-state | Per cluster deployment | Confidence |
| --- | --- | --- | --- | --- |
| Build (AI-agent hours) | ~94 agent-hours (≈$190–380 API-equivalent; seats are sunk) | — | — | Medium |
| Console infrastructure | — | **< $3/month** | ≈ $0 | High |
| Azure resources created by a run | — | < $0.10/mo per cluster (KV + witness) | **< $0.25** | High |
| Deployed cluster (customer-borne) | — | ~$320/mo list (2×16 cores) or $0 w/ AHB / 60-day trial | — | Medium |
| Risk reserve (RP gates, hardware variance) | — | ~$100/mo support plan during active engagement months | 4–16 agent-hours per incident | Medium |

The structural story: **near-zero marginal cost to serve** riding on sunk on-prem hardware and an already-proven engine, against **per-engagement services revenue**. Every dollar of build cost is amortized across all future azurestack.nyc engagements.

---

## 2. Infrastructure Cost (steady-state)

One pod, single image, on hardware we already own and power.

| Component | Detail | Monthly |
| --- | --- | --- |
| Compute | 1 pod (requests 250m CPU / 512Mi, limits 1 CPU / 2Gi) on `luca-capacity` AKS-Arc (fl-1xa2-2node). Nodes are sunk cost (owned hardware, already powered for other workloads). Marginal = electricity share. | **< $2** |
| ACR storage | Image ~1.5–2 GB (node:22 + az CLI + python/pycdlib + wimlib); retain 3–4 tags ≈ 6–8 GB at ~$0.10/GB/mo on `lucaexpressacr` | **< $1** |
| PVC (local-path) | SQLite run DB + structured logs + ISO workspace (combined ISOs are multi-GB; budget 100 GB). On-prem disk, sunk. | **$0** |
| Egress | Admin UI + SSE log streams to operator browsers via tunnel: < 1 GB/mo. ISO serving to iDRAC virtual media is **pure LAN (L2)** — multi-GB per run, zero cloud egress. | **≈ $0** |
| TLS/ingress | cert-manager + ingress-nginx already live on `luca-capacity` | $0 |
| **Total** | | **< $3/month** |

Serving the azurestack.nyc public pages from the same pod displaces nothing — those pages exist anyway; consolidating them here is cost-neutral.

---

## 3. Build Cost by Phase (AI-agent hours)

Estimates assume Opus 4.8-tier coder personas on existing devstation seats. The engine is **not** being built — it exists and is field-proven; the console is a wrapper + UI + state machine, which caps the estimate.

| # | Work package | Scope | Agent-hours |
| --- | --- | --- | --- |
| B1 | **Backend state machine + run store** | SQLite schema (runs, phases, stages, gates, log index), migrations, REST API (`{ok:true,...}` shape, parameterized SQL), SSE log/status streams, parallel-run scheduler (independent pipeline runs, per-run workdirs) | 18 |
| B2 | **Engine adapter** | Child-process runner for stages 00–60, structured log capture/parse, exit-code → state mapping, artifact registry (ISOs, ARM params, screenshots), resume/heal hooks (recover.sh, ext-sync), verbatim RP-error surfacing, halt-anywhere | 16 |
| B3 | **Admin UI** | Runs board (N parallel runs), new-run wizard (multi-server iDRAC IP entry), per-run phase timeline, **intervention-gate approve/hold controls (configurable per run)**, live SSE log viewer, dark-gold azurestack.nyc theme, vanilla JS + `esc()` throughout | 18 |
| B4 | **Phase-1 firmware prep** | Redfish inventory fan-out (model/serial/health), firmware baseline compare, SimpleUpdate plan preview + gated apply, per-server progress + screenshots | 14 |
| B5 | **Auth + secrets** | Session auth on all data routes, capability checks on every mutation (start/approve/halt/firmware-apply), k8s Secret / KV wiring, log redaction (secrets never in code or logs) | 8 |
| B6 | **Packaging + deploy** | Dockerfile (node + az + wimlib + python), k8s Deployment/Service/Ingress for `luca-capacity`, DEPLOYMENT.md runbook execution | 6 |
| B7 | **E2E test + hardening** | Full dry run against lab iDRACs (inventory → ISO verify → gate flow), failure-injection (dead iDRAC, RP reject, wim mismatch), file-size/lint compliance pass | 14 |
| | **Total** | | **≈ 94 agent-hours** |

- **> 40 hours ⇒ the App/Big-Task Formation mandate applies** — this document is one of the seven required artifacts; no code before the suite is complete.
- **Dollarized:** devstation Claude seats are already paid (per-human-seat compliance), so marginal cash cost ≈ $0. At API-metered equivalence (~$2–4/agent-hour observed on comparable builds) the notional cost is **$190–380**.
- **Calendar:** ~3–4 working days with 3 personas in parallel (B1‖B3‖B4 after a shared contract day).

---

## 4. Operational Cost per Cluster Deployment

### 4a. Console-side (our cost per run)

| Item | Cost |
| --- | --- |
| Pipeline compute (stage child processes, ISO build, ~3 h ECE monitoring loop) | ≈ $0 (on-prem pod) |
| ISO workspace (~10–20 GB transient per run) | $0 (local PVC, reclaimed post-run) |
| SSE streaming to operators | ≈ $0 |
| **Total per run** | **≈ $0** |

### 4b. Azure resources the run creates (engagement subscription)

| Resource | Notes | Cost |
| --- | --- | --- |
| Service principals, RP registrations, resource group ("zone") | Free objects | $0 |
| Key Vault (standard) + 3 deployment secrets | No base fee; per-10k-operations pricing; a full deploy uses a few thousand ops | < $0.05/run |
| Witness storage account (LRS blob, cloud witness) | Pennies of blob + transactions | < $0.05/mo |
| Arc onboard + 4 AzureEdge extensions | Included with Azure Local | $0 |
| edge validate + deploymentSettings/ARM Validate + ECE deploy | Executes **on the nodes** — no cloud compute billed | $0 |
| **Total Azure cost attributable to the deployment process** | | **< $0.25 per run** |

### 4c. Deployed cluster running cost (customer-borne — quote transparently)

| Item | Basis | Monthly (2-node, 16 cores/node) |
| --- | --- | --- |
| Azure Local host fee | ~$10/physical core/month list; **$0 during 60-day trial; $0 with Azure Hybrid Benefit** (WS Datacenter + SA) | ~$320 or $0 |
| Windows Server guest licensing add-on | Optional subscription add-on, per physical core — **validate current list price at quote time** | optional |
| Insights / Log Analytics (post-deploy monitoring dashboard) | ~$2–3/GB ingested; basic 2-node telemetry ≈ 1–3 GB/mo | $3–9 |

These are pass-through costs in the engagement quote, not console costs — but the console's Phase-5 dashboard makes them visible, which is itself a sales asset.

---

## 5. Risk Costs

| Risk | Trigger (observed) | Cost when it fires | Mitigation baked into build |
| --- | --- | --- | --- |
| **MSFT RP gate changes** | "Unsupported OS Version" rejected GA builds this week (MSFT-side gate reading edge inventory processorType/osProfile) | 1–5 day engagement stall; 4–16 agent-hours triage; MSFT support case | Console surfaces RP errors **verbatim**, halt-at-any-phase, heal paths (ext-sync) as one-click stage re-runs |
| Azure support plan | Needed to file RP cases with teeth | **Standard plan $100/mo**, kept active only during engagement months | Toggle per engagement; cost passed into engagement price |
| **Hardware/firmware variance** | Broadcom NIC firmware gap = "no network" node (fixed OOB via iDRAC SimpleUpdate) | 2–6 agent-hours if it slips past prep | **Phase-1 firmware baseline exists precisely to absorb this** — prep cost is fixed, incident cost drops toward 0 |
| ISO/wim integrity | Wrong wim behind a right filename | A wasted 1–2 h imaging cycle per node | wim verification stage (never trust filenames), pycdlib extraction (no privileged mounts) |
| Single-replica console (SQLite = single-writer) | Pod eviction mid-run | Minutes of UI downtime; **runs are resumable** (state in SQLite on PVC + recover.sh) | Accepted; documented; not revenue-impacting |
| Secrets exposure | — | Reputational/engagement loss (unbounded) | KV/env only, log redaction, no secrets in code — controls are build-cost line B5, already counted |

**Planning reserve:** ~$100–150/engagement-month (support plan) + ~8 agent-hours/engagement contingency. The dominant uninsurable risk is the **RP gate** — it is external, changes without notice, and is exactly why the console must never hide or paraphrase RP responses.

---

## 6. Revenue Linkage

The console is not a product sold standalone — **console access is part of paid azurestack.nyc engagements**.

| Lever | Effect |
| --- | --- |
| **Engagement bundling** | Each Azure Local deployment engagement includes console access for the customer's operators: live phase tracking, gate approvals, verbatim errors. Transparency is the differentiator vs. black-box PS firms. |
| **Margin** | Cost to serve a deployment ≈ **< $25 all-in** (console ≈ $0, Azure < $0.25, support-plan share + contingency). Comparable manual professional-services deploys price in the **$15k–30k/cluster** range; even an aggressive automated fixed fee retains ~99% gross margin on delivery cost. Owner sets final pricing. |
| **Parallel runs = capacity multiplier** | The multi-run scheduler is the revenue feature: N simultaneous cluster deployments per operator, so engagement throughput scales **without headcount**. Each incremental engagement's marginal delivery cost is ≈ $0. |
| **Post-deploy monitoring → recurring upsell** | The Phase-5 dashboard is the natural bridge from one-time deployment fees to a recurring managed-operations line (monitoring, firmware lifecycle via Phase-1 tooling re-run on live fleets — same Redfish adapter, zero extra build). |
| **Public engine, private console** | The factory repo is public (credibility/lead-gen); the console — gates, parallelism, firmware orchestration, dashboards — is the paid layer. The moat is the operational wrapper, not the scripts. |

**Break-even:** at ~94 agent-hours (seats sunk) and < $3/mo to run, the console pays for itself inside the **first single engagement** it accelerates or wins.

---

## 7. Assumptions to Validate

1. **Azure Local per-core fee and Windows Server add-on** — confirm current list prices at first customer quote; AHB eligibility per customer.
2. **Support plan tier** — Standard ($100/mo) assumed sufficient for RP-gate cases; upgrade to ProDirect only if MSFT response times stall engagements.
3. **Agent-hour dollarization** — $2–4/hr API-equivalent is an internal observation; irrelevant to cash while seats are per-human, but recheck if metering changes.
4. **ISO workspace sizing** — 100 GB PVC assumed; confirm against real combined-ISO retention policy (keep last N runs vs. rebuild-on-demand).
5. **Engagement pricing** — owner decision; this model only establishes the cost floor (≈ $0 marginal) and the market comparable ($15k–30k manual).
