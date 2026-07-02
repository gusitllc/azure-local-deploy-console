# DEPLOYMENT.md — Azure Local Deployment Console

Runbook for building, deploying, verifying, rolling back, and backing up the **Azure Local Deployment Console** (`azlocal-console`) on the on-prem **luca-capacity** AKS-Arc cluster (fl-1xa2-2node).

| Item | Value |
|---|---|
| Image | `lucaexpressacr.azurecr.io/azlocal-console:VERSION` |
| Cluster | `luca-capacity` (AKS-Arc, on-prem) — API `https://192.168.1.165:6443` |
| Kubeconfig | `E:/tmp/luca-capacity.kubeconfig` (Git Bash: `/e/tmp/luca-capacity.kubeconfig`) |
| kubectl | `/c/Users/gus/.azure-kubectl/kubectl.exe` |
| Namespace | `azlocal-console` |
| Nodes | `moc-ld156yp8q2y` (192.168.1.171, control-plane), `moc-ln9ece0pv7t` (192.168.1.172) — **same L2 as server iDRACs (192.168.x)** |
| Ingress | ingress-nginx (**NodePort**: 80→30791, 443→31374 — no LoadBalancer on this cluster) |
| Public URL | `https://console.azurestack.nyc` via **Cloudflare tunnel** (primary path) |
| State | SQLite on an RWO PVC — **replicas MUST stay 1** (single-writer) |

> **Deploy window:** `console.azurestack.nyc` is a public production surface. Deploys follow the platform window — **8 PM–4 AM ET only** (break-glass for declared incidents). Register every release in release-tracker (`product: azlocal-console`).

---

## 0. Prerequisites (one-time, per workstation)

```bash
export KUBECONFIG=/e/tmp/luca-capacity.kubeconfig
alias kk='/c/Users/gus/.azure-kubectl/kubectl.exe'

# GUARD — never deploy this product to the cloud AKS (luca-dev):
kk config current-context
# MUST print: luca-capacity-eea30fe0-admin@luca-capacity-eea30fe0
```

- `az` CLI logged in with rights to `lucaexpressacr` (`az acr login -n lucaexpressacr` for local pulls).
- An ACR pull principal (service principal with `AcrPull` on `lucaexpressacr`) — the on-prem cluster has **no** AKS-managed-identity ACR attach; pulls require an `imagePullSecret`.
- Cloudflare: account `e9248b727e65b3282b4c6c71c5e6fee4`; tokens live in DB `provider_registry.provider_credentials` (`pages-ci` = deploy/domain-attach; `primary` = DNS edit). `azurestack.nyc` zone already exists (apex is Cloudflare Pages — the `console` subdomain does not conflict).

---

## 1. Build the container

The image bundles: Node 22 + express app, the **azure-local-2node-factory** engine (bash stages 00–60, `lib/redfish.sh`, `build/`, `recover/`), and engine runtime deps: `bash curl jq git openssl sqlite3 wimlib-imagex python3 (+pycdlib) az-cli pwsh (+PSWSMan for WinRM)`.

```bash
VERSION=1.0.0        # semver; bump every build — NEVER reuse a tag

# Local build + smoke (optional but recommended)
docker build -t azlocal-console:$VERSION .
docker run --rm -p 3000:3000 -e ADMIN_API_KEY=dev -e DB_PATH=/tmp/console.db azlocal-console:$VERSION &
curl -fsS http://localhost:3000/healthz   # expect {"ok":true,...}

# Canonical build → ACR (this is the deployable artifact)
az acr build -r lucaexpressacr -t azlocal-console:$VERSION -f Dockerfile .

# VERIFY THE TAG EXISTS BEFORE ANY set-image (phantom-tag outages are real):
az acr repository show-tags -n lucaexpressacr --repository azlocal-console -o tsv | grep -x "$VERSION"
```

---

## 2. Namespace + secrets

```bash
kk create namespace azlocal-console

# 2a. ACR pull secret (SP with AcrPull role)
kk create secret docker-registry acr-pull -n azlocal-console \
  --docker-server=lucaexpressacr.azurecr.io \
  --docker-username="$ACR_SP_APP_ID" \
  --docker-password="$ACR_SP_SECRET"

# 2b. App secrets — NEVER commit these; literals only, or --from-env-file from a
#     file OUTSIDE the repo. Keys land in the container as env vars.
kk create secret generic azlocal-console-secrets -n azlocal-console \
  --from-literal=ADMIN_API_KEY="$(openssl rand -hex 32)" \
  --from-literal=AZURE_TENANT_ID="..." \
  --from-literal=AZURE_CLIENT_ID="..." \
  --from-literal=AZURE_CLIENT_SECRET="..." \
  --from-literal=AZURE_SUBSCRIPTION_ID="..." \
  --from-literal=IDRAC_CRED_STORE_KEY="$(openssl rand -hex 32)"
```

