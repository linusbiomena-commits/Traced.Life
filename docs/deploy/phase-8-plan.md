# TRACED: Phase 8 deployment plan (proposal, awaiting approval)

> **27 Nov 2026:** Stage 8A (local upgrade) is done. The detailed, verified preparation (IAM matrix, exact commands, Dammam pricing, decisions D1–D13, release gate) is in `phase-8-preparation.md`, which supersedes overlapping parts of this plan.

Nothing in this plan has started. Each step that creates paid resources, touches production credentials, applies production migrations, changes DNS or the live Vercel site needs the owner's explicit go-ahead.

## Decisions needed before Phase 8

| # | Decision | Options / recommendation |
|---|---|---|
| D1 | Region | me-central2 (Dammam) recommended for residency; confirm service + machine-type availability |
| D2 | API path | Vercel rewrite (same origin, current design; personal data transits Vercel edge) **or** custom domain straight to Cloud Run / HTTPS load balancer (no non-Saudi transit for API traffic). Legal/privacy to decide (`docs/architecture.md` §2) |
| D3 | Email provider | Resend stores data in the US (PDPL cross-border transfer) — approve, or choose a provider with in-region processing |
| D4 | Identity verification | Production collection stays **blocked** until a real method is approved (`docs/identity-verification.md`); launch can be registration-only |
| D5 | Database size | db-f1-micro (no SLA) vs db-g1-small; recommend f1-micro for pilot with alerts, upgrade on signal |
| D6 | Checkpoint sink | GCS bucket with locked retention (recommended) — needs the small GCS writer (Phase 8 code task) |
| D7 | Scheduler auth | OIDC only (recommended) |
| D8 | Customer status emails | keep `CUSTOMER_STATUS_EMAILS=false` until wording approved |
| D9 | Official domain + mail domain | needed for `APP_ORIGIN`, SPF/DKIM/DMARC |
| D10 | Approved device list | phones/tablets/printers for branches (`docs/device-checklist.md`) |

## Steps

**Stage 1 — staging (no real data)**
1. Create `traced-staging` project, budget alerts, region per D1.
2. Artifact Registry, service accounts (`docs/deploy/README.md` §1), Secret Manager secrets (generated offline).
3. Cloud SQL staging instance (db-f1-micro), private IP, backups + PITR.
4. Migration job as owner: `npm run migrate`, then `server/sql/production-roles.sql`; set `traced_app` password.
5. Build image from `Dockerfile.example` (copied to root in a reviewed PR), deploy Cloud Run service from `cloudrun-service.example.yaml`.
6. Cloud Scheduler jobs with OIDC; confirm `/internal/*` refuses unauthenticated calls and accepts the scheduler.
7. Vercel **preview** deployment with the rewrite (never production first); verify cookies, CSRF, `TRUSTED_PROXY_HOPS` with the forged-XFF procedure (`docs/architecture.md` §2a), proxy secret via Routing Middleware.
8. GCS checkpoint bucket (retention not yet locked) + GCS writer code; run checkpoint + verify.
9. Run on staging: full browser suite against the staging URL, `npm run test:perf`-style smoke with synthetic data, backup → restore-to-new-instance drill (`docs/backup/README.md`), rollback drill (`docs/deploy/rollback.md` §1–2).
10. Physical device and printer validation at a pilot branch on staging (`docs/device-checklist.md`).

**Stage 2 — production**
11. `traced-prod` project, same steps 1–8 with production secrets; lock checkpoint bucket retention after a week of clean runs.
12. Bootstrap the first super administrators with `npm run create-user` (`server/src/cli/create-user.ts`) through the migration job (one-time setup links, MFA enforced).
13. Alerts and uptime checks live; on-call owners named.
14. Merge `feature/traced-portal` → `main` via reviewed PR (owner approval), production Vercel deploy with the rewrite.
15. Go/no-go with `docs/deploy/launch-checklist.md`. Soft launch: registrations only (collection blocked until D4), then pilot branch collection once identity verification is approved.

## Estimated effort

About 25–35 hours of engineering for Phase 8 (staging + production setup, GCS writer, CI pipeline, drills, launch support), excluding waiting on decisions, legal review and device procurement.
