# TRACED: Test Status

Last run: **2026-11-26** on commit `2debbf1` (branch `feature/traced-portal`), Windows 11, Node 22, Microsoft Edge. Independently re-run on the new Claude account.

| Check | Command | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | clean |
| Unit + integration (Vitest, real embedded PostgreSQL 18) | `npm test` | **154 / 154 pass**, 12 files, about 43 s |
| Browser E2E (Playwright, Edge, simulated camera) | `npm run test:e2e` | **16 / 16 pass** (9 customer + 7 staff), about 1.7 min |
| Portal shells + account-link patch | `npm run check:portal` | up to date; all 56 TRACED pages patched |
| Dependencies | `npm audit` | 0 vulnerabilities |
| Secrets in tracked files | key/URL/base64 pattern scan via `git grep` | none found |

## Suites
| File | Area |
|---|---|
| `auth.test.ts`, `rbac-mfa.test.ts` | auth, sessions, lockout, CSRF, MFA, roles |
| `database.test.ts` | migrations, checksums, UTF-8 |
| `registrations.test.ts`, `decisions.test.ts` | customer registrations, approved rules |
| `tracking.test.ts` | tracking ID engine, concurrency, Riyadh month and year boundaries, exhaustion |
| `qr.test.ts` | QR generation, decode, replace, revoke |
| `email.test.ts` | templates, outbox, retries |
| `privacy-verification.test.ts` | staff privacy across routes |
| `staff.test.ts` | Phase 4 collection, identity, permissions, concurrency, canary sweep |
| `frontend.test.ts`, `unit.test.ts` | generated pages, helpers |
| `e2e/portal.spec.ts`, `e2e/staff.spec.ts` | browser flows EN/AR/mobile, simulated camera |

## Notes and limitations
- The browser run regenerates screenshots in `docs/phase-4/screenshots/`. Restore them (`git restore docs/phase-4/screenshots`) unless you mean to update the evidence.
- The `pg pool error ECONNRESET` lines at the end of an E2E run come from tearing down the throwaway database. They are expected.
- **No physical-device testing** (Android, iPhone, tablet, webcam, USB scanner). The procedure is in `docs/device-testing.md`.
- No load or performance testing against Cloud SQL `db-f1-micro`, no OWASP ZAP scan, and no backup/restore test yet (Phase 7).
- All test data is synthetic (`example.com` addresses, `[DEV]` branches).
