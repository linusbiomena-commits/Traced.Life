# TRACED: Changelog

## 2026-11-27 (evening): Oracle hosting approved; server launch paused
- Created in Riyadh (free): network with no inbound access, Vault + software key + 9 generated secrets, encrypted private buckets for backups (35-day lifecycle) and audit checkpoints (400-day retention, unlocked), Object Storage service policy, Run Command permission.
- `traced-app-1` (A1.Flex 1 OCPU / 4 GB) not created: Out of host capacity. Retries stopped; Pay As You Go upgrade requested by the owner.
- `deploy/oci/`: admin scripts (network, secrets, buckets, launch, Run Command runner) and VM scripts (PostgreSQL, migrations + roles, verification, nightly encrypted backup + restore check, cloud-init).
- New test `server/test/oci-db-layout.test.ts` (8) for the Oracle database layout.

## 2026-11-27: Hosting moved to Oracle Cloud (governance only; nothing billable)
- Public website (no portal) live at https://tracedlife.vercel.app (`scripts/build-public-site.mjs`, `vercel.json`, `.vercelignore`).
- Google Cloud: project `traced-production` created, then blocked (Dammam refused for the billing account); kept empty.
- Oracle Cloud tenancy `karamait` (Riyadh): compartment `TRACED`, tag namespace `KaRamaIT` with cost-tracking tags and defaults, budget EUR 23.25/month with 50/80/100% + forecast alerts, groups `TRACED-Operators` and `KaRamaIT-Finance-Readers`, dynamic group `TRACED-Instances`, three least-privilege policies.
- `docs/deploy/oci-plan.md`: tenancy facts, IAM matrix, expenditure reporting, proposed Riyadh architecture, EUR pricing, cost estimate (EUR 0 within Always Free; worst case ≈ SAR 64 incl. VAT), risks and decisions.

## 2026-11-27: Phase 8 preparation (Stage 8A done; nothing provisioned)
- Local manual-testing worktree upgraded to `dee1101`; dev DB migrated 0009 → 0011 after an online backup with verified restore (32/32 tables); data verified unchanged.
- New local-only CLI `npm run dev:db-backup` (online physical backup + restore test); `.dev-db-backups/` and `.dev-audit-checkpoints/` gitignored.
- `server/sql/production-roles.sql`: asserts instead of setting superuser-only role attributes (Cloud SQL owner is not a superuser).
- `docs/deploy/phase-8-preparation.md`: project and IAM matrix, Cloud Run/Cloud SQL configuration and exact (unexecuted) commands, secret inventory from the code, Vercel review (live site not deployed from this repo), Scheduler + independent checkpoint project, Resend/DNS, billing alerts, repository visibility, stages 8A–8D, release gate, decisions D1–D13.
- `docs/deploy/cost-estimate.md`: verified Dammam list prices; ≈ SAR 72–79/month incl. VAT for 100–1,000 registrations.
- `docs/manual-testing.md` §7–8: Phase 7 features and local backup/rollback.
- Fixed: time-of-day bug in an admin audit-log test.

## 2026-11-26: Phase 7, security hardening and production readiness (local only)
- Auth: super-admin reset of two-step verification; self-service recovery-code regeneration; production config guards (scheduler credential, https origin, export limits); `HOST`.
- Migration **0010**: signed audit checkpoints, verification records, range verification, custody digest, TRUNCATE guards. Migration **0011**: performance indexes.
- Audit integrity service + admin page; scheduled checkpoint/verify; Cloud Scheduler OIDC verification.
- `production-roles.sql` rewritten per table and tested (app runs as `traced_app`).
- Super-admin personal-data export (fresh TOTP, reason, minimisation, limits, CSV-safe, audited, not stored) + admin page.
- Performance run (`npm run test:perf`), backup drill (`npm run drill:backup`), outbox attempt cap, camera tests isolated per browser, screenshots redacted in memory, orphan cleanup script, history QR scanner.
- Docs: threat model, security assessment, permission matrix, DB permissions, audit integrity runbook, privacy review, performance, backup, device checklist, deployment templates, launch checklist, Phase 8 plan, cost estimate, rollback.
- Tests: 263 / 263 unit/integration, 30 / 30 browser.

## 2026-11-26: Phase 6, physical sample identification and chain of custody
- Migration **0009**: sample IDs `TRC-SA-MM/YY-XXXXX-SXX` (reuses `samples.sample_code`, per-registration sequence, immutable), `sample_qr_tokens` (`s1_`), append-only `custody_events`, `sample_label_prints`, `recollection_authorizations`, status email kinds.
- Collection creates the sample ID, sample QR and initial custody event; staff Samples page (package, ready, dispatch) and printable labels (50×30 default; audited reprints); **laboratory portal** (`/traced/lab/`, MFA, no patient data): receipt with condition, accept/reject, analysis, report available; admin custody list/record, appended corrections, recollection authorisation (new customer QR, fresh collection → `-S02`); customer timeline; optional status emails (`CUSTOMER_STATUS_EMAILS`).
- Fixed: idempotent replay under concurrency; label CSS colliding with form labels; reprint button label; invisible character in the screenshot-redaction pattern (now also covers sample tokens).
- Tests: 216 unit + 27 browser.

