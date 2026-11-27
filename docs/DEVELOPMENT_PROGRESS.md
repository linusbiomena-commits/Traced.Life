# TRACED: Development Progress (evidence-based)

Last updated: 2026-11-27 (Phase 8, Oracle Cloud).

| Phase | Scope | Status | Evidence |
|---|---|---|---|
| 0 | Inspection, architecture, roadmap | Complete | `docs/phase-0-report.md` |
| 1 | Auth, RBAC, audit, DB foundation | Complete | `cdcb44d`, `docs/phase-1-report.md` |
| 2 | Customer portal | Complete | `cdcb44d`, `docs/phase-2-report.md` |
| 3 | Tracking IDs, QR, email outbox | Complete | `66d4b00`, `docs/phase-3-report.md` |
| 4 | Collection staff portal, scanner, collection | **Complete for its scope** (physical devices pending) | `2debbf1`, `docs/phase-4-report.md`; re-verified 2026-11-26 |
| 5 | Authorized admin portal (+ trusted-proxy fix) | **Complete for the approved scope** | `898705e`, `405a1f0`, `b49a84d`, `9b4c3c2` + finalisation commit; `docs/phase-5-report.md` (200 unit + 22 browser tests) |
| 5A | Stage A: manual-testing preparation, login links, role routing | **Complete** | Stage A checkpoint commit; `docs/manual-testing.md` |
| 6 | Physical sample labels and chain of custody | **Complete for the approved scope** (printer/devices untested) | `9f39578` + final Phase 6 commit; `docs/phase-6-report.md` (216 unit + 27 browser) |
| 7 | Security hardening and production readiness | **Complete (local only)**; nothing provisioned | `91ea577`…`8682bb3` + docs commit; `docs/phase-7-report.md` |
| 8 | Production infrastructure and deployment | Stage 8A done; public website live on Vercel; **Oracle Cloud**: server + PostgreSQL live in Riyadh, migrations 0001–0011, permissions verified, encrypted backups + restore tested; API deployment prepared, waiting on Resend/DNS decisions | `docs/deploy/oci-plan.md` (current), `docs/deploy/phase-8-preparation.md` (Google, superseded) |

## Current phase
Phase 8: Oracle server and database live (27 Nov). Next: API + HTTPS + Vercel integration once decisions D-A…D-H arrive; launch target 1 Dec 2026.

## In progress
Nothing in progress.

## Remaining before production (beyond Phases 5–8)
The approvals listed in `docs/DECISIONS.md` ("Unresolved"): identity verification, clinical instructions, consent wording, Arabic review, Resend/Vercel data transfer, real branches, device validation, and costs.

## Production readiness
**Not ready.** Nothing is provisioned or deployed. Production collection is deliberately blocked until an approved identity-verification method and approved instructions exist.

## Estimated completion
About **93%** of total development effort (Phases 0–7 + Phase 8 preparation, public website and OCI governance ≈ 355 h of ≈ 370–400 h; remaining ≈ 15–25 h: API go-live with HTTPS and Vercel integration, admin bootstrap, monitoring, deployed regression and device testing, launch support). This counts engineering effort only and excludes business, legal and clinical approvals.
