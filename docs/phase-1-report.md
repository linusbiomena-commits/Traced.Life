# TRACED Platform: Phase 1 Report

Phase 1: database, authentication and role-based permissions · 26 November 2026 · branch `feature/traced-portal` (local, **not committed or pushed yet**)

Everything ran locally against a local PostgreSQL. Nothing was deployed. No existing site file under `dist/` changed (verified with `git diff -- dist`).

## Completed tasks

| Area | What exists now | Verified by |
|---|---|---|
| Tooling | Node 22 + TypeScript 7 (strict), Hono API, `pg` with plain SQL, Vitest. Local PostgreSQL 18 via `embedded-postgres` (no install/admin rights). | typecheck clean (37 server files), test suite |
| Database | 3 forward-only migrations with checksum protection; runner refuses edited migrations; advisory lock against parallel runs | `database.test.ts` |
| Accounts | `users` table separate from future patient records; lower-case unique email enforced in DB; account statuses active/suspended/deactivated | tests |
| Sign-up | Customers only. Same response for new and existing emails (no account enumeration); the existing owner gets a warning email | tests |
| Email verification | Single-use 24h link, token in URL fragment (kept out of server logs), resend invalidates the old link | tests |
| Sign-in / sign-out | Argon2id passwords; one generic error for every failure; 10 wrong passwords → 15-minute lockout (audited); sign-out revokes server-side | tests |
| Sessions | Opaque 256-bit token, only an HMAC stored; cookie `HttpOnly; SameSite=Strict` (+ `Secure`/`__Host-` in production). Customers: 7 days absolute / 24h idle. Staff/admin: 12h / 30 min idle. Suspension cuts access on the next request | tests |
| Password reset / change | 30-minute single-use link, newer link kills older, signs out all devices, notification email; change requires current password | tests |
| Invited accounts | No public staff/admin registration. `createStaffAccount` (used by the CLI now, by the admin portal in Phase 5): staff roles only, email must be unused, 72h single-use setup link | tests + live CLI run |
| MFA (TOTP) | Required for admin, super admin, lab operator, auditor. Enrolment with QR URL, secret encrypted (AES-256-GCM, bound to the user), replayed codes rejected, 10 single-use recovery codes, session rotated on MFA, 5 guesses / 5 min | tests |
| RBAC | 6 roles, 20 permissions seeded in DB (matching the Phase 0 matrix); `requirePermission` enforces on the server and audits every denial; a test checks DB seed = code catalogue | tests |
| CSRF | Foreign `Origin` rejected, JSON-only bodies, per-session CSRF token required when signed in, SameSite=Strict cookie | tests |
| Rate limiting | Postgres-backed per-IP / per-email(HMAC) / per-user limits on sign-up, sign-in, verify, reset, MFA, with `Retry-After` | tests |
| Audit log | Append-only (UPDATE/DELETE/TRUNCATE rejected by triggers), SHA-256 hash chain with `audit_verify_chain()`; detects even superuser tampering; no emails/tokens in audit rows | tests |
| Admin endpoint | `GET /api/v1/admin/audit-logs` with filters + paging; permission `audit.read` + MFA; each read is itself audited | tests |
| Hardening | `Cache-Control: no-store`, CSP `default-src 'none'`, `X-Frame-Options: DENY`, nosniff, no-referrer, 32 KB body limit, request IDs, generic 500s (no stack traces to clients), production config refuses insecure settings | tests |
| Emails | EN + AR templates (RTL, HTML-escaped) for verify, account-exists, reset, password-changed, account setup. Dev transport writes to `.dev-mail/`; **no real email is sent** | tests + live run |

## API endpoints delivered (`/api/v1`)

`GET /health` · `POST /auth/sign-up` · `POST /auth/verify-email` · `POST /auth/verify-email/resend` · `POST /auth/sign-in` · `POST /auth/sign-out` · `GET /auth/me` · `POST /auth/password/forgot` · `POST /auth/password/reset` · `POST /auth/password/change` · `POST /auth/account-setup` · `POST /auth/mfa/setup` · `POST /auth/mfa/enable` · `POST /auth/mfa/verify` · `GET /admin/audit-logs`

## Files created

