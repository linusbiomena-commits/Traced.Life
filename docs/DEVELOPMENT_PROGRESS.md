# TRACED: Development Progress (evidence-based)

Last updated: 2026-11-28 (Phase 8: restricted pilot live; final UAT passed).

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
| 8 | Production infrastructure and deployment | Oracle server + DB (8A/8B) done; **8C restricted preview live**: HTTPS API, Resend, jobs, monitoring, Vercel preview (proxy secret pending); production switch after the release gate | `docs/deploy/phase-8c-report.md`, `oci-hosting-report.md` |

## Current phase
**Phase 8D (28 Nov):** release preparation done (`docs/deploy/production-release-readiness.md`); production switch awaits owner approval.

**28 Nov:** restricted pilot live on www.tracedmena.life; final real-browser UAT passed for every role (`docs/deploy/final-user-acceptance-report.md`); Sign Out fixed (fddcc9c); tests 302/302. Remaining before real patients: approved consents/instructions, real identity verification, device tests, owner release decision.

Phase 8: Oracle server and database live (27 Nov). Next: API + HTTPS + Vercel integration once decisions D-A…D-H arrive; launch target 1 Dec 2026.

## In progress
Nothing in progress.

## Remaining before production (beyond Phases 5–8)
The approvals listed in `docs/DECISIONS.md` ("Unresolved"): identity verification, clinical instructions, consent wording, Arabic review, Resend/Vercel data transfer, real branches, device validation, and costs.

## Production readiness
**Not ready.** Nothing is provisioned or deployed. Production collection is deliberately blocked until an approved identity-verification method and approved instructions exist.

## Estimated completion
About **96%** of total development effort (Phases 0–7 + Phase 8 preparation, public website and OCI governance ≈ 365 h of ≈ 375–400 h; remaining ≈ 10–20 h: deployed UI regression, consent-text loader, bug fixes, production switch, launch support). This counts engineering effort only and excludes business, legal and clinical approvals.