- `ADMIN_API_KEY` — bearer key for the admin page/API (auth on all data routes).
- `AZURE_*` — the deployment SP used by Phase 3 (Arc onboard, RP registration, KV, witness, assign-deploy-permissions, ACR prep).
- `IDRAC_CRED_STORE_KEY` — AES-256 key encrypting iDRAC credentials at rest in SQLite. **Record it in the vault**: losing it orphans every stored iDRAC credential (rows are then useless; operators must re-enter).

Rotation: `kk create secret ... --dry-run=client -o yaml | kk apply -f -` then `kk rollout restart deployment/azlocal-console -n azlocal-console`.

---

## 3. Kubernetes manifests

Apply in this order. All manifests live in the console repo under `k8s/`.

### 3a. PVCs — `k8s/pvc.yaml`

Two volumes: small one for SQLite + run logs, big one for ISO build workspace + served virtual-media images (combined ISOs are 10–15 GB each; parallel runs multiply that). Omit `storageClassName` to take the cluster default (AKS-Arc `disk.csi.akshci`).

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: azlocal-console-data, namespace: azlocal-console }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 10Gi } }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: { name: azlocal-console-iso, namespace: azlocal-console }
spec:
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 200Gi } }
```

### 3b. Deployment — `k8s/deployment.yaml`

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: azlocal-console
  namespace: azlocal-console
  labels: { app: azlocal-console }
spec:
  replicas: 1                    # HARD LIMIT: SQLite single-writer + RWO PVCs
  strategy: { type: Recreate }   # RWO volumes cannot double-attach during rollout
  selector: { matchLabels: { app: azlocal-console } }
  template:
    metadata: { labels: { app: azlocal-console } }
    spec:
      imagePullSecrets: [{ name: acr-pull }]
      securityContext: { fsGroup: 1000 }
      containers:
        - name: azlocal-console
          image: lucaexpressacr.azurecr.io/azlocal-console:VERSION
          imagePullPolicy: IfNotPresent   # on-prem ACR pulls are flaky — never re-pull a cached tag
          ports:
            - { containerPort: 3000, name: http }    # web UI + API + SSE
            - { containerPort: 8080, name: media }   # range-capable HTTP for iDRAC virtual media
          env:
            - { name: NODE_ENV, value: production }
            - { name: PORT, value: "3000" }
            - { name: MEDIA_PORT, value: "8080" }
            - { name: DB_PATH, value: /data/console.db }
            - { name: ISO_DIR, value: /iso }
            # URL the iDRACs fetch virtual media FROM — must be a node IP + NodePort
            # (iDRACs cannot resolve/reach cluster-internal Service IPs). See §4.
            - { name: VIRTUAL_MEDIA_BASE_URL, value: "http://192.168.1.172:30808" }
          envFrom:
            - secretRef: { name: azlocal-console-secrets }
          resources:
            requests: { cpu: 500m, memory: 1Gi }
            limits:   { cpu: "2",  memory: 4Gi }   # bump to 4/8Gi if parallel ISO builds thrash
          readinessProbe:
            httpGet: { path: /healthz, port: 3000 }
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /healthz, port: 3000 }
            initialDelaySeconds: 30
            periodSeconds: 30
            failureThreshold: 4      # generous: liveness restarts kill in-flight 3h ECE runs
          volumeMounts:
            - { name: data, mountPath: /data }
            - { name: iso,  mountPath: /iso }
      volumes:
        - name: data
          persistentVolumeClaim: { claimName: azlocal-console-data }
        - name: iso
          persistentVolumeClaim: { claimName: azlocal-console-iso }
```

### 3c. Services — `k8s/service.yaml`

```yaml
apiVersion: v1
kind: Service
metadata: { name: azlocal-console, namespace: azlocal-console }
spec:
  selector: { app: azlocal-console }
  ports: [{ name: http, port: 80, targetPort: 3000 }]
---
# iDRAC-facing virtual-media endpoint. NodePort, because the iDRACs sit OUTSIDE
# the cluster network and can only reach node IPs on the 192.168.1.x L2.
apiVersion: v1
kind: Service
metadata: { name: azlocal-console-media, namespace: azlocal-console }
spec:
  type: NodePort
  selector: { app: azlocal-console }
  ports: [{ name: media, port: 8080, targetPort: 8080, nodePort: 30808 }]
```

