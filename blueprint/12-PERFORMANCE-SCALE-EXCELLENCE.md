# PERFORMANCE-SCALE-EXCELLENCE — Azure Local Deployment Console

> Blueprint 12 of 14. How the console runs many clusters at once without contention, and where the
> real costs are (wall-clock, not CPU).

## The scaling axis is parallel runs, not request throughput

The console serves a handful of operators — request load is trivial. The scaling challenge is
**concurrent multi-hour deployments** that touch shared, stateful, easily-collided resources
(iDRAC media servers, `az` token caches, engine working trees). The architecture makes collisions
**structurally impossible** by giving every run its own worker.

## Isolation = one worker per run

| Shared-state hazard (if run in one process) | How per-worker isolation removes it |
| --- | --- |
| `az account set` is global (`~/.azure`) — run B changes run A's subscription | each worker has its own `AZURE_CONFIG_DIR` |
| `serve-iso.js` binds one port; stage 20 force-kills whatever holds it | each worker binds its own port from `iso_port_range` |
| Stages write back into the engine root | each worker runs a per-run **copy** of `engine/` |
| iDRAC virtual media is single-URI per node | different runs target different nodes on different VPNs |
| WinRM/TrustedHosts, ISO cache | per-worker filesystem |

These are exactly the PhD-review blockers (F1/F3/F4) — resolved by design, not by locking.

## Console-side concurrency

- **Scheduler** admits up to `max_parallel_runs` (default 3, configurable) concurrent `running` runs;
  the rest wait in `pending`.
- **Server lock** (partial unique index) guarantees a server is in exactly one active run — enforced
  in the run-creation transaction, race-free under Postgres WAL.
- **SSE fanout** via `LISTEN/NOTIFY` scales to many watchers per run and lets the console run >1
  replica later without sticky sessions.
- **Non-blocking**: all stage execution is on the workers; the console pod does I/O-bound
  coordination only — a single small pod handles dozens of concurrent runs' event streams.

## Wall-clock budget (where time actually goes)

| Phase | Typical wall-clock | Notes |
| --- | --- | --- |
| 1 iDRAC Prep | 5–30 min | firmware apply dominates if needed |
| 2 Node Build | 40–70 min | wipe + image + OS specialize; parallel across the 2 nodes |
| 3 Arc + Azure | 20–40 min | onboard + 4 extensions provisioning |
| 4 Validation | 10–20 min | + heal loops on ext drift |
| 5 Deploy | **2.5–3 h** | ECE ~55 steps — the dominant cost; a *gate*, never auto-retried |

Throughput scales with **worker count**, not console CPU: 10 parallel workers ≈ 10 clusters in the
time of one.

## Efficiency measures

- **Image cache** on the worker (or a shared read-only PVC) — OS ISOs pulled once, reused across
  runs; ISO **extraction** (pycdlib) and **combined-ISO build** are per-run but cache the base tree.
- **serve-iso range GET** + `imagePullPolicy: IfNotPresent`-style pre-pull so the cold ~30–65 min
  media pull happens before the maintenance-sensitive window (engine lesson).
- **Poll, don't spin**: OS-wait and Deploy tracking poll at sane intervals; SSE pushes, browser
  doesn't poll.
- **Log tiering**: raw logs to PVC files; DB stores excerpts + paths (no multi-MB rows).

## Limits & headroom (v1)

- `max_parallel_runs` bounded by available worker capacity (cloud VM quota or on-prem Hyper-V hosts),
  not by the console.
- One Postgres small instance handles v1 volume comfortably (coordination writes are low-rate).
- **Bottleneck is worker provisioning + the 3 h Deploy**, both external to the console — the console
  itself is far from any performance limit.

## Load posture

The console is designed to be *boring* under load: I/O-bound coordination, everything heavy pushed to
isolated workers, structural anti-collision instead of runtime locking. Scale is a matter of
provisioning more workers, which is a cost/quota decision, not an engineering one.