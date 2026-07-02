# console

The AKS container app (Linux) — the product's control tower. Stateless Node/Express + SQLite run
state, SSE live logs, and a vanilla-JS admin page. It owns the UI, API, run state machine, and
intervention gates, and **dispatches phases to Windows worker devstations** (it does not run the
engine itself — the engine's ISO builder is Windows-only).

See `../docs/DESIGN.md` for the state machine, data model, and API surface, and
`../docs/IMPLEMENTATION-PLAN.md` for the P0–P5 build plan.

## Runs on
`luca-capacity` AKS-Arc (on-prem). One Deployment + Service + Ingress (`console.azurestack.nyc`),
SQLite on a PVC, secrets via k8s Secret. Build: `az acr build -r lucaexpressacr -t azlocal-console:VERSION`.