### 3d. Ingress — `k8s/ingress.yaml`

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: azlocal-console
  namespace: azlocal-console
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-dns01
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"   # SSE log streams stay open
    nginx.ingress.kubernetes.io/proxy-buffering: "off"       # SSE must not buffer
    nginx.ingress.kubernetes.io/proxy-body-size: "20g"       # ISO uploads
spec:
  ingressClassName: nginx
  tls:
    - hosts: [console.azurestack.nyc]
      secretName: console-azurestack-nyc-tls
  rules:
    - host: console.azurestack.nyc
      http:
        paths:
          - path: /
            pathType: Prefix
            backend: { service: { name: azlocal-console, port: { number: 80 } } }
```

### 3e. cert-manager ClusterIssuer — `k8s/clusterissuer.yaml`

The cluster currently only has a `selfsigned` ClusterIssuer. The public cert path is **DNS-01 via Cloudflare** (HTTP-01 cannot work — no public IP reaches this cluster). Uses the `primary` Cloudflare token (DNS edit).

```bash
kk create secret generic cloudflare-api-token -n cert-manager \
  --from-literal=api-token="$CF_DNS_EDIT_TOKEN"
```

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata: { name: letsencrypt-dns01 }
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: gus@gusit.de
    privateKeySecretRef: { name: letsencrypt-dns01-account }
    solvers:
      - dns01:
          cloudflare:
            apiTokenSecretRef: { name: cloudflare-api-token, key: api-token }
```

> When traffic enters via the Cloudflare **tunnel** (§5), edge TLS is Cloudflare's; this cert covers direct-LAN HTTPS access (`https://192.168.1.171:31374` with SNI `console.azurestack.nyc`). Keep it — it is the tunnel-outage fallback path.

### Apply

```bash
kk apply -f k8s/pvc.yaml -f k8s/deployment.yaml -f k8s/service.yaml
kk apply -f k8s/clusterissuer.yaml -f k8s/ingress.yaml
kk -n azlocal-console rollout status deployment/azlocal-console --timeout=15m
```

---

## 4. iDRAC network reachability (READ THIS — deployments fail silently without it)

The engine needs **two directions** of connectivity:

1. **Pod → iDRACs (egress, Redfish HTTPS on 192.168.x).** Pod egress is SNAT'd through the node, and the nodes (192.168.1.171/.172) sit on the same L2 as the iDRACs — so plain pod networking works. **Verify before the first run** (§6). If your iDRACs are on a *different* 192.168.x subnet with no route from the nodes, either add the route on the nodes or set `hostNetwork: true` on the Deployment (then drop the media NodePort — the pod binds `MEDIA_PORT` directly on the node IP — and set `dnsPolicy: ClusterFirstWithHostNet`).

2. **iDRACs → pod (ingress, HTTP virtual media).** iDRACs mount WinPE ISOs from `VIRTUAL_MEDIA_BASE_URL`. They can only reach **node IPs**, never ClusterIP/Service DNS. Hence the NodePort 30808 service and `VIRTUAL_MEDIA_BASE_URL=http://192.168.1.172:30808`. The media server MUST support HTTP **Range** requests (iDRAC firmware streams ISOs with ranged GETs) — verify with the 206 check in §6. Plain HTTP is intentional: iDRAC virtual media over HTTPS chokes on private CAs.

   ⚠️ If node `192.168.1.172` is replaced/re-IP'd, virtual media breaks mid-run: update the env var and `rollout restart`. (Optional hardening: point `VIRTUAL_MEDIA_BASE_URL` at a keepalived VIP spanning both nodes.)

3. **Pod → node mgmt IPs (WinRM 5985/5986)** for the onboard-node.ps1 chain — same L2 story as (1); the image ships pwsh + PSWSMan.

---

## 5. DNS + public access (Cloudflare)

**Primary path — Cloudflare tunnel** (the cluster has no public IP; ingress-nginx is NodePort-only):

```bash
# 1. Create the tunnel (once) — dashboard (Zero Trust → Tunnels) or:
cloudflared tunnel create azlocal-console      # note TUNNEL_ID; grab the token

# 2. In-cluster connector
kk create secret generic cloudflared-token -n azlocal-console \
  --from-literal=token="$TUNNEL_TOKEN"
```

