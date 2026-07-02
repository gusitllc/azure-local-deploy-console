# CORE-IDEA — Azure Local Deployment Console

> Formation suite, artifact 1 of 7. Authoritative one-page essence of the
> Azure Local Deployment Console: a single-image container app on the on-prem
> AKS-Arc cluster (`luca-capacity`) that serves the azurestack.nyc site, its
> backend, and a new operator ADMIN PAGE that runs **many Azure Local cluster
> deployments in parallel** by wrapping the proven
> [azure-local-2node-factory](https://github.com/gusitllc/azure-local-2node-factory)
> engine.

## One-Sentence Essence

The Azure Local Deployment Console turns a week of expert, serial, terminal-bound
Azure Local cluster building into a supervised assembly line: operators paste
iDRAC IPs into a web page, and the console drives the proven factory engine —
firmware prep → bare-metal re-image → Arc onboarding + Azure prep → cloud
validation → the ~3-hour ECE deploy — **for multiple clusters at the same time**,
pausing at configurable intervention gates and surfacing every cloud error
verbatim.

## The Problem

Deploying an Azure Local (HCI) cluster today is **expert-heavy, serial, and
console-bound**. The factory engine already automates the mechanics (bash stages
00–60, Redfish iDRAC control, self-wiping WinPE ISOs, Arc onboarding, ARM
validation, ECE tracking), but running it still means:

1. **One expert, one terminal, one cluster.** Stages are launched by hand from a
   shell with the right env, secrets, network reach, and tribal knowledge. Two
   clusters means two experts or twice the calendar time — deployments do not
   parallelize because the *operator* is the bottleneck, not the engine.
2. **No supervised pause points.** A run either barrels ahead or the operator
   babysits the terminal to Ctrl-C at the right moment. There is no first-class
   "stop here, let a human check firmware/validation results, then continue."
3. **Failures are opaque and expensive.** This week's live deployment proved that
   the cloud side rejects nodes for reasons outside our control ("Unsupported OS
   Version" on GA builds — an open MSFT-side gate reading edge inventory). When
   the RP error is paraphrased or swallowed, hours are lost re-deriving what the
   cloud actually said. Recovery paths (ext-sync heals, recover.sh, rebuild) exist
   but only in the expert's head.
4. **No shared state or audit.** Which node is at stage 32? What firmware plan
   was applied? Who approved the wipe? Today the answer lives in scrollback.

## The Solution

A **multi-cluster pipeline console with intervention gates** that WRAPS the
factory engine — each pipeline run executes engine stages as child processes with
structured logs, persisted run state (SQLite), and live SSE streaming to the
admin page. Five phases, each independently startable, haltable, and resumable:

- **Phase 1 — iDRAC prep.** Operator enters many iDRAC IPs; the console
  inventories each server (model, serial, health) over Redfish and prepares
  firmware: baseline compare → update plan → apply via Redfish SimpleUpdate.
- **Phase 2 — Node build.** Hands-off bare-metal imaging: self-wiping WinPE
  combined ISOs mounted over iDRAC virtual media, then drivers, time/NTP, NIC
  IPs + Port1..4 naming, server names — the existing stages 18/20/30/32/35.
- **Phase 3 — Arc registration + all Azure prep.** Arc onboard + the 4 AzureEdge
  extensions; service principals, resource group/region, RP registration, Key
  Vault + the 3 deployment secrets, witness storage, the proven
  assign-deploy-permissions, ACR prep.
- **Phase 4 — Validation.** edge validate + deploymentSettings Validate / ARM
  template Validate, with the known heal paths (ext-sync etc.) offered as
  one-click remediations — and RP errors shown **verbatim**.
- **Phase 5 — Cluster creation + monitoring.** Deploy (~2.5–3h ECE) with live
  step tracking (track-deployment) and a post-deploy monitoring dashboard.

**Intervention gates** are configurable per run: any phase (or named stage
boundary) can be marked "pause for operator approval" — e.g. approve the firmware
plan before SimpleUpdate fires, approve the destructive wipe before Phase 2,
review validation output before committing 3 hours of ECE. Runs are independent
pipelines: three clusters can be at Phase 1, Phase 4, and mid-ECE simultaneously.

The console deploys as **one container image** on the on-prem AKS-Arc cluster
`luca-capacity` (fl-1xa2-2node), which has L2 reach to the iDRACs at 192.168.x —
so the deployer runtime (Redfish access, range-capable HTTP server for virtual
media, WinRM to node mgmt IPs, az CLI + SP creds, wimlib, node, python) lives
next to the metal it manages.

## What Makes It Different

- **Hands-off re-image over iDRAC.** No USB sticks, no crash carts, no KVM
  sessions: self-wiping combined ISOs over Redfish virtual media + one-time boot,
  with screenshots and SystemErase available from the same lib. A rack of servers
  is rebuilt from a browser.
- **Gate-based interventions, not babysitting.** The operator declares *where*
  human judgement is required per run; everywhere else the pipeline runs itself.
  Approval is an auditable click, not a well-timed Ctrl-C.
- **Parallel runs.** Each deployment is an independent pipeline with its own
  state, logs, and gates. Cluster throughput scales with hardware, not with
  expert headcount.
- **Verbatim cloud-error surfacing.** RP/validation failures are shown exactly as
  the cloud returned them (the "Unsupported OS Version" lesson) — never
  paraphrased — with the run haltable at any phase and known heal paths attached.
- **It wraps a proven, public engine.** The console adds orchestration, state,
  and UI on top of azure-local-2node-factory — the stages that deployed a real
  cluster this week — rather than re-implementing deployment logic in JavaScript.

## Non-Negotiables

1. **Secrets never leave Key Vault / env.** No SP credentials, iDRAC passwords,
   or deployment secrets in code, SQLite, structured logs, or SSE streams —
   k8s Secrets / KV references / env vars only, redacted at the log boundary.
2. **Every phase is resumable.** Run state is persisted per stage; a console
   restart, pod reschedule, or operator halt never forces a from-scratch rebuild.
   Halting a run at any phase is a first-class operation.
3. **The engine scripts remain the single source of truth.** The console
   orchestrates stages 00–60, lib/redfish.sh, build/, recover/ as child
   processes — it never forks, inlines, or re-implements their logic. Fixes land
   in the engine repo; the console picks them up.
4. **Destructive actions gate by default.** SystemErase, self-wiping ISO boot,
   and firmware apply ship with their intervention gates ON; an operator must
   explicitly configure them away per run.
5. **Cloud errors are shown verbatim.** No summarizing, no swallowing — the raw
   RP response is the primary artifact, with heal suggestions attached beside it.
6. **Platform rules apply even though it is standalone-deployable.** Auth on all
   data routes, capability checks on every mutation, `esc()` on all rendered
   content, parameterized SQL, response shape `{ok:true,…}` | `{ok:false,error}`,
   vanilla JS + fetch (no React), files < 300 lines, all behavior config-driven
   (env/Secret — zero hardcoded IPs, paths, or thresholds). Any future AI feature
   goes through `runChatCompletion`; the console's own SQLite state store keeps
   it independently deployable off-platform.
7. **Build artifacts are verified, never trusted.** ISO/WIM contents are checked
   (pycdlib extraction, wim verification) before a node boots them — filenames
   prove nothing.
