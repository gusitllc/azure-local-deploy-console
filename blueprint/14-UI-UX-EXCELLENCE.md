# UI-UX-EXCELLENCE — Azure Local Deployment Console

> Blueprint 14 of 14. The operator admin board and the customer run-view. The UI's job: make a
> multi-hour, multi-cluster, partly-irreversible process feel legible, safe, and calm.

## Principles

1. **State at a glance.** An operator running three clusters must see, in one screen, where each is,
   what's waiting on them, and what's on fire — without clicking.
2. **Gates are the moment that matters.** Approvals (especially destructive ones) are the UI's most
   important affordance: unmissable, unambiguous about *what* is being approved, one deliberate click.
3. **The log is the truth.** Live, streaming, secret-safe stage output — the thing an expert would
   stare at in a terminal — is a first-class pane, not hidden.
4. **Nothing destructive by accident.** Wipe/Deploy approvals show the exact target servers and
   require intent; halt is always one click away.
5. **Calm, not flashy.** This is an operations console watched for hours — legibility, tabular
   numerics, low motion, dark aesthetic; the azurestack.nyc dark-gold identity, dialed toward utility.

## Surfaces

- **`/` site** — azurestack.nyc marketing + the `$200` sign-up + checkout (already live).
- **`/admin` board** — operator control tower (below).
- **`/run/:id` customer view** — a read-only, scoped live view of one run (phase timeline + logs),
  shareable with an engagement client.

## The admin board (information design)

```
┌ AzureStack.NYC · Deployment Console ───────────────────── operator ▾ ┐
│  Runs (3 active)                                    [+ New deployment] │
│ ┌ run 41 · acme-edge ────────┐ ┌ run 42 · vosj ─────────┐ ┌ run 43 ─┐ │
│ │ ● Phase 3/5 Arc+Azure      │ │ ⏸ AWAITING APPROVAL     │ │ ✖ FAIL  │ │
│ │ ▓▓▓▓▓░░░ onboard 1/2       │ │ before wipe · 2 servers │ │ Validate│ │
│ │ live: "app02 Connected"   │ │ [Approve] [Reject]      │ │ verbatim│ │
│ │ [halt]                    │ │ [halt]                  │ │ [retry] │ │
│ └───────────────────────────┘ └─────────────────────────┘ └─────────┘ │
└───────────────────────────────────────────────────────────────────────┘
```

- **Run cards**, one per active run: cluster name, current phase (1–5) + step, a real progress bar
  (Deploy = ~55 ECE steps, not a spinner), the latest live log line, and the state color.
- **State color** encodes at a glance: running (jade), awaiting-approval (gold, pulsing), failed
  (coral), succeeded (green), paused/halted (fog). Semantic color is separate from the gold accent.
- **A gate card** is visually distinct and blocking-looking — it *wants* a decision: what phase, what
  action, which servers, [Approve] / [Reject], plus the log context that led here.

## Run detail

- **Phase timeline** (1→5) with per-phase status + duration; expand a phase to its steps
  (name, status, exit, attempt, timeout, log link).
- **Live log pane** — SSE stream, monospace, auto-scroll with a pause-on-scroll, secret-safe;
  `Last-Event-ID` resume so a reconnect doesn't lose lines.
- **iDRAC console screenshot** button per server (`rf_screenshot`) — the only eyes into a stuck
  WinPE/Setup; shown inline.
- **Verbatim error panel** — on a failed Validate/Deploy, the raw RP/ARM text in a bordered,
  copyable block (never paraphrased), with any heal button (`ext-sync`) beside it.
- **Actions**: approve/reject (gates), halt, retry (resume at failed step), skip-step (with reason,
  audited), heal.

## Gate UX (the safety-critical interaction)

- Destructive gates (wipe, Deploy) render a **confirmation with the target servers enumerated**
  (iDRAC IP + model + service tag) and the action named — approval is intent, not a reflex.
- Optional dual-operator approval (`settings`) for destructive gates.
- Every gate action shows the actor + timestamp afterward (audit visible in-line).

## Accessibility & responsiveness

- Keyboard operable (approve/halt reachable without a mouse); visible focus rings; `aria-live` on the
  log pane and gate prompts so a screen reader announces state changes and approval requests.
- Respects `prefers-reduced-motion` (the awaiting-approval pulse becomes a static highlight).
- Responsive down to a tablet (an operator may approve a gate from a phone); the board reflows cards
  to a column; wide content (logs, tables) scrolls inside its own container — the page never scrolls
  sideways.

## Copy & microcopy

- Plain operator language: "Approve the disk wipe on 2 servers", not "confirm destructive stage 17".
- Errors say what happened + the exact cloud text + what to do (retry / heal / escalate).
- Buttons name their effect ("Approve wipe", then a toast "Wipe approved — Phase 2 continuing").

## Aesthetic

Inherits azurestack.nyc's identity — Didot/Copperplate display, Inter for UI, the dark-night + gold
palette — but tuned for an **operations** surface: denser, tabular-numeric, low-chrome, calm. The
marketing site sells; the console *reassures the person watching a wipe run at 2 a.m.*