## 2026-11-26: Stage A, manual-testing preparation and login improvements
- Customer sign-in page: discreet **Staff Login | Admin Login** links (Arabic دخول الموظفين | دخول الإدارة).
- One shared `homeFor()` routes every role to its own portal from any sign-in page; `next` links are honoured only inside the account's own area; customer-only pages send staff/admins to their portal; roles without a portal get a clear notice.
- `npm run dev:test-accounts`: local-only synthetic accounts (customer, collection staff at DEV-RUH-01, admin, super admin, auditor) via one-time links; refuses production / non-local DB / real mail; stores no passwords.
- `docs/manual-testing.md`; tests 204 unit + 24 browser.

## 2026-11-26: Phase 5 finalised
- Final verification: typecheck clean, 200/200 unit+integration, 22/22 browser, `npm audit` 0, secrets scan clean.
- Browser-test harness: per-run embedded-PostgreSQL data directory so an orphaned Windows worker can't block the next run (tested with a locked leftover directory).
- Evidence: MFA key and recovery codes masked; 13 customer QR codes redacted from committed screenshots; `redact-qr.ts` runs automatically on every screenshot; new test fails if a committed screenshot contains a decodable QR token or MFA code.
- `docs/phase-6-plan.md` (proposed, awaiting approval).

## 2026-11-26: Phase 5, authorized admin portal
- **Milestone 1 (`898705e`):** trusted-proxy hardening (`TRUSTED_PROXY_HOPS`/`_CIDRS`/`_SECRET`; leftmost X-Forwarded-For no longer trusted; production must configure it).
- **Milestone 2 (`405a1f0`):** migration **0008** (permission `instructions.draft`, user status metadata, `registration_branch_transfers`, `collection_instruction_drafts`, instruction approval columns, `registration_branch_changed` email, indexes); admin API under `server/src/modules/admin/`; audit viewer filters and redaction.
- **Milestone 3:** admin portal pages (13 EN/AR pages incl. MFA enrolment), customer branch-change notice, MFA setup QR image, 6 admin browser tests, 20 screenshots, `docs/phase-5-report.md`.
- **Fixed:** race in the last-super-admin guard; invite message wiped on reload; page-level permission guard.

## 2026-11-26: Phase 4 verified and handover system added
- Independent re-verification on a new Claude account: typecheck clean, 154/154 tests, 16/16 browser tests, portal checks pass, `npm audit` 0 vulnerabilities, no tracked secrets.
- Added `CLAUDE.md` and the handover documents (`docs/MASTER_HANDOVER.md`, `HANDOVER.md`, `PROJECT_CONTEXT.md`, `DEVELOPMENT_PROGRESS.md`, `DECISIONS.md`, `TEST_STATUS.md`, this file) and `docs/phase-5-plan.md`.
- Found: leftmost `X-Forwarded-For` trust when `TRUST_PROXY=true` (pre-existing since Phase 1; fix proposed for Phase 5 pre-work). Found: GitHub default branch is `feature/traced-portal`.

## 2026-11-26: Phase 4, collection staff portal (`2debbf1`)
- Migration **0007**: QR `used` state + terminal-state trigger; `collection_instructions`, `collection_sessions`, `identity_verifications`, `samples`.
- Collection service (single-transaction confirmation; one live sample per registration), staff API, admin QR revocation API, shared QR lifecycle service, Cloud Scheduler outbox endpoint, `DB_POOL_MAX`.
- Staff portal (EN/AR): sign-in, dashboard, camera/USB/manual scanner (vendored `@zxing/browser` 0.2.1), identity framework (dev-only simulation), checklist, history.
- Removed `qr/validation.service.ts`. Fixed: microsecond timestamp loss in the verification check, patient/collection lock ordering.
- Tests 154 (+25), browser 16 (+7).

## 2026-11-26: Phase 3, tracking IDs, QR and email (`66d4b00`)
- Migrations **0005** (tracking sequences, QR tokens, patient revisions, staff branch assignments, email outbox) and **0006** (allocator fix).
- Tracking ID engine, PNG/SVG QR, replacement and revocation, public QR landing page, bilingual email templates and outbox. Tests 129.

## Phases 1–2: auth, RBAC, audit and customer portal (`cdcb44d`)
- Migrations **0001–0004**. Custom auth (argon2, sessions, CSRF, lockout, MFA, recovery codes, invitations), audit hash chain, rate limits; customer portal with five-step registration, consents and EN/AR. Enforced UTF-8 for embedded PostgreSQL. Tests 86, browser 9.

## Baseline
- `0e54770` static site split from the LinusBio MENA website; `a9e5832` byte-exact static files.
