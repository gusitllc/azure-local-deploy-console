# TEST-QUALITY-EXCELLENCE — Azure Local Deployment Console

> Blueprint 13 of 14. How we prove the console is correct — where "correct" spans a JS control plane,
> a bash/PowerShell engine on Windows, real iron, and a cloud that lies. Testing is layered because
> the failure modes are.

## Test pyramid (for this system)

```
      E2E (real cluster, real iDRAC, real Azure)  ── few, expensive, the acceptance gate
   Integration (console ⇄ worker ⇄ mock iDRAC/Azure)  ── the state machine + dispatch
 Contract (engine command exit-code map, SSE shape, API)  ── fast, many
Unit (redaction, gate logic, migrations, auth, parameterized SQL)  ── fast, most
```

## Unit

- **Redaction filter** (the security-critical unit): given a set of injected secret values, every
  log/event line out must contain `***` and never a raw value — property-tested with random secrets
  incl. regex-special and multi-line values (fail-closed).
- **Gate logic**: `gates_json` → correct pause points; destructive gates default ON; approve/reject
  transitions; halt sets `failed(halted)`; retry targets the failed step only.
- **Auth**: requireAuth rejects no-session; requireCapability rejects under-privileged; scrypt verify;
  session expiry.
- **DB**: every query parameterized (static check bans interpolated SQL); migrations apply cleanly
  from empty and are idempotent; the server-lock unique index rejects a double-lock.

## Contract

- **Engine exit-code map**: table-test `0→succeeded`, `nonzero→failed(after retries)`,
  `killed→failed(halted)`, `timeout→failed(timeout)`, `ext-mismatch exit→failed(healable:ext-sync)`.
- **SSE shape**: `id/event/data` well-formed; `Last-Event-ID` resume returns the right tail.
- **API**: every route returns `{ok:true,…}|{ok:false,error}`; error responses carry `verbatim`
  where applicable; capability matrix enforced.

## Integration (mocked metal/cloud)

- **Mock iDRAC** (Redfish fixture server) — inventory, vmedia, screenshot, SystemErase, and the
  *stale-flag* path (so `erase-unstick` heal is tested without real hardware).
- **Mock Azure/ARM** — Validate returns success, ext-version-mismatch, and the **"Unsupported OS
  Version"** verbatim body → assert the run halts + shows it unparaphrased.
- **Worker-agent harness** — enroll (mTLS), claim a job, stream events, honor HALT, resume after a
  simulated worker restart (resumability proof).
- **State machine**: a full mocked run walks 5 phases; gates pause; approve advances; a mid-phase
  failure + retry resumes at the failed step; three concurrent mocked runs don't collide (per-run
  env/port/tree asserted distinct).

## E2E (the acceptance gate)

The blueprint-5 acceptance run on **real hardware** (rg-flt4x02 nodes app02/app01a): register iDRAC
IPs → Phase-1..5 from the browser with only gate approvals → cluster `Succeeded`. Because the current
MSFT-side RP gate can block Phase-4/5, E2E **passes** in two ways: (a) cluster reaches Succeeded, or
(b) the run **halts and surfaces the RP error verbatim** — proving the console behaves correctly even
when the cloud does not. Both outcomes are recorded; only a console *malfunction* (wrong state, leaked
secret, unresumable halt) fails E2E.

## Engine-side quality (inherited, re-verified)

The engine ships its own gotcha catalog + `RE-IMAGE-LESSONS`. The console's tests re-verify the
seams it depends on: **build-gated OS verify** (no false-pass on the old OS), **wim verify** before
boot, **fail-closed ISO build** (DONE marker + freshness), **filter-for-errors** on onboarding output.
A regression in any is caught at the contract layer before a real run.

## Quality gates (CI)

- Lint (no interpolated SQL, no `console.log` of secrets, files < 300 lines, `esc()` on rendered
  content), `bash -n` / PSParser on any bundled scripts, `node --check`.
- Unit + contract + integration must be green to merge; **secret-scan** on both repos.
- Coverage focus on the *dangerous* units (redaction, gates, auth, migrations) over vanity %.
- **Manual verification** (the `/verify` discipline): each phase's feature flag is exercised against
  the mock stack, and P1+ against a real iDRAC pair, before its tracker row is signed off.

## Definition of done (per step)

Code + tests green + reviewer sign-off vs. the relevant excellence layer + feature-flag gated + the
tracker row updated. The app is done only after the E2E run and the CD/CI-CD release close-out.
