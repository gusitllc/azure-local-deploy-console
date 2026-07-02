# Blueprint — Azure Local Deployment Console

The 14-document formation blueprint (authored, not delegated). Read in order.

| # | Document | Covers |
|---|---|---|
| 01 | [CORE-IDEA](01-CORE-IDEA.md) | one-page essence: the $200 deployment service |
| 02 | [PURPOSE](02-PURPOSE.md) | what/why/who, success, scope |
| 03 | [DESIGN](03-DESIGN.md) | console↔worker topology, Postgres model, state machine, phase→stage matrix |
| 04 | [COST-MODEL](04-COST-MODEL.md) | $200 unit economics, COGS, break-even |
| 05 | [IMPLEMENTATION-PLAN](05-IMPLEMENTATION-PLAN.md) | P0–P5, roster, stage-gates, E2E, sign-off |
| 06 | [DEPLOYMENT](06-DEPLOYMENT.md) | console→AKS, Postgres, worker golden image, Stripe, DNS |
| 07 | [IMPLEMENTATION-TRACKER](07-IMPLEMENTATION-TRACKER.csv) | one row per step |
| 08 | [CLI-API](08-CLI-API.md) | REST + SSE + worker-agent protocol + engine contract |
| 09 | [DB-DATA-EXCELLENCE](09-DB-DATA-EXCELLENCE.md) | Postgres schema, migrations, integrity |
| 10 | [SECURITY-PRIVACY-EXCELLENCE](10-SECURITY-PRIVACY-EXCELLENCE.md) | secret boundary, RBAC, mTLS, destructive safety |
| 11 | [RELIABILITY-OBSERVABILITY-EXCELLENCE](11-RELIABILITY-OBSERVABILITY-EXCELLENCE.md) | resumability, heals, live observability |
| 12 | [PERFORMANCE-SCALE-EXCELLENCE](12-PERFORMANCE-SCALE-EXCELLENCE.md) | parallel runs, per-worker isolation |
| 13 | [TEST-QUALITY-EXCELLENCE](13-TEST-QUALITY-EXCELLENCE.md) | test pyramid, E2E acceptance gate |
| 14 | [UI-UX-EXCELLENCE](14-UI-UX-EXCELLENCE.md) | admin board, gate UX, live logs |

**Product:** azurestack.nyc → $200/cluster → charge → spin a per-customer **Windows worker
devstation** (pre-staged golden image: Claude Code + customer OAuth token, VPN client to their iDRAC
network, engine + toolchain) → the **console** (AKS, Postgres) drives **5 gated phases** → running
cluster, watched live → worker torn down. Engine: [azure-local-2node-factory](https://github.com/gusitllc/azure-local-2node-factory).
