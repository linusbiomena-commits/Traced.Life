# TRACED: Continuation Checkpoint

**Last updated:** 2026-11-27 (evening), Oracle server + database live and verified; API not started; launch target 1 Dec 2026, Claude account 2.

| Item | State |
|---|---|
| Branch | `feature/traced-portal` (GitHub default branch) |
| Commits | Phase 7: `91ea577`, `f594b4c`, `9ca24b3`, `8682bb3`, `dee1101`; Phase 8 preparation commit after `dee1101` (see `git log -1`) |
| Push status | see `git status -sb` (pushed if the pre-push checks passed; see the commit/push note in the latest session) |
| Current phase | **Phase 8 on Oracle Cloud (Riyadh): server `traced-app-1` RUNNING, PostgreSQL 18.7 migrated 0001–0011 and verified, encrypted backups + real restore test passed.** The API is not started (needs Resend + API host name). Launch target **1 Dec 2026** (`docs/deploy/launch-plan-1-dec.md`) |
| Local migrations | dev DB (`.dev-db`, port 54329) at **0011** since 2026-11-26 |
| Production migrations | **none**: no production database exists |
| Local servers | dev DB on :54329 (preview `traced-db`), manual portal on :8787 (preview `traced-portal-manual`, worktree `../Traced Website (manual testing)` detached at `dee1101`). Both were restarted on 2026-11-27 after an unclean stop (app restart); data re-verified identical |
| Local backup | `.dev-db-backups/2026-11-26T17-43-44-118Z/` (online backup taken before the upgrade, restore verified 32/32 tables; gitignored; contains test personal data) |
| Completed (this stage) | dev DB online backup CLI (`npm run dev:db-backup`) + verified restore; worktree upgrade to `dee1101`; migrations 0010–0011 applied; data integrity verified twice; Phase 7 manual-testing guide (`docs/manual-testing.md` §7–8); verified Dammam prices; `docs/deploy/phase-8-preparation.md` (project, IAM matrix, Cloud Run/SQL commands, secret inventory, Vercel review, scheduler, checkpoint destination, Resend, billing, release gate, decisions D1–D13); `docs/deploy/cost-estimate.md` rewritten; `production-roles.sql` made Cloud SQL compatible; time-of-day test bug fixed |
| Tests | typecheck clean; `npm test` **272/272** (27 Nov 2026, incl. 9 Oracle layout tests); `check:portal` pass; browser suite last run 30/30 twice (Phase 7; UI unchanged since). Open: one earlier intermittent staff camera failure, not reproduced |
| Cost estimate | ≈ USD 16.6–18.3/month ex VAT ≈ **SAR 62–69 ex VAT / SAR 72–79 incl. 15% VAT** for 100–1,000 registrations (Cloud SQL db-f1-micro Dammam $0.0168/h is ~90%). Resend paid plan likely at ~1,000 registrations |
| Known bugs | none open. Fixed: admin audit-log test used a UTC date for a Riyadh-date filter (failed 00:00–03:00 Riyadh) |
| Machine housekeeping | 7 orphaned test PostgreSQL `io_worker` processes left running by the owner's decision. `node scripts/cleanup-orphan-test-postgres.mjs` lists them (dry run); `--yes` only with authorisation. Never stop the dev DB on 54329 |
| Outstanding approvals | the consolidated list D-A…D-O in `docs/deploy/launch-plan-1-dec.md` §3 (API host name/DNS, open 443, Resend + key in Vault, sender, Resend privacy, site origin + portal deploy, first super admins, proxy secret, identity verification, pilot model, audit compartment, company account, monitoring, content approvals, release) |

## Public website (live since 2026-11-27)
https://tracedlife.vercel.app serves the public TRACED pages only (Vercel team `linus-bio-mena`, project `tracedlife`). Build: `vercel.json` → `node scripts/build-public-site.mjs` → `.vercel-public`; `.vercelignore` limits uploads to `dist/`, the script and `vercel.json`. The project is connected to `linusbiomena-commits/Traced.Life` with production branch `main`; pushes to `feature/traced-portal` create protected previews. The portal stays undeployed until Stage 8B onwards are authorised.

## Push safety evidence (before the public website)
Before each push: GitHub API 0 deployments / 0 environments for `Traced.Life`; no `vercel.json`, `.vercel/` or workflow files at the repo root. The live `linusbiomena.vercel.app/traced/` is byte-identical to the separate *LinusBio MENA Website* `dist` (last modified 23 Nov) and returns 404 for every portal path, so it is not deployed from this repository.

## Oracle Cloud status (2026-11-27 evening)
- **Server and database live:** see `docs/deploy/oci-hosting-report.md` for every check actually run.
  - `traced-app-1` was launched at 14:08 UTC after the Pay As You Go upgrade completed (plan PAYG, account type still PERSONAL).
  - It is managed only through OCI Run Command (`deploy/oci/vmrun.sh`); there is no SSH and no inbound port.
  - PostgreSQL 18.7 container has no published port; the `traced` database is owned by `traced_migrator`; migrations 0001–0011 applied and checksums verified; production roles applied.
  - `vm_03` security checks passed.
  - Nightly encrypted backup runs at 01:30 Riyadh time; a real backup + restore check passed with 34/34 tables.
