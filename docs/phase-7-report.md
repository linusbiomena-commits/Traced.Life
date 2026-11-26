# TRACED: Phase 7 report — security hardening, reliability, production readiness

Branch `feature/traced-portal`, 26 Nov 2026. Everything ran locally on throw-away databases. **No Google Cloud resource was provisioned, no production credential configured, no production migration applied, nothing deployed.** The user's manual-testing environment (worktree at `8f4c870`, dev DB at migration 0009) was not touched: no Phase 7 migration was applied to the shared dev DB, no password reset, no setup link invalidated.

This report does not claim production readiness, regulatory compliance, physical-device or printer compatibility, or Cloud SQL performance. Production collection stays blocked until a real identity-verification method is approved.

## 1. Deliverables

| Deliverable | File |
|---|---|
| Threat model | `docs/security/threat-model.md` |
| Security assessment (OWASP, findings) | `docs/security/security-assessment.md` |
| Permission matrix (generated from the route × role sweep) | `docs/security/permission-matrix.md` |
| Database permissions | `docs/security/db-permissions.md`, `server/sql/production-roles.sql` |
| Audit integrity + investigation runbook | `docs/security/audit-integrity.md` |
| Privacy review + key management | `docs/security/privacy-review.md` |
| Performance results, connection budget, db-f1-micro review | `docs/performance/results.md`, `docs/performance/README.md` |
| Backup and recovery report | `docs/backup/README.md`, `docs/backup/drill-results.md` |
| Device and printer checklist | `docs/device-checklist.md` (+ `docs/device-testing.md`) |
| Deployment templates | `docs/deploy/` (Dockerfile, Cloud Run, Vercel, IAM, secrets, scheduler, monitoring, billing) |
| Launch checklist | `docs/deploy/launch-checklist.md` |
| Phase 8 deployment plan | `docs/deploy/phase-8-plan.md` |
| Cost estimate | `docs/deploy/cost-estimate.md` |
| Rollback procedure | `docs/deploy/rollback.md` |

## 2. What was built (by milestone)

1. **Threat model**: assets, actors, boundaries, STRIDE table mapped to controls and the tests that prove them; top residual risks.
2. **Authentication hardening**
   - Super-admin "reset two-step verification" for a lost authenticator. It needs a reason, can't be used on your own account, revokes sessions, is audited, and makes the person re-enrol.
   - Self-service recovery-code regeneration, gated by a current authenticator code with replay protection.
   - Production config guards: a scheduler credential is required, the origin must be a public https address, and export limits are bounded.
   - `HOST` setting, needed for Cloud Run.
