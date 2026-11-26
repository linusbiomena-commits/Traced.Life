# TRACED: Changelog

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