- **API:** image `traced-api:67e0161` built on the server, **not started**. `vm_07_api_install.sh` (Caddy HTTPS, timers, checkpoint upload) is prepared and not run.
- **Session tokens expire after about 1 h** and can only be refreshed while still valid; re-run `oci session authenticate` (browser) when `lib.sh` reports it.
- **Backup host:** SCCC by stc assessed (`docs/deploy/sccc-assessment.md`): over budget, KMS secrets USD 500/month, key facts unverified. Recommendation: stay on Oracle.

## Oracle Cloud history (2026-11-27)
- Full record and plan: `docs/deploy/oci-plan.md`.
- OCI CLI 3.97.1 in `%USERPROFILE%\oci-cli-venv` (`Scripts\oci.exe`). Auth: `oci session authenticate --region me-riyadh-1 --profile-name TRACED` (browser sign-in, session token about 1 h; `oci session refresh --profile TRACED`). Use `--profile TRACED --auth security_token`. No API keys exist.
- Tenancy `karamait`, home region **me-riyadh-1** (only subscribed region, one AD). Subscription FREE_TIER in its trial (PROMO), account type PERSONAL, currency EUR, billing country SA.
- Created (free): compartment `TRACED`; tag namespace `KaRamaIT` (Project, Environment, CostCenter; cost-tracking) with tag defaults on TRACED; budget `TRACED-monthly` EUR 23.25 with actual 50/80/100% + forecast 100% alerts to info@karamaitco.com; groups `TRACED-Operators`, `KaRamaIT-Finance-Readers` (no members); dynamic group `TRACED-Instances`; policies `TRACED-Operators-Policy`, `KaRamaIT-Finance-Readers-Policy`, `TRACED-Workload-Policy`.
- **Hosting approved by the owner (27 Nov 2026).** Created since: network with no ingress (`traced-vcn`, `traced-subnet-app`, `traced-nsg-app`, `traced-sl-no-ingress`), Vault `traced-vault` + key `traced-master-key` + 9 secrets, buckets `traced-db-backups` (35-day lifecycle) and `traced-audit-checkpoints` (retention 400 days, unlocked), `TRACED-Services-Policy`, Run Command line in `TRACED-Workload-Policy`. Inventory: `docs/deploy/oci-plan.md` §8a.
- **Server not created:** `launch-vm.sh` got *Out of host capacity* 4 times (plus one HTTP 429), and again on a single owner-requested attempt at 13:54 UTC on 27 Nov (HTTP 500 `InternalError`, opc-request-id `EA359FBEE40041B79645745290232EAC/…`; subscription FREE_TIER, upgrade state SUBMITTED). Nothing was left behind. Retries stopped at the owner's request. Pay As You Go upgrade requested by the owner, Console says "in progress". Do not change shape or region.
- Deployment scripts: `deploy/oci/` (README lists order and test status). Local test `server/test/oci-db-layout.test.ts` proves the database layout; Docker/psql/cloud-init steps are untested until the VM exists.
- Estimated cost: EUR 0 within Always Free; worst case EUR 13.52 ≈ SAR 64 incl. VAT; budget SAR 110 incl. VAT unchanged.

## Phase 8B status on Google Cloud (2026-11-27, superseded)
- gcloud: `C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin` (not on the Git Bash PATH). Account `info@karamaitco.com`, organization `karama.tech` (248110031194).
- CLI configuration `traced` (account above, project `traced-production`); the `default` configuration is unchanged and stays active. Always pass `--configuration=traced --project=traced-production`.
- Project **`traced-production`** ("TRACED Production", number 348373850999, in the karama.tech organization). Owner: `info@karamaitco.com` only.
- Billing: linked by the owner in the Console to **My Billing Account** `01986E-D718F1-EB1000` (direct Google, USD).
- **Blocker:** me-central2 (Dammam) is refused for this project: `PERMISSION_DENIED … Access to the region is unavailable`, reason `LOCATION_POLICY_VIOLATED` (tested with a free, empty Artifact Registry repository; nothing was created). The organization's `gcp.resourceLocations` policy allows all regions, so the block is Google's Dammam access rule: KSA billing addresses must buy through CNTXT, and non-KSA accounts need Invoiced Billing (https://docs.cloud.google.com/docs/dammam-region-access).
- The organization also has a CNTXT billing account `0163A0-16AE0A-B5E653` (`cntxt-online-7033988770-karamait`, USD, sub-account of `01B690-580625-91AA15`). `info@karamaitco.com` has only `roles/billing.viewer` there.
- Enabled so far (free): Artifact Registry API plus the default APIs Google enables on new projects. No budget, service account, secret, database, bucket or repository exists yet.

## Exact next action
Follow `docs/deploy/api-go-live-guide.md` §11 as the owner's inputs arrive: domain, Resend domain verified, key in Vault, sender address, two admin emails. Restricted preview first: `vm_02 … traced_preview`, `vm_07 … preview`, Vercel Preview env (`TRACED_BUILD_PORTAL=1`, API origin, proxy secret), and root `middleware.ts` from the template. Switch to production only after the release gate and approved consent texts (D-N). The earlier plan text follows.
Get the owner's decisions D-A…D-H (`docs/deploy/launch-plan-1-dec.md` §3; target 28 Nov 18:00 Riyadh). Then: reserve the public IP, have DNS pointed, open 443/80 on `traced-nsg-app`, the owner stores `traced-resend-api-key` in Vault, generate `traced-proxy-secret`, run `vm_07_api_install.sh`, test on a Vercel preview with `docs/deploy/vercel-middleware.example.ts`, create the first super admins, run the 30 Nov regression on the deployed preview. Never start collection in production without an approved identity verification method; never accept real patient data before the release gate.