3. **Privacy review**: data inventory, minimisation checks, processors and cross-border decisions, retention proposal, key management.
4. **Audit and custody hardening**
   - Migration **0010** (additive):
     - signed checkpoints and verification records, both append-only;
     - range verification;
     - a deterministic custody-events digest;
     - TRUNCATE guards on the Phase 6 evidence tables.
   - HMAC-signed checkpoints with the key held outside the database, plus an external JSON copy.
   - Verification: the chain, every recent checkpoint and the external copies in both directions, read in one consistent snapshot.
   - Daily scheduled checkpoint-and-verify.
   - Cloud Scheduler **OIDC** verification (RS256 against Google's keys, no new dependency) alongside the shared secret.
   - `production-roles.sql` rewritten per table and **tested**: the full application runs as `traced_app`, and PostgreSQL refuses everything outside the grants.
5. **Personal-data export** (super admin only):
   - fresh authenticator code required in the request, plus a reason;
   - personal columns are opt-in;
   - limits of 31 days and 2,000 rows by default; oversized exports are refused, not truncated;
   - CSV-injection safe, UTF-8 with BOM, no-store headers, generated in memory, never stored;
   - audited with columns, row count and file SHA-256, never content.
6. **Admin screens (EN/AR)**:
   - Audit integrity: status, history, run verification, sign checkpoint.
   - Personal-data export.
   - "Reset two-step verification" on the staff account page.
   - "Create new recovery codes" in settings.
7. **Performance**:
   - `npm run test:perf` with 12,000 synthetic registrations and 240,000 audit entries, plus `pg_stat_statements`.
   - Fixed: per-day×branch CSV counting, a missing QR-token index, the activity-feed scan, and the verification timeout risk (migration **0011**, additive).
   - Connection budget: 25 on db-f1-micro.
8. **Backup and restore drill**: `npm run drill:backup`. Cold copy of a stopped synthetic cluster, restored on another port:
   - all 34 tables identical;
   - writes made after the backup are absent;
   - hash chain intact;
   - the app works with the same keys and a wrong key cannot decrypt;
   - integrity verification shows the expected after-restore signature.
9. **Outbox reliability**:
   - Stuck sends stop at the attempt limit.
   - Tests: 6 concurrent workers deliver 60 emails exactly once; the idempotency key is stable across retries; still-locked claims are respected; the scheduled endpoint works.
10. **Browser-test infrastructure**:
    - **Root cause of the intermittent camera failures:** Edge opens the fake-camera file once per browser process, and the tests rewrote that shared file. Each camera step now gets its own Edge instance and camera file, with the session carried over.
    - Screenshots are redacted in memory before they are written.
    - `scripts/cleanup-orphan-test-postgres.mjs` stops leftover test Postgres workers. It defaults to a dry run and never touches the dev DB.
11. **Device checklist**: complete test matrix for phones, tablets, scanners and label printers. **Nothing tested on hardware.**
12. **Vulnerability assessment**:
    - `security-probes.test.ts`: headers, CSP, CSRF/Origin, traversal, SQL injection, markup, body limits, malformed JSON, 404 shape, cookie flags, enumeration, rate limit.
    - Route × role sweep.
    - OWASP ZAP not run; reason in the assessment.
13. **Repository and supply chain**:
    - `npm audit`: 0 vulnerabilities.
    - Full-history secret scan: clean (2 false positives).
    - PNG QR scan of all 378 historical images: 16 older versions hold **synthetic** test tokens or MFA secrets from deleted test databases (finding F-03, your decision). `scripts/scan-history-qr.mjs` repeats the scan.
14. **Deployment templates**: in `docs/deploy/`, deliberately not at the repo root.
15. **Launch checklist**: blocking vs non-blocking items.

## 3. Verification

| Check | Result |
|---|---|
| TypeScript | clean |
| Unit + integration (Vitest, real PostgreSQL) | **263 / 263** (23 files) |
| Browser (Playwright, Edge, simulated camera) | **30 / 30** in the last two full runs. One earlier full run had a single staff camera-test failure that did not reproduce (see `docs/TEST_STATUS.md`), and one failed because a unit run read screenshots at the same time, which exposed the redaction write-order bug (fixed) |
| Portal checks | 86 portal shells up to date; 56 public TRACED pages patched exactly as before |
| `npm audit` | 0 |
| Performance run | `docs/performance/results.md` |
| Backup drill | pass, `docs/backup/drill-results.md` |
| Secret / QR history scans | as in §2.13 |

New test files: `authz-matrix`, `auth-hardening`, `audit-integrity`, `db-roles`, `pii-export`, `outbox-reliability`, `security-probes` (Vitest); `security.spec.ts` (Playwright); `perf/load.perf.ts` and `drills/backup-restore.drill.ts` (separate configs).

## 4. Open items and decisions for the owner

- **Before Phase 8:** decisions D1–D10 in `docs/deploy/phase-8-plan.md`. These cover region, API path, email provider, identity verification, DB size, the checkpoint bucket, scheduler auth, status emails, domains and approved devices.
- **F-03:** keep the synthetic historical screenshots (recommended) or approve a history rewrite.
- **Phase 8 code tasks:**
  - a GCS writer for checkpoints;
  - housekeeping purges (expired sessions, tokens, rate limits, old outbox rows);
  - a CI pipeline;
  - Vercel Routing Middleware for the proxy secret.
- **Manual-testing worktree:** still on `8f4c870` and migration 0009. To try the Phase 7 screens it needs an upgrade, which applies 0010 and 0011 to the dev DB. Coordinate before doing that.
- **Leftover test processes:** 7 orphaned PostgreSQL I/O workers from earlier test runs are still on this machine. The cleanup script lists them; stopping them (`--yes`) is your call.

## 5. Effort

Phase 7 ≈ 50 hours (estimate given before the phase: 48–60). Overall about **85%** of total development effort (Phases 0–7 ≈ 325 h of ≈ 360–400 h). Phase 8 is estimated at 25–35 h, plus decision and procurement time.
