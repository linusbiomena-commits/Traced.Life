# TRACED: Development Progress (evidence-based)

Last updated: 2026-11-26.

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 0 | Inspection, architecture, roadmap | Complete | `docs/phase-0-report.md` |
| 1 | Auth, RBAC, audit, DB foundation | Complete | `cdcb44d`, `docs/phase-1-report.md` |
| 2 | Customer portal | Complete | `cdcb44d`, `docs/phase-2-report.md` |
| 3 | Tracking IDs, QR, email outbox | Complete | `66d4b00`, `docs/phase-3-report.md` |
| 4 | Collection staff portal, scanner, collection | **Complete for its scope** (physical devices pending) | `2debbf1`, `docs/phase-4-report.md`; re-verified 2026-11-26 |
| 5 | Authorized admin portal | **Planned, awaiting approval** | `docs/phase-5-plan.md` |
| 6 | Physical sample labels and chain of custody | Not started (schema groundwork in 0007) | none |
| 7 | Security hardening and production readiness | Not started | `docs/audit-hardening-plan.md` (plan only) |
| 8 | Production infrastructure and deployment | Not started; **not authorised** | `docs/architecture.md` (plan only) |

## Current phase
Between Phase 4 (finished) and Phase 5 (awaiting approval).

## In progress
Nothing in progress.

## Remaining before production (beyond Phases 5–8)
The approvals listed in `docs/DECISIONS.md` ("Unresolved"): identity verification, clinical instructions, consent wording, Arabic review, Resend/Vercel data transfer, real branches, device validation, and costs.

## Production readiness
**Not ready.** Nothing is provisioned or deployed. Production collection is deliberately blocked until an approved identity-verification method and approved instructions exist.

## Estimated completion
About **55%** of total development effort (Phases 0–4 ≈ 180 h of ≈ 300–390 h, per the Phase 0 estimates). This counts engineering effort only and excludes business, legal and clinical approvals.
