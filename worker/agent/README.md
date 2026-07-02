# worker-agent

Runs on the worker devstation. Registers with the console, brings up the customer VPN, claims phase
jobs, executes engine stages in an isolated per-run working tree, and streams logs back (secrets
redacted).

## Contract (console ⇄ worker-agent)
- **Enroll**: `POST {console}/api/workers/enroll` with an enrollment token → mTLS cert + worker id.
- **VPN up**: import `VPN_PROFILE` (WireGuard/OpenVPN) from the credential store; verify each iDRAC
  IP answers Redfish `GET /redfish/v1` before Phase 1 is allowed to run.
- **Claude Code**: read `CLAUDE_CODE_OAUTH_TOKEN` from the credential store (customer-supplied).
- **Claim**: long-poll `GET {console}/api/runs/next?worker=<id>` → a phase job (runId, phase, config).
- **Execute**: run the mapped engine command(s) in `C:\worker\runs\<runId>\engine` (a copy — stages
  write back into the engine root), with a per-run `AZURE_CONFIG_DIR` and a unique media port.
- **Stream**: `POST {console}/api/runs/<runId>/events` (SSE upstream) — structured log lines,
  stage/step state, exit codes; **redact secrets at the boundary**.
- **Gate**: at an intervention gate, set state `awaiting-approval` and block until the console posts
  an approval.

## Phase → engine command map
| Phase | Engine |
| --- | --- |
| 1 iDRAC Prep | `lib/redfish.sh` inventory + `stages/15-firmware-baseline.sh` (+ SimpleUpdate apply on approval) |
| 2 Node Build | `stages/18-build-isos.sh` → `20` → `30` (build-gated) → `32` NIC names → `35` drivers |
| 3 Arc + Azure | `recover/recover.sh arc-onboard` ×N, `stages/00-azure-prep.sh`, KV+secrets, `lib/assign-deploy-permissions.sh`, ACR |
| 4 Validation | `stages/50-cluster-deploy.sh --validate-only` / ARM template Validate; `recover.sh ext-sync` heal |
| 5 Cluster + Monitor | `stages/50-cluster-deploy.sh` (Deploy) + `lib/track-deployment.sh` |
