# TRACED: Test Status

Last updated: **2026-11-26**, end of Phase 6 (branch `feature/traced-portal`), Windows 11, Node 22, Microsoft Edge.

| Check | Command | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | clean (final Phase 5 code) |
| Unit + integration (Vitest, real embedded PostgreSQL 18) | `npm test` | **216 / 216 pass**, 16 files: 154 Phases 1–4 + 12 proxy + 33 admin + 1 evidence + 4 local-account CLI + 12 custody |
| Portal shells + account-link patch | `npm run check:portal` | 62 portal shells up to date; all 56 TRACED pages patched (no public page changed) |
| Dependencies | `npm audit` | 0 vulnerabilities |
| Secrets / sensitive data in tracked files | `git grep` pattern scan + screenshot QR check | none found |
| **Browser E2E (Playwright, Edge, simulated camera)** | `npm run test:e2e` | **27 / 27 pass** (9 customer + 7 staff + 6 admin + 2 login/routing + 3 custody), about 3 min |

## Suites
| File | Area |
|---|---|
| `auth.test.ts`, `rbac-mfa.test.ts` | auth, sessions, lockout, CSRF, MFA, roles |
| `database.test.ts` | migrations, checksums, UTF-8 |
| `registrations.test.ts`, `decisions.test.ts` | customer registrations, approved rules |
| `tracking.test.ts` | tracking ID engine |
| `qr.test.ts`, `email.test.ts` | QR, outbox |
| `privacy-verification.test.ts`, `staff.test.ts` | staff privacy and collection |
| `proxy.test.ts` (Phase 5) | trusted-proxy client IP, spoofing, config |
| `admin.test.ts` (Phase 5) | admin access matrix, MFA, every admin feature, concurrency, privacy canary |
| `frontend.test.ts`, `unit.test.ts` | generated pages, translations, helpers |
| `dev-accounts.test.ts` (Stage A) | local test-account CLI safety |
| `custody.test.ts` (Phase 6) | sample IDs, sample QR, labels, transition matrix, concurrency, lab, rejection/recollection, admin custody, privacy |
| `e2e/portal.spec.ts`, `e2e/staff.spec.ts`, `e2e/admin.spec.ts`, `e2e/login.spec.ts`, `e2e/tracking-custody.spec.ts` | browser flows EN/AR/mobile, simulated camera |

## Notes and limitations
- **Windows browser-test stability:** close every extra browser context a test opens (leftover pages slow later camera decodes); screenshots are written with retries (`saveScreenshot`, file locks from sync/antivirus); the custody spec sorts after the staff spec because Edge shares one fake camera device per browser process.
- **Windows harness issue (mitigated):** Playwright force-kills the E2E server, and an embedded-PostgreSQL `io_worker` can survive as an orphan holding files in its data directory. This used to block the next run. Since Phase 5 finalisation, each run uses its own `test-results/e2e-pg/run-…` directory and old ones are removed best-effort, so a leftover can't block a run (tested with a locked directory). An orphan may still linger until stopped: it's a `postgres.exe --forkchild="io_worker"` from this project whose parent process no longer exists. Never stop the dev database (`-D …\.dev-db\data -p 54329`).
- Browser runs regenerate `docs/phase-4/screenshots/` and `docs/phase-5/screenshots/`. All screenshot helpers redact sensitive QR codes automatically (`server/test/e2e/redact-qr.ts`); the MFA key and recovery codes are masked before capture.
- `pg pool error ECONNRESET` lines at the end of an E2E run come from database teardown and are expected.
- No physical-device tests, no load testing on Cloud SQL `db-f1-micro`, no OWASP ZAP, no backup/restore test (Phase 7).
- All test data is synthetic (`example.com`, `[DEV]` branches).