```yaml
# k8s/cloudflared.yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: cloudflared, namespace: azlocal-console }
spec:
  replicas: 2
  selector: { matchLabels: { app: cloudflared } }
  template:
    metadata: { labels: { app: cloudflared } }
    spec:
      containers:
        - name: cloudflared
          image: cloudflare/cloudflared:latest
          args: ["tunnel", "--no-autoupdate", "run", "--token", "$(TUNNEL_TOKEN)"]
          env:
            - name: TUNNEL_TOKEN
              valueFrom: { secretKeyRef: { name: cloudflared-token, key: token } }
          resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: 250m, memory: 256Mi } }
```

- Tunnel public-hostname route: `console.azurestack.nyc` → `http://azlocal-console.azlocal-console.svc.cluster.local:80` (set in the Zero Trust dashboard, or via `cloudflared tunnel route` + config).
- **DNS record** (zone `azurestack.nyc`, account `e9248b727e65b3282b4c6c71c5e6fee4`): `CNAME console → <TUNNEL_ID>.cfargotunnel.com`, **proxied**. Creating the public hostname in the dashboard adds this automatically; otherwise add it via the API with the `primary` DNS-edit token.
- The `azurestack.nyc` apex stays on Cloudflare Pages — untouched.

**Fallback path (LAN only):** `https://192.168.1.171:31374` with `Host: console.azurestack.nyc` (or a hosts-file entry). Served by the cert-manager cert from §3e.

---

## 6. Verify (after every deploy)

```bash
NS="-n azlocal-console"

# 1. Pod healthy, correct image
kk get pods $NS -o wide
kk get deployment azlocal-console $NS -o jsonpath='{.spec.template.spec.containers[0].image}'

# 2. Health endpoint — real metrics, not {ok:true} stub
curl -fsS https://console.azurestack.nyc/healthz | jq .
#   expect: {"ok":true,"db":"rw","runs_active":N,"media":"listening", ...}

# 3. Auth is fail-closed: data routes 401 without the admin key
curl -s -o /dev/null -w '%{http_code}\n' https://console.azurestack.nyc/api/runs          # 401
curl -fsS -H "Authorization: Bearer $ADMIN_API_KEY" https://console.azurestack.nyc/api/runs | jq .ok

# 4. SSE log stream holds open (no proxy buffering)
curl -N -m 10 -H "Authorization: Bearer $ADMIN_API_KEY" \
  https://console.azurestack.nyc/api/runs/smoke/logs/stream | head -3

# 5. Pod → iDRAC egress (Redfish)
POD=$(kk get pods $NS -l app=azlocal-console -o jsonpath='{.items[0].metadata.name}')
kk exec $NS $POD -- curl -ksS https://192.168.1.<IDRAC_IP>/redfish/v1 | jq -r .RedfishVersion

# 6. Virtual media: reachable from the iDRAC L2 AND range-capable (iDRAC needs 206)
curl -s -o /dev/null -w '%{http_code}\n' -r 0-1023 http://192.168.1.172:30808/media/healthcheck.iso
#   MUST print 206 (not 200) — 200 means no Range support and vmedia mounts WILL fail

# 7. az SP works inside the pod (Phase 3 readiness)
kk exec $NS $POD -- az account show --query id -o tsv

# 8. TLS cert issued (direct-LAN fallback path)
kk get certificate $NS console-azurestack-nyc-tls -o jsonpath='{.status.conditions[0].status}'  # True
```

Post-verify: `record-deploy` in release-tracker; update the console repo's IMPLEMENTATION-TRACKER.csv row with the deployed version.

---

## 7. Rollback

```bash
# NEVER roll back while a pipeline run is mid-flight if avoidable — pause/complete
# runs from the admin page first (in-flight iDRAC vmedia mounts survive a pod
# restart, but stage child-processes do not; runs resume from last recorded stage).

# Fast path — previous known-good tag (verify it exists in ACR first!):
az acr repository show-tags -n lucaexpressacr --repository azlocal-console -o tsv | grep -x "$PREV"
kk -n azlocal-console set image deployment/azlocal-console azlocal-console=lucaexpressacr.azurecr.io/azlocal-console:$PREV
kk -n azlocal-console rollout status deployment/azlocal-console --timeout=15m

# Or: kubectl rollout undo deployment/azlocal-console -n azlocal-console
```

**DB caveat:** schema migrations are forward-only. If the version being rolled back **introduced a migration**, restore the pre-deploy SQLite backup (§8) alongside the image rollback — an old binary on a new schema is undefined behavior. Record the rollback in release-tracker (`status: rolled-back`).

