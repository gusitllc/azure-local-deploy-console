# SECURITY-PRIVACY-EXCELLENCE — Azure Local Deployment Console

> Blueprint 10 of 14. The security model. This product handles a customer's iDRAC, Azure, and Claude
> credentials and wipes their servers — security is the core feature, not a layer.

## Threat model (what we protect against)

| Asset | Threat | Control |
| --- | --- | --- |
| Customer iDRAC/Azure/Claude secrets | leak via repo, DB, logs, SSE | **secrets never leave the customer boundary** — held only in the worker key store; console handles refs, not values; fail-closed redaction |
| A customer's servers (destructive wipe) | wrong-target or unauthorized wipe | destructive gates ON by default; server-lock; explicit approval with actor recorded |
| Console API | unauth access, privilege escalation | requireAuth on every route; requireCapability on every mutation; scrypt + short session; RBAC |
| Worker channel | spoofed worker / MITM | mutual TLS; one-time enrollment token (hashed at rest); pinned fingerprint |
| Payment | card data exposure, forged webhook | Stripe holds cards (never us); webhook signature verified |
| Tenant isolation | one customer's run touching another's | one worker per customer; own VPN, az context, working tree; no shared data plane |

## The secret boundary (the central rule)

```
Customer browser ──(TLS)──► Worker key store (DPAPI / customer Key Vault)
                                   │  resolved locally at stage spawn
Console ──(refs only)──────────────┘   (console NEVER receives values)
```

- **Claude Code OAuth token, iDRAC credentials, Azure SP/sign-in, deployment secrets** are entered by
  the customer and stored **only** on the worker (Windows DPAPI or their Azure Key Vault).
- The **console** stores and transmits only *references* (`cred_ref`, secret handles). It cannot
  read a value even if fully compromised.
- The **worker-agent** resolves refs at stage-spawn and injects via env; a **fail-closed redaction
  filter** knows every injected value and replaces it with `***` on every log/event line before it
  leaves the worker. No secret reaches the console, DB, log files, or SSE.
- Deployment secrets flow **env → customer Key Vault**, never through a file on disk or a log line
  (the engine already enforces this).

## AuthN / AuthZ

- **Operators**: scrypt-hashed passwords, httpOnly + `SameSite=Strict` session cookies, short TTL,
  server-side session table (revocable). `ADMIN_KEY` (k8s Secret) bootstraps and is rotatable
  without redeploy.
- **RBAC**: `admin` (all), `operator` (`runs:read/write/approve`, `servers:write`), `viewer`
  (`runs:read`). `requireCapability` guards every mutation; `deploy:runs:override` (skip) and
  `deploy:runs:approve` (gates, firmware apply, deploy) are the sensitive caps.
- **Audit**: every approve / reject / skip / halt / firmware-apply writes an event with the actor,
  timestamp, and reason — an immutable trail for destructive actions.

## Transport & platform

- HTTPS everywhere (ingress-nginx + cert-manager). Worker channel is mTLS.
- Secrets from **k8s Secrets** into env; none in the image, repo, or DB. `.gitignore` blocks
  `.env`, `config.env`, `*.local.*`. Pre-commit + CI secret scan (the engine's `\x01`/creds sweep
  pattern) on both repos.
- CSP + standard headers on the site and admin SPA; `esc()` on all rendered content (XSS);
  parameterized SQL (injection).
- Stripe: signature-verified webhook, no PAN/CVV ever touches our systems.

## Privacy

- **Customer data minimization**: we store email + order + run coordination. Server inventory
  (model/serial/health) is operational, not sensitive; no customer application data is ever seen.
- **Ephemerality**: the worker — the only place secrets live — is destroyed at hand-off. Post-run,
  the customer's secrets are gone from our estate entirely.
- **Right to deletion**: customer + order records deletable on request; run history anonymizable.

## Destructive-action safety

- Firmware apply and disk wipe **gate by default** (`before_destructive`); an operator must approve
  with the target servers shown explicitly.
- Server-lock prevents a server being in two runs; the wipe stage refuses without `ACK_WIPE=yes`
  supplied by the approved gate, not by config.
- **Halt-anywhere** lets an operator stop before or during any destructive step.

## Non-negotiables

Secrets never in repo/DB/logs/SSE · destructive gates on by default · mTLS worker channel · verbatim
(secret-scrubbed) errors · auth on all routes, capability on all mutations · worker ephemeral.