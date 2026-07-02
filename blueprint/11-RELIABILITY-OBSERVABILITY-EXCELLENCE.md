# RELIABILITY-OBSERVABILITY-EXCELLENCE — Azure Local Deployment Console

> Blueprint 11 of 14. Resumability, failure handling, heals, live observability. A deployment runs
> ~4–6 hours across flaky metal and a cloud that can dead-end — reliability is measured in *recovery*,
> not uptime.

## Resumability (the first-class property)

- **State is persisted per step**, not per run. A pod reschedule, worker reboot, or operator halt
  never restarts from zero: `retry` resumes **at the failed step**.
- **All engine stages are idempotent / re-runnable** by design (the engine's `recover.sh` covers
  mid-OS-install restarts; wipe/build/onboard/validate all re-enter cleanly).
- **Worker re-enrollment**: if a worker drops, it re-enrolls (mTLS), re-reads its on-disk run state,
  and the console reconciles — the run continues from the last durable step.
- **Console statelessness**: the pod holds no run state in memory that isn't in Postgres; two pods
  (later) coordinate via `LISTEN/NOTIFY` and the server-lock.

## Failure taxonomy & response

| Class | Example | Response |
| --- | --- | --- |
| **Transient** | flaky Redfish, ARM 429, ISO pull hiccup | retry with exponential backoff (Redfish 3×) |
| **Healable** | AzureEdge ext-version drift at Validate; wedged SystemErase; SP token expiry | registered heal hook → auto/one-click, then resume |
| **Hard, ours** | wrong config, missing prereq | fail with excerpt; operator fixes config, retries |
| **Hard, customer/MSFT** | network unreachable; RP "Unsupported OS Version" gate | **halt + hold**, error **verbatim**, escalate; never churn |
| **Destructive-blocked** | wipe/Deploy awaiting approval | gate; no action until approved |

## Registered heals (`lib/heal.js`)

- **ext-sync** — Phase-4 extension-version mismatch → run `lib/ext-version-sync.sh` (validator is the
  source of truth, pin exact versions, loop) → re-Validate.
- **erase-unstick** — wedged SystemErase → `rf_erase_unstick` (`DeleteJobQueue` + iDRAC reboot +
  re-trigger + force LC boot).
- **eject-retry** — stuck virtual media → re-eject/re-insert.
- **az-relogin** — SP token expiry mid-run → refresh from the worker key store, resume.

## Retry policy (`settings.retry_policy_json`)

Redfish 3× exp backoff · OS-wait is a *poll* not a retry (build-gated) · Validate 2× only *after* a
heal ran · **Deploy is never auto-retried** (always a gate) · every stage has a `timeout_s` (≈30 min
for stages, 4 h for Deploy) → `failed(timeout)` on breach.

## Observability

- **Live logs**: every stage line streams (SSE, `LISTEN/NOTIFY`) to the admin board and to the
  customer's run view — secret-redacted, resumable via `Last-Event-ID`.
- **Structured events**: `state | log | gate | error` with phase/step context; the append-only
  `events` table is the audit + replay source.
- **iDRAC screenshots**: `rf_screenshot` on demand — the only eyes into WinPE/Setup (no WinRM there);
  surfaced in the admin board for stuck installs.
- **Verbatim errors**: RP/ARM failure text stored to `runs.error_verbatim` and shown unparaphrased —
  the "Unsupported OS Version" lesson made this a hard requirement.
- **Health**: `/api/health` returns real metrics (db rw, migration version, active runs, worker
  count, disk-free) — never `{ok:true}` alone.
- **Progress**: Phase-5 Deploy parses `track-deployment.sh` into ~55 ECE step events → a real
  progress bar, not a spinner.

## SLOs (targets)

| SLO | Target |
| --- | --- |
| Clean run reaches a durable checkpoint without operator touch between gates | ≥ 95% |
| A halted run resumes to the correct step | 100% |
| No secret in any log/event (sampled audit) | 100% |
| Cloud/RP failures surfaced verbatim | 100% |
| Worker provisioned → `ready` after payment | ≤ 10 min (pre-staged image) |

## Alerting

Console `/api/health` scraped; alerts on: pod down, DB unreachable, a run stuck in `running` past its
step timeout, a worker unheard-from past heartbeat TTL, provisioning failures.