# TRACED: Continuation Checkpoint

**Last updated:** 2026-11-26, end of Phase 7.

| Item | State |
|---|---|
| Branch | `feature/traced-portal` (also GitHub's *default* branch) |
| Commits | Phase 6 final `8f4c870`; Phase 7: `91ea577`, `f594b4c`, `9ca24b3`, `8682bb3` + the Phase 7 docs/finalisation commit (see `git log`) |
| Push status | see `git status -sb` (Phase 7 pushed at the end of the phase if the pre-push checks passed) |
| Current phase | **Phase 7 complete (local only)**; **Phase 8 not authorised** |
| Last completed task | Phase 7 report and deliverables (`docs/phase-7-report.md`) |
| Current unfinished task | none |
| Database migrations | 0001–0011. **The owner's dev DB is still at 0009** (manual-testing worktree at `8f4c870`). Upgrading the worktree applies 0010–0011: coordinate with the owner first |
| Running services | Manual-testing portal on :8787 from `../Traced Website (manual testing)` (detached at `8f4c870`) + dev DB on :54329 (`.dev-db/data`). Not touched in Phase 7 |
| Tests executed | typecheck clean; `npm test` **263 / 263**; `npm run test:e2e` **30 / 30**; `check:portal` pass; `npm audit` 0; `npm run test:perf` and `npm run drill:backup` pass; history secret + QR scans done |
| Failed tests | none in the final run |
| Known bugs | none open. Phase 7 fixes: outbox endless retry on crashing sends; integrity verification timeout risk; CSV per-day counting; missing QR-token index; screenshot written before redaction (now in memory); shared fake-camera file race |
| Outstanding checks | physical devices and printers; real proxy chain; Cloud SQL performance; staging restore drill |
| Blockers | Phase 8 approval and decisions D1–D10; F-03 (historical synthetic QR screenshots) decision; approvals in `docs/DECISIONS.md` |
| Machine housekeeping | 7 orphaned test PostgreSQL `io_worker` processes listed by `node scripts/cleanup-orphan-test-postgres.mjs` (dry run). Stop only with the owner's OK |

## Push safety evidence
Re-checked before the Phase 7 push: GitHub API 0 deployments / 0 environments; no `vercel.json`, `.vercel/` or workflow files at the repo root (deployment templates are under `docs/deploy/` only); the live `linusbiomena.vercel.app` portal paths return 404.

## Exact next action
Wait for the owner's explicit authorisation before any Google Cloud provisioning or deployment (Phase 8). Do not start Phase 8 without it.