---

## 8. Backup & restore (SQLite PVC)

### 8a. Scheduled in-PVC snapshots — `k8s/backup-cronjob.yaml`

Runs `sqlite3 .backup` (safe online copy, WAL-aware — never `cp` a live db file) every 6h, 14-day retention, into the same PVC under `/data/backups/`:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata: { name: console-db-backup, namespace: azlocal-console }
spec:
  schedule: "15 */6 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          imagePullSecrets: [{ name: acr-pull }]
          containers:
            - name: backup
              image: lucaexpressacr.azurecr.io/azlocal-console:VERSION   # has sqlite3
              command: ["/bin/bash","-c"]
              args:
                - |
                  set -euo pipefail
                  mkdir -p /data/backups
                  sqlite3 /data/console.db ".backup /data/backups/console-$(date -u +%Y%m%dT%H%M%SZ).db"
                  find /data/backups -name 'console-*.db' -mtime +14 -delete
              volumeMounts: [{ name: data, mountPath: /data }]
          volumes:
            - name: data
              persistentVolumeClaim: { claimName: azlocal-console-data }
```

> RWO note: the CronJob pod mounts the same RWO PVC — on this cluster that works only while it schedules onto the **same node** as the console pod. If it ever Pending-deadlocks, switch to `kk exec` from a host cron instead.

### 8b. Weekly off-cluster copy (protects against PVC/node loss — the PVC lives on the same HCI pair as the iDRACs it manages)

```bash
POD=$(kk get pods -n azlocal-console -l app=azlocal-console -o jsonpath='{.items[0].metadata.name}')
kk exec -n azlocal-console $POD -- sqlite3 /data/console.db ".backup /data/backups/offsite.db"
kk cp azlocal-console/$POD:/data/backups/offsite.db "E:/backups/azlocal-console/console-$(date +%Y%m%d).db"
# optional: az storage blob upload to the lucaexpress backup storage account
```

Take an **8b copy manually before every deploy that includes a migration.**

### 8c. Restore

```bash
kk -n azlocal-console scale deployment/azlocal-console --replicas=0   # stop the single writer
# temp pod mounting the data PVC:
kk -n azlocal-console run db-restore --rm -it --image=lucaexpressacr.azurecr.io/azlocal-console:$VERSION \
  --overrides='{"spec":{"imagePullSecrets":[{"name":"acr-pull"}],"containers":[{"name":"db-restore","image":"lucaexpressacr.azurecr.io/azlocal-console:'$VERSION'","stdin":true,"tty":true,"command":["bash"],"volumeMounts":[{"name":"data","mountPath":"/data"}]}],"volumes":[{"name":"data","persistentVolumeClaim":{"claimName":"azlocal-console-data"}}]}}'
#   inside: cp /data/backups/<chosen>.db /data/console.db && rm -f /data/console.db-wal /data/console.db-shm
kk -n azlocal-console scale deployment/azlocal-console --replicas=1
```

ISO PVC (`azlocal-console-iso`) is **not** backed up — contents are rebuildable artifacts; after a loss, re-run the combined-ISO build stage.

---

## 9. Known gotchas

- **On-prem ACR pulls hang/flake** (`*.blob.core.windows.net` DNS on Azure-Local networks — bit the rwexpres cluster). Mitigations already baked in: `imagePullPolicy: IfNotPresent`, verify-tag-before-set-image, `Recreate` strategy. If a pull wedges: check node DNS (`kk debug node/... -- nslookup lucaexpressacr.azurecr.io`), consider a DNS forwarder, and pre-pull the tag onto the node before switching the Deployment.
- **Never scale to >1 replica** — SQLite corruption + RWO double-attach. Parallelism is *inside* the app (multiple pipeline runs per process), not via pods.
- **Liveness restarts vs. 3h ECE deploys:** run state is checkpointed in SQLite and `track-deployment` re-attaches to the ARM deployment on boot, so a restart is recoverable — but avoid deploying the console itself while a Phase-5 cluster creation is active; use an intervention gate to hold runs first.
- **Secrets discipline:** SP creds, admin key, and the iDRAC cred-store key exist only in the k8s Secret; the engine's stage logs are scrubbed, and structured logs must never echo env. Any leaked value → rotate the Secret + `rollout restart`.
- **Cloud validation "Unsupported OS Version"** and other RP rejections are *runtime* behavior, not deploy failures — the console surfaces RP errors verbatim and supports halting the run; do not "fix" them at the k8s layer.
