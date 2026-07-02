# DEPLOYMENT — Azure Local Deployment Console

> Blueprint 6 of 14. The full runbook: console image → AKS, Postgres, worker golden image, Stripe,
> DNS/TLS, verify, rollback, backup.

## Components to deploy

1. **Console container** → `luca-capacity` AKS-Arc (namespace `azlocal-console`).
2. **Postgres** → on-prem CloudNativePG *or* Azure Postgres Flexible (B1ms) — schema `console`.
3. **Worker golden image** → built by `worker/prestage/stage-worker.ps1`, snapshotted; provisioned
   per customer on payment.
4. **Site** → azurestack.nyc (Cloudflare Pages) with the `$200` sign-up + Stripe function (already
   live; source moving into `site/`).

## 1. Console image

```bash
# from console/
az acr build -r lucaexpressacr -t azlocal-console:1.0.0 -f Dockerfile .
```

Dockerfile: `node:22-slim`, `npm ci --omit=dev`, copy app + vendored site pages, non-root user,
`HEALTHCHECK` → `/api/health`, `CMD ["node","server.js"]`. No Windows tooling in the console image —
the engine runs on the worker, not here.

## 2. Postgres

```sql
CREATE DATABASE azlocal_console;
CREATE SCHEMA console;              -- lib/db.js runs ordered migrations on boot
```

Connection via `DATABASE_URL` (k8s Secret). WAL + PITR backup (CloudNativePG) or Azure automated
backup. `console.settings` seeded on first migration (`factory_commit`, `iso_port_range`,
`max_parallel_runs=3`, `default_gates`, `retry_policy`).

## 3. Kubernetes (namespace `azlocal-console`)

```yaml
# Deployment: 1 replica (SSE affinity via LISTEN/NOTIFY makes >1 safe later), resource limits,
#   env from Secret (DATABASE_URL, ADMIN_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
#   PROVISIONER_CREDS), readiness/liveness -> /api/health, PVC for /data/runs log tree.
# Service: ClusterIP :3000
# Ingress (ingress-nginx + cert-manager): console.azurestack.nyc -> Service, TLS via letsencrypt.
```

The console does **not** need `hostNetwork` or L2 iDRAC reach — that lives on the worker. The console
only needs: ingress (HTTPS in), Postgres (out), the worker channel (mTLS out/in), Stripe webhook (in),
and the provisioner cloud API (out).

```bash
KUBECONFIG=E:/tmp/luca-capacity.kubeconfig
kubectl create ns azlocal-console
kubectl -n azlocal-console apply -f k8s/secret.example.yaml   # after filling real values
kubectl -n azlocal-console apply -f k8s/deployment.yaml -f k8s/service.yaml -f k8s/ingress.yaml
kubectl -n azlocal-console set image deploy/azlocal-console app=lucaexpressacr.azurecr.io/azlocal-console:1.0.0
kubectl -n azlocal-console rollout status deploy/azlocal-console --timeout=300s
```

## 4. Worker golden image

```powershell
# on a clean Windows Server 2022 / Win 11 base VM:
./worker/prestage/stage-worker.ps1 -EngineRef <pinned-commit>
# validate:
Get-Content C:\worker\prestage.json          # tools + modules present
wimlib-imagex --version ; az version ; node -v ; python -c "import pycdlib"
claude --version                              # Claude Code CLI present (token supplied at runtime)
# generalize + capture as the golden image:
sysprep /generalize /oobe /shutdown           # then snapshot / capture-image in your cloud/Hyper-V
```

Store the golden-image id in `console.settings.worker_image_ref`. `provision.js` clones it per order.

## 5. Stripe

- **Product/price:** $200 one-time, quantity = clusters.
- **Site checkout:** `functions/api/deploy-signup.js` (Cloudflare Pages) creates the Checkout Session.
- **Webhook:** `POST https://console.azurestack.nyc/api/billing/webhook` for
  `checkout.session.completed` → verify signature (`STRIPE_WEBHOOK_SECRET`) → create order + run →
  `provision.js`. **Never** store card data; Stripe holds it.

## 6. DNS / TLS

| Host | Target |
| --- | --- |
| `azurestack.nyc`, `www` | Cloudflare Pages (site) |
| `console.azurestack.nyc` | AKS ingress (LB/tunnel), cert-manager TLS |

## 7. Verify (smoke)

```bash
curl -fsS https://console.azurestack.nyc/api/health | jq        # ok:true, db rw, migration vN
# admin creates an operator (x-admin-key), operator logs in, registers 2 iDRAC IPs,
# runs Phase-1 inventory against a real pair -> model/serial/health populate, logs stream.
```

## 8. Rollback

- Console: `kubectl rollout undo deploy/azlocal-console` (image is stateless; DB migrations are
  additive/backward-compatible within a minor).
- Worker: workers are ephemeral — a bad golden image is fixed by re-running `stage-worker.ps1` +
  re-snapshot and bumping `worker_image_ref`; in-flight workers finish or are destroyed + re-run.

## 9. Backup / DR

- **Postgres**: automated backup + PITR; it holds all run state. Losing it loses history, not live
  metal (runs are resumable from the worker's on-disk state on re-enroll).
- **Log tree** (`/data/runs`): PVC snapshot; excerpts are also in Postgres `events`.
- **Golden image**: versioned in the cloud image gallery; `stage-worker.ps1` reproduces it from
  scratch.

## 10. Change-management closure

Per the platform mandate, the app is "done" only after: change-management entry → release-tracker
register → `az acr build` → deploy (this runbook) → `record-deploy` → verify live → the E2E
acceptance run (blueprint 5) passes → IMPLEMENTATION-TRACKER updated to the released state.