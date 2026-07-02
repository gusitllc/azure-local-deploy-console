# DB-DATA-EXCELLENCE — Azure Local Deployment Console

> Blueprint 9 of 14. Postgres schema discipline, migrations, integrity, isolation, retention.

## Engine

**Postgres** (schema `console`), accessed via a `pg` Pool in `lib/db.js`. Chosen over SQLite because
the console runs on AKS (pods reschedule; a file DB on a PVC is a single-point + poor concurrency),
and because `LISTEN/NOTIFY` gives cross-connection SSE fanout for free. Interface is facade-shaped so
a later move onto the Luca platform DB is a migration, not a rewrite.

## Rules (inherited platform standards, enforced here)

- **Parameterized only** — every query uses `$1,$2…`; never string concatenation. A lint check bans
  template-literal SQL with interpolation.
- **Transactions for multi-row invariants** — run creation (server lock + phases + steps + first
  event) is one transaction; a partial run can never exist.
- **JSONB** for `config_json`, `gates_json`, `fw_json`, `capabilities_json` — queryable, typed.
- **Timestamps** `timestamptz`, default `now()`; all durations derived, never stored twice.
- **No secrets in the DB** — `servers.cred_ref` is a *handle* into the worker's key store, never a
  password; `runs.error_verbatim` is secret-scrubbed before insert (fail-closed redaction).

## Integrity constraints

| Invariant | Mechanism |
| --- | --- |
| One active run per server | partial unique index: `CREATE UNIQUE INDEX ON servers(locked_by_run_id) WHERE locked_by_run_id IS NOT NULL` — set/cleared inside the run transaction |
| A phase belongs to a run; a step to a phase | FK `ON DELETE CASCADE` |
| Event ordering | `events.id` bigserial monotonic; SSE resumes from `Last-Event-ID` |
| Order↔run↔worker 1:1 lifecycle | FKs + status enums; a worker is destroyed only after its run leaves `running` |
| Enum discipline | CHECK constraints on `status` columns (`pending|running|awaiting-approval|failed|succeeded|skipped`) |

## Migrations

Ordered SQL files under `console/migrations/NNN_*.sql`, applied on boot by `lib/db.js` inside a
transaction, recorded in `console.schema_migrations`. **Additive/backward-compatible within a minor**
(add columns/tables, never destructive in a rollout) so `rollout undo` is always safe. A migration
that must drop/rename ships across two releases (expand → migrate → contract).

## Data classification & retention

| Data | Class | Retention |
| --- | --- | --- |
| Run/phase/step state, events | operational | keep; prune events > 180d to cold storage |
| Raw stage logs (`/data/runs`) | operational (secret-scrubbed) | 90d on PVC, then excerpt-only in DB |
| Customer email / order | PII / billing | keep per finance policy; deletable on request |
| Secret **refs** | pointer only | tied to worker lifecycle; refs meaningless after worker destroyed |
| Secret **values** | never stored | live only in the worker key store |

## Backup / recovery

CloudNativePG (or Azure Postgres) automated backup + PITR. The DB holds *history and coordination*,
not live metal — a lost DB doesn't lose a cluster; an in-flight run is resumable from the worker's
on-disk run state on re-enroll. Log-tree PVC is snapshotted; excerpts also live in `events`.

## Query hygiene

- Hot paths (`runs` list, `events` tail per run) are indexed (`events(run_id,id)`,
  `runs(status)`, `steps(phase_id,idx)`).
- No N+1 in the run-detail read: one query joins phases+steps; events stream separately via SSE.
- `EXPLAIN`-checked before any query touches a growing table in a loop.