- Project: `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`
- Migrations: `server/migrations/0001_identity_access.sql`, `0002_audit_rate_limits.sql`, `0003_seed_roles_permissions.sql`
- Source (`server/src/`): `app.ts`, `index.ts`, `config.ts`, `context.ts`; `db/` (pool, migrate, embedded); `lib/` (crypto, errors, logger, password, validate); `middleware/` (request/CSRF/session, rbac, rate-limit); `modules/auth/` (routes, sessions, tokens, mfa, links); `modules/audit/` (service, routes); `modules/accounts/accounts.service.ts`; `modules/mail/` (mailer, send, templates); `modules/rbac/catalogue.ts`; `cli/` (dev-db, migrate, create-user, gen-keys)
- Tests: `server/test/{unit,database,auth,rbac-mfa}.test.ts`, `server/test/helpers/{global-setup,test-app}.ts`
- Docs: `docs/development.md`, `docs/phase-1-report.md`

About 2,950 lines in `server/`.

## Files modified

- `.gitignore`: added `.dev-db/`, `.dev-mail/`
- `.gitattributes`: LF line endings for `*.sql` and `*.ts` (so migration checksums are stable on Windows)

No file in `dist/` was modified.

## Database changes

New tables: `users`, `roles`, `permissions`, `role_permissions`, `user_roles`, `sessions`, `auth_tokens`, `mfa_recovery_codes`, `audit_logs`, `rate_limits`, `schema_migrations`. Functions/triggers: `set_updated_at`, `reject_modification`, `audit_logs_chain`, `audit_row_digest_input`, `audit_verify_chain`. Seed: 6 roles, 20 permissions, role→permission map. Applied only to throwaway test databases and a local dev database, which was deleted after the smoke test.

## Tests executed and results

- `npm run typecheck`: **pass**, 0 errors.
- `npm test`: **53 / 53 pass** (4 files: unit 12, database 7, auth 22, RBAC/MFA 12) against a real PostgreSQL 18 started for the run. About 19 s.
- Live smoke test on the real server: health, static `/traced/` and `/ar/traced/` (200), JSON 404, sign-up → dev email → verify → sign-in → `/me`, migration CLI run twice (idempotent), `create-user --role super_admin` produced a setup link. **Pass.**
- Two defects found by the tests and fixed: (1) the per-email sign-in limit hid the account lockout, so it was raised from 10 to 20 per 15 minutes and the lockout is now the per-account control; (2) unknown API routes returned plain text instead of JSON.
- An environment issue was also found and fixed: `embedded-postgres` force-kills PostgreSQL on Windows and orphaned an I/O worker, so it is now stopped with `pg_ctl stop -m fast`.

## Security checks completed

Enumeration resistance (sign-up, sign-in, reset); lockout; session revocation on sign-out, reset, password change and suspension; idle/absolute expiry; CSRF (missing/forged token, foreign origin, `Sec-Fetch-Site: cross-site`, form content types); unknown-field rejection; SQL-injection-shaped filter rejected by validation (all queries are parameterised); oversized bodies; security headers; MFA replay, recovery-code reuse, guess limiting; encrypted MFA secrets (tamper and wrong-context decryption fail); audit append-only and tamper detection; no personal data in audit failure rows. `npm audit`: 0 vulnerabilities.

**Not done yet** (Phase 7): OWASP ZAP scan, load testing, browser-level tests, independent review.

## Issues and blockers

1. **No real email provider.** Production start-up is intentionally blocked until Phase 3 adds one (needs your provider + custom domain decision).
2. **The pages behind the emailed links don't exist yet** (`/traced/account/verify-email/` etc.). They come in Phase 2 (customer) and Phase 5 (admin/staff). Until then the flows are API-only.
3. **Hosting region and data residency** are still undecided. This blocks any non-local database.
4. **Production DB roles:** triggers protect the audit log, but production should also run the app as a non-owner role without UPDATE/DELETE on `audit_logs`. I'll prepare that grant script with the hosting decision.
5. Tooling note: TypeScript 7.0 and Vitest 5 are recent majors; both work here. If we hit compatibility trouble later, pinning back is a one-line change.

## Recommended next steps

1. Review this report, then commit + push Phase 1 to `feature/traced-portal` (your approval needed).
2. Decide the registration form fields (National ID/Iqama, nationality) and consent/privacy texts. Phase 2 needs them.
3. Approve Phase 2 (customer portal pages EN/AR, registration form, guardian/patient model, consent capture).

## Completion

- **Phase 1: 100% of its planned scope**, verified by 53 passing tests and a live smoke test. Admin UI for staff management stays in Phase 5 as planned; the service it needs is done and tested.
- **Overall project: about 18%** by the Phase 0 hour estimates (Phases 0–1 ≈ 56 of ≈ 300–390 hours). No customer-, staff- or admin-facing pages exist yet.
