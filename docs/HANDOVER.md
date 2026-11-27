# TRACED: Continuation Checkpoint

**Last updated:** 2026-11-27, Phase 8 preparation (Stage 8A done), Claude account 2.

| Item | State |
|---|---|
| Branch | `feature/traced-portal` (GitHub default branch) |
| Commits | Phase 7: `91ea577`, `f594b4c`, `9ca24b3`, `8682bb3`, `dee1101`; Phase 8 preparation commit after `dee1101` (see `git log -1`) |
| Push status | see `git status -sb` (pushed if the pre-push checks passed; see the commit/push note in the latest session) |
| Current phase | **Phase 8B authorised (2026-11-27) but BLOCKED at billing.** Stage 8A done. Project `traced-production` exists; no billable resource created. Stages 8C–8D not authorised |
| Local migrations | dev DB (`.dev-db`, port 54329) at **0011** since 2026-11-26 |
| Production migrations | **none**: no production database exists |
| Local servers | dev DB on :54329 (preview `traced-db`), manual portal on :8787 (preview `traced-portal-manual`, worktree `../Traced Website (manual testing)` detached at `dee1101`). Both were restarted on 2026-11-27 after an unclean stop (app restart); data re-verified identical |
| Local backup | `.dev-db-backups/2026-11-26T17-43-44-118Z/` (online backup taken before the upgrade, restore verified 32/32 tables; gitignored; contains test personal data) |
| Completed (this stage) | dev DB online backup CLI (`npm run dev:db-backup`) + verified restore; worktree upgrade to `dee1101`; migrations 0010–0011 applied; data integrity verified twice; Phase 7 manual-testing guide (`docs/manual-testing.md` §7–8); verified Dammam prices; `docs/deploy/phase-8-preparation.md` (project, IAM matrix, Cloud Run/SQL commands, secret inventory, Vercel review, scheduler, checkpoint destination, Resend, billing, release gate, decisions D1–D13); `docs/deploy/cost-estimate.md` rewritten; `production-roles.sql` made Cloud SQL compatible; time-of-day test bug fixed |
| Tests | typecheck clean; `npm test` **263/263**; `check:portal` pass; browser suite last run 30/30 twice (Phase 7; UI unchanged since). Open: one earlier intermittent staff camera failure, not reproduced |
| Cost estimate | ≈ USD 16.6–18.3/month ex VAT ≈ **SAR 62–69 ex VAT / SAR 72–79 incl. 15% VAT** for 100–1,000 registrations (Cloud SQL db-f1-micro Dammam $0.0168/h is ~90%). Resend paid plan likely at ~1,000 registrations |
| Known bugs | none open. Fixed: admin audit-log test used a UTC date for a Riyadh-date filter (failed 00:00–03:00 Riyadh) |
| Machine housekeeping | 7 orphaned test PostgreSQL `io_worker` processes left running by the owner's decision. `node scripts/cleanup-orphan-test-postgres.mjs` lists them (dry run); `--yes` only with authorisation. Never stop the dev DB on 54329 |
| Outstanding approvals | Dammam-eligible billing for `traced-production` (see below); decisions D1–D13 (`docs/deploy/phase-8-preparation.md` §13); release gate items (§12); repository privacy (P2); F-03 decision |

## Public website (live since 2026-11-27)
https://tracedlife.vercel.app serves the public TRACED pages only (Vercel team `linus-bio-mena`, project `tracedlife`). Build: `vercel.json` → `node scripts/build-public-site.mjs` → `.vercel-public`; `.vercelignore` limits uploads to `dist/`, the script and `vercel.json`. The project is connected to `linusbiomena-commits/Traced.Life` with production branch `main`; pushes to `feature/traced-portal` create protected previews. The portal stays undeployed until Stage 8B onwards are authorised.

## Push safety evidence (before the public website)
Before each push: GitHub API 0 deployments / 0 environments for `Traced.Life`; no `vercel.json`, `.vercel/` or workflow files at the repo root. The live `linusbiomena.vercel.app/traced/` is byte-identical to the separate *LinusBio MENA Website* `dist` (last modified 23 Nov) and returns 404 for every portal path, so it is not deployed from this repository.

## Phase 8B status (2026-11-27)
- gcloud: `C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdkin` (not on the Git Bash PATH). Account `info@karamaitco.com`, organization `karama.tech` (248110031194).
- CLI configuration `traced` (account above, project `traced-production`); the `default` configuration is unchanged and stays active. Always pass `--configuration=traced --project=traced-production`.
- Project **`traced-production`** ("TRACED Production", number 348373850999, in the karama.tech organization). Owner: `info@karamaitco.com` only.
- Billing: linked by the owner in the Console to **My Billing Account** `01986E-D718F1-EB1000` (direct Google, USD).
- **Blocker:** me-central2 (Dammam) is refused for this project: `PERMISSION_DENIED … Access to the region is unavailable`, reason `LOCATION_POLICY_VIOLATED` (tested with a free, empty Artifact Registry repository; nothing was created). The organization's `gcp.resourceLocations` policy allows all regions, so the block is Google's Dammam access rule: KSA billing addresses must buy through CNTXT, and non-KSA accounts need Invoiced Billing (https://docs.cloud.google.com/docs/dammam-region-access).
- The organization also has a CNTXT billing account `0163A0-16AE0A-B5E653` (`cntxt-online-7033988770-karamait`, USD, sub-account of `01B690-580625-91AA15`). `info@karamaitco.com` has only `roles/billing.viewer` there.
- Enabled so far (free): Artifact Registry API plus the default APIs Google enables on new projects. No budget, service account, secret, database, bucket or repository exists yet.

## Exact next action
Wait until `traced-production` is on a Dammam-eligible billing account (normally the CNTXT account, with `roles/billing.user` granted to `info@karamaitco.com`, or Invoiced Billing set up), then re-run the free me-central2 test and continue Phase 8B. Do not switch regions or billing accounts without the owner's approval.
