# TRACED Platform: Permanent Instructions for Claude

TRACED (LinusBio MENA, Saudi Arabia; collection partner Wareed) extends the existing static TRACED website with customer registration, secure QR codes, a collection-staff portal, an admin portal (built in Phase 5) and physical-sample chain of custody (Phase 6).

**This is a continuing project. Never restart a completed phase.** The repository is the source of truth for continuity: read the handover files below before doing anything.

## 1. Startup procedure (every session, every account)
1. Read `docs/HANDOVER.md` (exact checkpoint and next action), then `docs/MASTER_HANDOVER.md`.
2. `git status -sb`, `git log --oneline -10`, and confirm the branch is `feature/traced-portal`. Never discard uncommitted work you did not create.
3. Read the latest `docs/phase-N-report.md` and `docs/DECISIONS.md` before changing behaviour.
4. Check whether a local server or database is already running (the user often runs `npm run dev:db` and `npm run dev` in their own terminals). Do not kill those servers.
5. Reconcile what the docs report against the actual code and test results before trusting it.

## 2. Handover procedure
Update `docs/HANDOVER.md` after every meaningful milestone (a module, a migration, an important fix, a test run, a commit, a push) and before stopping. Also update `docs/DEVELOPMENT_PROGRESS.md`, `docs/TEST_STATUS.md` and `docs/CHANGELOG.md` when they change. Never store credentials, keys or patient data in these files.

## 3. Stack (approved; do not replace without explicit approval)
- **Frontend:** the existing static site in `dist/` plus generated portal shells (`npm run build:portal`), vanilla JS under `dist/portal/`, EN/AR dictionaries in `dist/portal/js/i18n/`. Vercel hosts the static site.
- **Backend:** Hono + TypeScript on Node 22 (`server/src`), custom auth/RBAC, checksummed SQL migrations (`server/migrations`).
- **Database:** PostgreSQL. Embedded PostgreSQL (UTF-8) locally and in tests; Cloud SQL in production.
- **QR:** `qrcode` 1.5.4 (generation); vendored `@zxing/browser` 0.2.1 (scanning).
- **Email:** Resend (not yet approved for production) through the mailer abstraction and the `email_outbox` table; dev mailer writes to `.dev-mail/`.
- **Production target (not provisioned):** Cloud Run + Cloud SQL (me-central2) + Secret Manager + Cloud Scheduler. See `docs/architecture.md`.
- **Do not introduce** AWS, Supabase, Render or new frameworks.

## 4. Non-negotiable rules
- **Existing public TRACED pages:** preserve branding, content, animations and EN/AR/RTL. The only permitted changes are the account-link patch (`scripts/patch-traced-account-links.mjs`). `npm run check:portal` must pass.
- **Laboratory privacy (Phase 6):** the lab portal and lab API return no patient identity, age, gender or contact data, only operational sample data. Sample labels carry no personal data. Scanning a sample QR never changes custody; every transition is an explicit, server-validated action in `server/src/modules/custody/custody.service.ts`.
- **Collection-staff privacy:** staff may receive only the patient's **age and gender** plus operational data (tracking ID, sample type, branch, QR validity, status, identity-verification status, instructions, timestamps, custody info). Never send names, email, phone, DOB, national ID/Iqama, nationality, address, or account-holder or guardian data. Enforce this with **server-side response allowlists**, in every endpoint, statistic, error and log.
- **Customers** see only their own data. **Admins** see personal data only through permission-checked, audited endpoints. **Auditors** do not get patient personal data. PII exports need `report.export_pii`.
- **Tracking ID** `TRC-SA-MM/YY-XXXXX` (Asia/Riyadh, monthly atomic sequence). Preserve the engine. It is not a credential.
- **QR tokens:** 256-bit random, never logged, never contain personal data or the tracking ID.
- **Client IP:** never trust the leftmost `X-Forwarded-For`; use `server/src/lib/client-ip.ts` and `TRUSTED_PROXY_HOPS`.
- **Migrations:** never edit an applied migration; add a new numbered one (latest: 0011). Allocate the tracking ID before any audit write; the lock order is registration → patient → session/token → audit.
- **Provisional content** (consent text, collection instructions, identity verification) is not approved for production. Production config refuses provisional content and `DEV_IDENTITY_VERIFICATION`.
- **Committed evidence:** screenshots must never show decodable QR tokens, MFA secrets or recovery codes. The E2E `shot` helpers redact QR codes automatically (`server/test/e2e/redact-qr.ts`), and a test enforces it.
- **Phase 7 security rules:** evidence tables are INSERT + SELECT only for the runtime role (`server/sql/production-roles.sql`; re-run `db-roles.test.ts` after any migration that adds a table and extend the grants). Personal-data exports only through `POST /admin/exports/personal-data` (super admin, fresh TOTP, reason, limits, audited, never stored). Integrity: signed checkpoints + verification (`docs/security/audit-integrity.md`); never "fix" data after a failed verification. Camera browser tests use `cameraPage()` (one Edge instance per camera video). Screenshots are redacted in memory before writing.
- **Windows E2E:** never stop the dev database (`postgres.exe -D …\.dev-db\data`). An orphaned test `io_worker` (parent gone) no longer blocks runs; stop it only with the owner's OK.
- Do not claim anything is done unless it is implemented **and tested**. Keep verified results separate from assumptions.

## 5. Git authorisation
- **Allowed without asking:** commit and push completed, tested work to `feature/traced-portal`.
- **Before every push:** confirm the branch; review the diff; run `npm run typecheck`, `npm test`, `npm run check:portal` (plus `npm run test:e2e` for UI changes); scan for secrets; make sure `.env`, `.dev-db/`, `.dev-mail/` and `test-results/` are excluded; confirm the push triggers no deployment (see `docs/HANDOVER.md` for the last check).
- **Never:** push or merge to `main`, force-push, rewrite history, change repository visibility, provision paid resources, set production credentials, run production migrations, deploy, or start an unapproved phase.
- Repo-local identity is already configured (`git config user.*` in the repo); don't change it.

## 6. Commands
| Task | Command |
|---|---|
| Local DB / API (+ static site on :8787) | `npm run dev:db`, then `npm run dev` |
| Typecheck | `npm run typecheck` |
| Unit + integration tests (real PostgreSQL) | `npm test` |
| Browser tests (Edge, simulated camera, port 8791) | `npm run test:e2e` |
| Performance run (synthetic, throw-away cluster) / backup drill | `npm run test:perf` / `npm run drill:backup` |
| Leftover test PostgreSQL workers (dry run; `--yes` only with the owner's OK) | `node scripts/cleanup-orphan-test-postgres.mjs` |
| Portal shells / nav patch | `npm run build:portal` / `npm run check:portal` |
| Create staff | `npm run create-user -- --email … --role collection_staff --name "…" --branch DEV-RUH-01` (or invite from the admin portal) |
| Local synthetic test accounts (one-time links, no stored passwords) | `npm run dev:test-accounts` (see `docs/manual-testing.md`) |
| Bootstrap the first super admin | `npm run create-user -- --email … --role super_admin --name "…"`, then sign in at `/traced/admin/sign-in/` and set up two-step verification |

More detail: `docs/development.md`.

## 7. Phase workflow
The user approves each phase separately. At the end of a phase: write `docs/phase-N-report.md`, update the handover files, commit and push (if safe), and **stop and wait for approval** before starting the next phase.
