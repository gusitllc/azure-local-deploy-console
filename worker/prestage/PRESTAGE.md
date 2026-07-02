# Worker devstation — golden-image prestage manifest

The worker is a **Windows** devstation (the engine's ISO builder is Windows-only — it P/Invokes
`shlwapi.dll` + IMAPI2). We bake a golden image with everything below so that, on payment, a fresh
worker is deploy-ready in minutes. The customer supplies only their Claude Code OAuth token, a VPN
profile, and Azure sign-in.

`stage-worker.ps1` in this folder installs all of it into a base Windows image (Server 2022 / Win 11)
and leaves the image ready to `sysprep`/snapshot.

## 1. AI — Claude Code

- **Claude Code CLI** + the MCP extensions the build uses (filesystem, shell, the engine's helpers).
- **OAuth token is NOT baked** — the customer plugs in **their own** Claude Code OAuth token at first
  boot (their subscription pays for the AI). The worker-agent reads it from the protected credential
  store (`CLAUDE_CODE_OAUTH_TOKEN`), never from disk in plaintext, never committed.

## 2. The engine

- `git clone https://github.com/gusitllc/azure-local-2node-factory` → `C:\worker\engine`.
- Pre-seed the PowerShell module chain so Arc onboarding has **zero cold-install time**:
  `AzSHCI.ARCInstaller`, `AzStackHci.EnvironmentChecker` (with `-AllowClobber`), `Az.Accounts`,
  `Az.Resources`. **Do NOT** leave `Az.StackHCI` installed — it clobber-blocks the EnvironmentChecker.

## 3. Toolchain

| Tool | Why |
| --- | --- |
| `az` CLI + Az PowerShell | Azure prep, Arc, deployment (Validate/Deploy) |
| `wimlib-imagex` | patch boot.wim (self-wiping WinPE) + verify install.wim build — **user-mode**, no admin/DISM |
| `node` (LTS) | serve range-capable ISO media, gen-autounattend, gen-arm-parameters |
| `python` + `pycdlib` | extract ISO trees without `Mount-DiskImage` (needs a privilege headless sessions lack) |
| `git`, `curl`, PowerShell 7 | general |
| WinRM / `TrustedHosts` | reach node mgmt IPs after imaging |

## 4. ISO store + media server

- `C:\worker\iso\` — verified Azure Local OS images. **Verify the wim build** (`wimlib-imagex info
  <tree>\sources\install.wim 1`) — filenames lie. Only keep builds on the release-table
  new-deployment allow-list.
- The engine's range-capable HTTP server (`lib/serve-iso.js`) serves virtual media; **per run** it
  binds a unique port so parallel workers never collide.

## 5. VPN client — reach the customer's iDRAC network

The customer is **not on our network**. The worker imports the customer's VPN profile and dials into
**their** iDRAC network to reach the servers over Redfish.

- **WireGuard** (preferred) + **OpenVPN** clients installed.
- The worker-agent imports the customer's profile (`worker/agent` reads `VPN_PROFILE` from the
  credential store), brings the tunnel up, and verifies iDRAC reachability (Redfish `GET /redfish/v1`
  to each entered iDRAC IP) before Phase 1 proceeds.
- iDRAC IPs + credentials are entered in the console Phase 1 and pushed to the worker's key store —
  never stored in this repo or the console DB.

## 6. Worker-agent

- Windows service (`worker/agent`) that: registers with the console (mTLS + enrollment token),
  brings up the VPN, claims phase jobs, runs engine stages in an **isolated per-run working tree**
  (`C:\worker\runs\<runId>\engine` — a copy, because stages write back into the engine root), sets a
  **per-run `az` context** (`AZURE_CONFIG_DIR`), captures structured logs, and streams them to the
  console with **secrets redacted at the boundary**.

## 7. Security posture

- No customer secret is ever written to this repo, the golden image, the console DB, or logs.
- The credential store is the Windows DPAPI/Credential Manager (or the customer's Key Vault); the
  agent reads references, redacts on the way out.
- The worker is **ephemeral** — torn down at hand-off; the image is re-provisioned per customer.

## Build & snapshot

```powershell
# on a clean Windows Server 2022 / Win 11 base:
./stage-worker.ps1 -EngineRef main
# then generalize + snapshot as the golden image:
#   sysprep /generalize /oobe /shutdown   (or your cloud platform's image-capture)
```
