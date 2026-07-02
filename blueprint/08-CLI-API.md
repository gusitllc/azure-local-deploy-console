# CLI-API — Azure Local Deployment Console

> Blueprint 8 of 14. The REST + SSE surface, the worker-agent protocol, and the engine command
> contract. All responses `{ok:true,…}` | `{ok:false,error}`. All `/api` behind `requireAuth` except
> where marked *(allowlisted)*; mutations behind `requireCapability`.

## Auth & health

| Method · Path | Cap | Body / notes |
| --- | --- | --- |
| `POST /api/auth/login` *(allowlisted)* | — | `{username,password}` → httpOnly session cookie |
| `POST /api/auth/logout` | any | clears session |
| `GET /api/health` *(allowlisted)* | — | `{ok,db,migration,activeRuns,workers,diskFreePct,factoryCommit}` |

Bootstrap: header `x-admin-key` (from k8s Secret) grants full capabilities to create operators.

## Servers & firmware (Phase 1)

| Method · Path | Cap | Purpose |
| --- | --- | --- |
| `POST /api/servers` | `deploy:servers:write` | register `[{idrac_ip,idrac_user,cred_ref}]` (cred_ref = worker key-store handle) |
| `GET /api/servers` | `deploy:servers:read` | list (no secrets) |
| `POST /api/servers/inventory` | `deploy:servers:write` | fan-out `rf_reachable/rf_sysinfo/rf_health/rf_serial/rf_bios/rf_storage_count`; upsert |
| `POST /api/servers/:id/firmware/plan` | `deploy:servers:write` | `fw-compare.js` + `fw-plan.js` vs per-model catalog → plan |
| `POST /api/servers/:id/firmware/apply` | `deploy:runs:approve` | Redfish SimpleUpdate (DUP over run-local HTTP) — **gated** |

## Clusters

| Method · Path | Cap | Purpose |
| --- | --- | --- |
| `POST /api/clusters` · `PUT /api/clusters/:id` | `deploy:clusters:write` | cluster config (validated vs. the engine's config schema) |
| `GET /api/clusters` · `GET /api/clusters/:id` | `deploy:clusters:read` | list / detail |

## Runs (the state machine)

| Method · Path | Cap | Purpose |
| --- | --- | --- |
| `POST /api/runs` | `deploy:runs:write` | `{cluster_id,server_ids[],gates,phase_from,phase_to}` → run (rejects if a server is locked) |
| `GET /api/runs` · `GET /api/runs/:id` | `deploy:runs:read` | list / detail (phases+steps tree) |
| `GET /api/runs/:id/events` | `deploy:runs:read` | **SSE**: `state`, `log`, `gate`, `error` events; resume via `Last-Event-ID` |
| `GET /api/runs/:id/steps/:sid/log` | `deploy:runs:read` | full log (range-capable) |
| `POST /api/runs/:id/approve` · `/reject` | `deploy:runs:approve` | release/deny a gate `{note}` |
| `POST /api/runs/:id/halt` | `deploy:runs:approve` | kill current step, hold run |
| `POST /api/runs/:id/retry` | `deploy:runs:write` | resume at failed step |
| `POST /api/runs/:id/steps/:sid/skip` | `deploy:runs:override` | skip `{reason}` (audited) |
| `POST /api/runs/:id/heal/:hook` | `deploy:runs:write` | fire a heal (`ext-sync`, `erase-unstick`, `az-relogin`) |
| `GET /api/runs/:id/screenshot/:serverId` | `deploy:runs:read` | live `rf_screenshot` PNG |

## Billing (Stripe)

| Method · Path | Cap | Purpose |
| --- | --- | --- |
| `POST /api/billing/webhook` *(Stripe-signed)* | — | `checkout.session.completed` → verify sig → order + run → provision worker |
| `GET /api/orders/:id` | `deploy:settings:admin` | order status |

## Admin

| Method · Path | Cap | Purpose |
| --- | --- | --- |
| `GET/PUT /api/settings` | `deploy:settings:admin` | factory_commit, gates default, parallelism, retry policy |
| `POST/GET/DELETE /api/operators` | `deploy:settings:admin` | operator CRUD |
| `GET /api/audit` | `deploy:settings:admin` | approve/skip/halt actor trail |

## SSE event shape

```
id: <event.id>            # for Last-Event-ID resume
event: state|log|gate|error
data: {"runId":N,"phase":3,"stepId":M,"level":"info","message":"…","status":"running"}
```

## Worker-agent protocol (console ⇄ worker, mTLS)

| Direction | Message | Notes |
| --- | --- | --- |
| agent → console | `POST /api/workers/enroll {token}` | one-time enroll token → mTLS cert + worker id |
| agent → console | `POST /api/workers/:id/heartbeat {vpn_verified,idrac_reach[]}` | liveness + reachability |
| console → agent | `JOB {runId,phaseIdx,stepIdx,stageCmd,env,secretRefs[]}` | env carries **non-secret** config only |
| agent → console | `EVENT {runId,stepId,type,level,message}` (stream) | log lines + step state; **redacted** |
| agent → console | `RESULT {runId,stepId,exitCode,errorExcerpt,errorVerbatim}` | exit → state; RP text verbatim |
| console → agent | `HALT {runId}` | kill current step process group |
| console → agent | `DESTROY` | tear down worker at hand-off |

**Secret refs, not values.** The console sends handles; the agent resolves them from its DPAPI/Key
Vault store. No customer secret value ever reaches the console.

## Engine command contract (what the agent runs)

Stages are invoked in the worker's `engine/` with a synthesized environment equivalent to the
engine's `config.env` (the adapter provides every `: "${VAR:?}"` the stage requires) plus
`RUN_DIR`, `ISO_PORT`, `AZURE_CONFIG_DIR`, `EXPECTED_OS_BUILD`. Exit-code contract:
`0`→succeeded; nonzero→failed (after retries); killed→failed(halted); per-step timeout→failed(timeout);
a heal-signalling exit (e.g. validate ext-version mismatch)→`failed(healable:ext-sync)`. See DESIGN §6
for the phase→stage matrix.

## Error shape

```json
{ "ok": false, "error": "human message", "verbatim": "raw RP/ARM text (secret-scrubbed)" }
```
`verbatim` is present on validation/deploy failures so the operator sees exactly what the cloud said.
