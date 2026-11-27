# TRACED: Test Status

Last updated: **2026-11-27**, Phase 8 (Oracle Cloud governance; no application change), Windows 11, Node 22, Microsoft Edge.

| Check | Command | Result |
|---|---|---|
| TypeScript | `npm run typecheck` | clean |
| Unit + integration (Vitest, real embedded PostgreSQL 18) | `npm test` | **271 / 271 pass**, 24 files (27 Nov 2026: + oci-db-layout; Phase 7 added authz-matrix, auth-hardening, audit-integrity, db-roles, pii-export, outbox-reliability, security-probes) |
| Portal shells + account-link patch | `npm run check:portal` | 86 portal shells up to date; all 56 TRACED pages patched (no public page changed) |
| Dependencies | `npm audit` | 0 vulnerabilities |
| Secrets / sensitive data in tracked files | `git grep` pattern scan + screenshot QR check | none found |
| **Browser E2E (Playwright, Edge, simulated camera)** | `npm run test:e2e` | **30 / 30 pass** (re-run 27 Nov 2026, 4.6 min) |
| Performance (synthetic, throw-away cluster) | `npm run test:perf` | pass; `docs/performance/results.md` |
| Backup/restore drill | `npm run drill:backup` | pass; `docs/backup/drill-results.md` |

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
| `authz-matrix.test.ts` (Phase 7) | every route × 7 roles; writes `docs/security/permission-matrix.md` with `UPDATE_MATRIX=1` |
| `auth-hardening.test.ts`, `pii-export.test.ts` (Phase 7) | MFA reset, recovery codes, production config guards, personal-data export |
| `audit-integrity.test.ts`, `db-roles.test.ts` (Phase 7) | checkpoints, tamper detection, scheduler OIDC; app running as `traced_app` |
| `outbox-reliability.test.ts`, `security-probes.test.ts` (Phase 7) | outbox concurrency; OWASP probes |
| `e2e/security.spec.ts` (Phase 7) | audit integrity, export, recovery codes, MFA reset in the browser |
| `e2e/portal.spec.ts`, `e2e/staff.spec.ts`, `e2e/admin.spec.ts`, `e2e/login.spec.ts`, `e2e/tracking-custody.spec.ts` | browser flows EN/AR/mobile, simulated camera |

## Notes and limitations
- **Windows browser-test stability:** close every extra browser context a test opens; screenshots are redacted in memory and written with retries (`saveScreenshot`). **Phase 7 root cause of camera flakiness:** Edge opens the fake-camera file once per browser process, so camera steps now run in their own Edge instance with their own file (`cameraPage()` in `fake-camera.ts`).
- Do not run `npm test` and `npm run test:e2e` at the same time: the evidence test reads screenshots while the browser run rewrites them.
- **Windows harness issue (mitigated):** Playwright force-kills the E2E server, and an embedded-PostgreSQL `io_worker` can survive as an orphan holding files in its data directory. This used to block the next run. Since Phase 5 finalisation, each run uses its own `test-results/e2e-pg/run-…` directory and old ones are removed best-effort, so a leftover can't block a run (tested with a locked directory). An orphan may still linger until stopped: it's a `postgres.exe --forkchild="io_worker"` from this project whose parent process no longer exists. Never stop the dev database (`-D …\.dev-db\data -p 54329`).
- Browser runs regenerate `docs/phase-4/screenshots/` and `docs/phase-5/screenshots/`. All screenshot helpers redact sensitive QR codes automatically (`server/test/e2e/redact-qr.ts`); the MFA key and recovery codes are masked before capture.
- `pg pool error ECONNRESET` lines at the end of an E2E run come from database teardown and are expected.
- No physical-device or printer tests; no Cloud SQL `db-f1-micro` measurement (local synthetic run only); no OWASP ZAP run (automated probes instead); backup drill is a local cold copy, not Cloud SQL PITR.
- **Observed once, not reproduced (Phase 7):** in one full browser run the staff "full collection with the simulated camera" test failed a visibility check; it passed alone and in the next two full runs (30/30 each). Details were overwritten by the following run. Watch for it; if it recurs, keep `test-results/e2e-artifacts` before re-running.
- **Fixed 2026-11-27:** `admin.test.ts` audit-log filter test built "today" as a UTC date while the filter uses Riyadh dates, so it failed between 00:00 and 03:00 Riyadh. It now uses `riyadhToday()`.
- **Not yet proven:** `server/sql/production-roles.sql` on the production database. Hosting is now a self-managed PostgreSQL on Oracle Cloud (real superuser), the same model as the local tests; it still has to be run on the real server.
- **Oracle database layout (new, 27 Nov 2026):** `server/test/oci-db-layout.test.ts`, 8 tests on a dedicated PostgreSQL 18 cluster. Non-superuser `traced_migrator` owns and migrates the schema (second run verifies checksums). The superuser applies `production-roles.sql`. `traced_app` and `traced_readonly` log in with passwords and are refused evidence changes, DDL, role switching, `COPY TO PROGRAM`, writes and personal data. Outsiders cannot connect. The restore-check query works.
- **Ran on the Oracle server (27 Nov 2026):** `vm_00`–`vm_06`: PostgreSQL setup, migrations 0001–0011 (checksums re-verified), production roles, security verification (all denials as expected), real encrypted backup and restore (34/34 tables), hardening. External port scan: 22/80/443/5432/111 closed. Details: `docs/deploy/oci-hosting-report.md`. `vm_07` (API) not run yet.
- **Superseded note:** the VM scripts in `deploy/oci/vm/` (Docker, `psql` meta-commands, cloud-init, ARM image build, gpg, systemd). No Docker/psql on the admin PC; they run first on the VM. All scripts pass `bash -n`. No cloud server exists yet.
- All test data is synthetic (`example.com`, `[DEV]` branches).
