# TRACED: Development Progress (evidence-based)

Last updated: 2026-11-26.

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 0 | Inspection, architecture, roadmap | Complete | `docs/phase-0-report.md` |
| 1 | Auth, RBAC, audit, DB foundation | Complete | `cdcb44d`, `docs/phase-1-report.md` |
| 2 | Customer portal | Complete | `cdcb44d`, `docs/phase-2-report.md` |
| 3 | Tracking IDs, QR, email outbox | Complete | `66d4b00`, `docs/phase-3-report.md` |
| 4 | Collection staff portal, scanner, collection | **Complete for its scope** (physical devices pending) | `2debbf1`, `docs/phase-4-report.md`; re-verified 2026-11-26 |
| 5 | Authorized admin portal (+ trusted-proxy fix) | **Complete for the approved scope** | `898705e`, `405a1f0`, `b49a84d`, `9b4c3c2` + finalisation commit; `docs/phase-5-report.md` (200 unit + 22 browser tests) |
| 6 | Physical sample labels and chain of custody | **Not started; awaiting approval** (schema groundwork in 0007) | plan: `docs/phase-6-plan.md` (≈ 41–52 h) |
| 7 | Security hardening and production readiness | Not started | `docs/audit-hardening-plan.md` (plan only) |
| 8 | Production infrastructure and deployment | Not started; **not authorised** | `docs/architecture.md` (plan only) |

## Current phase
Phase 5 finished; Phase 6 awaits approval.

## In progress
Nothing in progress.

## Remaining before production (beyond Phases 5–8)
The approvals listed in `docs/DECISIONS.md` ("Unresolved"): identity verification, clinical instructions, consent wording, Arabic review, Resend/Vercel data transfer, real branches, device validation, and costs.

## Production readiness
**Not ready.** Nothing is provisioned or deployed. Production collection is deliberately blocked until an approved identity-verification method and approved instructions exist.

## Estimated completion
About **65%** of total development effort (Phases 0–5 ≈ 225 h of ≈ 300–390 h, per the Phase 0 estimates). This counts engineering effort only and excludes business, legal and clinical approvals.
