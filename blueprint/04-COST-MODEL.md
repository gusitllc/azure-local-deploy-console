# COST-MODEL — Azure Local Deployment Console

> Blueprint 4 of 14. Unit economics of the $200/cluster service, infra cost, build cost, risks.

## Revenue

**$200 per cluster**, charged at checkout (Stripe). Multi-cluster orders bill $200 × N. Revenue is
per successful *booking*; a run that dead-ends on a customer-side or MSFT-side gate is refundable
(see risks) — the price assumes near-zero marginal delivery cost.

## Marginal cost per deployment (COGS)

| Item | Cost | Notes |
| --- | --- | --- |
| **Worker devstation** (Windows) | ~$1–4 | Ephemeral: a Windows VM (e.g. B4ms-class) for the ~4–6h a build runs, or an on-prem Hyper-V devstation (near-zero). Torn down at hand-off. |
| **Claude Code AI** | **$0 to us** | The customer plugs **their own** Claude Code OAuth token — their subscription pays for the AI. |
| **Customer Azure resources** | **$0 to us** | KV, witness storage, the cluster itself deploy into the **customer's** subscription. |
| **Console compute** | ~$0 marginal | One pod on the already-running on-prem `luca-capacity` AKS-Arc cluster. Fixed, not per-deploy. |
| **Egress / VPN** | trivial | Control traffic + log streaming only; the heavy image bytes stay worker↔customer over the VPN. |
| **Stripe fee** | ~$6.10 | 2.9% + $0.30 on $200. |
| **Support (human)** | variable | The real cost driver on non-happy-path runs (see risks). |

**Marginal COGS on a clean run ≈ $8–12.** Gross margin per clean cluster ≈ **94%+**.

## Fixed / infra cost

| Item | Cost | Cadence |
| --- | --- | --- |
| Console pod on `luca-capacity` | ~$0 marginal (on-prem, already up) | continuous |
| Postgres (small, on-prem or Azure Flexible B1ms) | ~$15–30/mo | continuous |
| Golden-image storage + rebuilds | ~$5–15/mo | per image refresh |
| Domain, Cloudflare, cert-manager | ~$0–5/mo | continuous |
| ACR (console image) | ~$5/mo | continuous |

**Fixed ≈ $30–55/mo** — covered by a single cluster sale.

## Build cost (one-time, in AI-agent hours)

| Phase | Scope | Est. |
| --- | --- | --- |
| P0 scaffold | console (Express+pg+auth+migrations+Docker+k8s), serves site | 8–12h |
| P1 dispatch + one-phase run | worker-agent, mTLS channel, engine adapter, SSE logs, Phase-1 inventory | 12–18h |
| P2 state machine + gates | phases/steps, gates, halt/retry, Phase-2 destructive path | 12–16h |
| P3 Phases 3–5 + heals | Azure prep, Validate, Deploy tracking, heal hooks | 14–20h |
| P4 provisioning + billing | Stripe webhook → provision worker → run; golden-image build/test | 12–16h |
| P5 admin UI + parallel + hardening | admin board, gate UX, live logs, scheduler, RBAC, audit | 14–20h |
| **Total** | | **~72–102h** |

(Consistent with a >40h app under the formation mandate — hence this 14-doc blueprint.)

## Break-even

- Fixed ~$45/mo ÷ ~$190 net/cluster ≈ **1 cluster/mo** covers infra.
- Build cost (agent hours) amortizes over the first **~10–20 clusters**.
- At 10 clusters/mo: ~$1,900 net revenue vs. ~$45 fixed + ~$100 COGS → **~$1,750/mo margin**.

## Sensitivities & risk costs

- **Support hours are the swing factor.** A clean run costs ~$10; a run that needs human debugging
  (novel hardware, customer network issues, an MSFT-side gate) can cost hours. Mitigation: verbatim
  error surfacing + heal hooks reduce human touches; the price bakes in an average of light support.
- **MSFT-side deployment gates** (the current "Unsupported OS Version" behavior) can block delivery
  through no fault of ours → **refund + support** exposure. Mitigation: pre-flight hardware/OS
  eligibility check *before* charging; clear refund policy; the run holds rather than churns.
- **Worker VM cost** rises with build duration; the ~3h Deploy dominates. Using an on-prem Hyper-V
  devstation instead of a cloud VM drops COGS toward zero.
- **Chargebacks/refunds** on failed deployments — bounded by the pre-charge eligibility check and a
  "validation-passes-or-refund" guarantee option.

## Pricing headroom

$200 is an entry price. Natural upsells (later): multi-cluster/fleet discounts, a
"validation-guaranteed" tier, day-2 monitoring subscription, N-node clusters — none required for v1.