# TRACED: Test Status

Last updated: **2026-11-26**, end of Phase 5 (branch `feature/traced-portal`), Windows 11, Node 22, Microsoft Edge.

| Check | Command | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | clean (final Phase 5 code) |
| Unit + integration (Vitest, real embedded PostgreSQL 18) | `npm test` | **199 / 199 pass**, 14 files (final Phase 5 code): 154 Phase 1–4 + 12 proxy + 33 admin |
| Portal shells + account-link patch | `npm run check:portal` | 62 portal shells up to date; all 56 TRACED pages patched (no public page changed) |
| Dependencies | `npm audit` | 0 vulnerabilities |
| **Browser E2E (Playwright, Edge, simulated camera)** | `npm run test:e2e` | **22 / 22 pass** on the final Phase 5 code (6 admin + 9 customer + 7 staff), about 2.0 min |

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
| `e2e/portal.spec.ts`, `e2e/staff.spec.ts`, `e2e/admin.spec.ts` | browser flows EN/AR/mobile |

## Notes and limitations
- **Known harness issue (Windows):** Playwright force-kills the E2E server, and an embedded-PostgreSQL `io_worker` can survive as an orphan. Its presence makes the next E2E run time out on start-up ("Timed out waiting … config.webServer"). Workaround: stop the orphaned `postgres.exe` whose parent process no longer exists (not the dev database), then re-run. To make the harness robust, use a per-run data directory and port (proposed for Phase 7).
- Browser runs regenerate `docs/phase-4/screenshots/`; restore them with `git restore docs/phase-4/screenshots` unless updating evidence.
- `pg pool error ECONNRESET` lines at the end of an E2E run come from database teardown and are expected.
- No physical-device tests, no load testing on Cloud SQL `db-f1-micro`, no OWASP ZAP, no backup/restore test (Phase 7).
- All test data is synthetic (`example.com`, `[DEV]` branches).
