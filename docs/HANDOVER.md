# TRACED: Continuation Checkpoint

**Last updated:** 2026-11-27, Phase 8 preparation (Stage 8A done), Claude account 2.

| Item | State |
|---|---|
| Branch | `feature/traced-portal` (GitHub default branch) |
| Commits | Phase 7: `91ea577`, `f594b4c`, `9ca24b3`, `8682bb3`, `dee1101`; Phase 8 preparation commit after `dee1101` (see `git log -1`) |
| Push status | see `git status -sb` (pushed if the pre-push checks passed; see the commit/push note in the latest session) |
| Current phase | **Phase 8 preparation.** Stage **8A done** (local upgrade). Stages 8B–8D **not authorised** |
| Local migrations | dev DB (`.dev-db`, port 54329) at **0011** since 2026-11-26 |
| Production migrations | **none**: no production database exists |
| Local servers | dev DB on :54329 (preview `traced-db`), manual portal on :8787 (preview `traced-portal-manual`, worktree `../Traced Website (manual testing)` detached at `dee1101`). Both were restarted on 2026-11-27 after an unclean stop (app restart); data re-verified identical |
| Local backup | `.dev-db-backups/2026-11-26T17-43-44-118Z/` (online backup taken before the upgrade, restore verified 32/32 tables; gitignored; contains test personal data) |
| Completed (this stage) | dev DB online backup CLI (`npm run dev:db-backup`) + verified restore; worktree upgrade to `dee1101`; migrations 0010–0011 applied; data integrity verified twice; Phase 7 manual-testing guide (`docs/manual-testing.md` §7–8); verified Dammam prices; `docs/deploy/phase-8-preparation.md` (project, IAM matrix, Cloud Run/SQL commands, secret inventory, Vercel review, scheduler, checkpoint destination, Resend, billing, release gate, decisions D1–D13); `docs/deploy/cost-estimate.md` rewritten; `production-roles.sql` made Cloud SQL compatible; time-of-day test bug fixed |
| Tests | typecheck clean; `npm test` **263/263**; `check:portal` pass; browser suite last run 30/30 twice (Phase 7; UI unchanged since). Open: one earlier intermittent staff camera failure, not reproduced |
| Cost estimate | ≈ USD 16.6–18.3/month ex VAT ≈ **SAR 62–69 ex VAT / SAR 72–79 incl. 15% VAT** for 100–1,000 registrations (Cloud SQL db-f1-micro Dammam $0.0168/h is ~90%). Resend paid plan likely at ~1,000 registrations |
| Known bugs | none open. Fixed: admin audit-log test used a UTC date for a Riyadh-date filter (failed 00:00–03:00 Riyadh) |
| Machine housekeeping | 7 orphaned test PostgreSQL `io_worker` processes left running by the owner's decision. `node scripts/cleanup-orphan-test-postgres.mjs` lists them (dry run); `--yes` only with authorisation. Never stop the dev DB on 54329 |
| Outstanding approvals | Stage 8B provisioning; decisions D1–D13 (`docs/deploy/phase-8-preparation.md` §13); release gate items (§12); repository privacy (P2); F-03 decision |

## Push safety evidence
Before each push: GitHub API 0 deployments / 0 environments for `Traced.Life`; no `vercel.json`, `.vercel/` or workflow files at the repo root. The live `linusbiomena.vercel.app/traced/` is byte-identical to the separate *LinusBio MENA Website* `dist` (last modified 23 Nov) and returns 404 for every portal path, so it is not deployed from this repository.

## Exact next action
Wait for the owner's explicit authorisation before creating any Google Cloud resource (Stage 8B). Do not create projects, databases, secrets, buckets, budgets or DNS records, and do not change Vercel, until then.
