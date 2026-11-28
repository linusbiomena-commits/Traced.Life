# TRACED: Continuation Checkpoint

**Last updated:** 2026-11-28, final UAT of the restricted pilot on https://www.tracedmena.life passed (`docs/deploy/final-user-acceptance-report.md`).

| Item | State |
|---|---|
| Branch | `feature/traced-portal` (GitHub default branch) |
| Commits | Phase 7: `91ea577`, `f594b4c`, `9ca24b3`, `8682bb3`, `dee1101`; Phase 8 preparation commit after `dee1101` (see `git log -1`) |
| Push status | see `git status -sb` (pushed if the pre-push checks passed; see the commit/push note in the latest session) |
| Current phase | **Restricted pilot LIVE at https://www.tracedmena.life** (28 Nov): marketing public; portals + `/api/v1` behind the pilot gate on every host; API origin www on `traced_preview`; production DB `traced` clean (0 users). Rollback checkpoint `dpl_9WTxpjM6hhSyzXJjHX8RKw8vpF9n`. Docs: `docs/deploy/www-pilot-rollout.md`, `preview-testing-guide.md` |
| Local migrations | dev DB (`.dev-db`, port 54329) at **0011** since 2026-11-26 |
| Production migrations | **none**: no production database exists |
| Local servers | dev DB on :54329 (preview `traced-db`), manual portal on :8787 (preview `traced-portal-manual`, worktree `../Traced Website (manual testing)` detached at `dee1101`). Both were restarted on 2026-11-27 after an unclean stop (app restart); data re-verified identical |
| Local backup | `.dev-db-backups/2026-11-26T17-43-44-118Z/` (online backup taken before the upgrade, restore verified 32/32 tables; gitignored; contains test personal data) |
| Completed (this stage) | dev DB online backup CLI (`npm run dev:db-backup`) + verified restore; worktree upgrade to `dee1101`; migrations 0010–0011 applied; data integrity verified twice; Phase 7 manual-testing guide (`docs/manual-testing.md` §7–8); verified Dammam prices; `docs/deploy/phase-8-preparation.md` (project, IAM matrix, Cloud Run/SQL commands, secret inventory, Vercel review, scheduler, checkpoint destination, Resend, billing, release gate, decisions D1–D13); `docs/deploy/cost-estimate.md` rewritten; `production-roles.sql` made Cloud SQL compatible; time-of-day test bug fixed |
| Tests | typecheck clean; `npm test` **302/302** (28 Nov 2026, after the Sign Out fix; earlier 296/296 on 27 Nov, incl. 9 Oracle layout tests); `check:portal` pass; browser suite last run 30/30 twice (Phase 7; UI unchanged since). Open: one earlier intermittent staff camera failure, not reproduced |
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
**28 Nov (final UAT):** real-browser UAT on www as one synthetic account per role (run `u1128`) passed: customer, collection staff, lab (rejection), recollection authorisation, admin, super admin, auditor, Sign Out for every role, 86-route inventory, gate on every host, 375 px, X-Forwarded-For spoofing check (counted under the real IP). No new bugs; observations and launch blockers in `docs/deploy/final-user-acceptance-report.md`. The MFA super admin export test was skipped at the owner's request (export still needs a fresh code from an enrolled authenticator). Tests 302/302. Helper scripts: `vm_17` (UAT accounts), `vm_18` (captured link for one synthetic address), `vm_19` (pilot rate-limit IPs). Next: owner reviews the report and decides on the open launch items (approved consents/instructions, real identity verification, devices, gate switch).

**Fixed 28 Nov:** "Your session has changed" (CSRF_REJECTED) on every signed-in write through www. Vercel's `x-middleware-override-headers` is the complete list of forwarded headers; the middleware listed only the changed ones, so Origin, X-CSRF-Token and Content-Type were dropped. The middleware now re-lists every header (`apiRewrite` in `middleware.ts`; test asserts it). Found with the CSRF security log. Tests 296/296.

**28 Nov (owner request):** two-step verification is **optional in the restricted pilot** (`PILOT_MFA_OPTIONAL=true` in preview mode; `loadConfig` refuses it in production, so launch accounts must enrol MFA). CSRF rejections are now logged (`vm_16_csrf_log.sh`) to diagnose the owner's "session has changed" error at two-step setup.

**28 Nov:** the browser pop-up is replaced by the branded pilot access page (signed HttpOnly cookie, API rate limit, launch switch; `docs/deploy/www-pilot-rollout.md`).
- The admin account `68e1a2d9…` (info@tracedmena.life) has set its password: the setup link was consumed at 00:38, so the screenshotted token is dead.
- **MFA is not enrolled yet.** At the next sign-in the owner must complete two-step setup; then Claude verifies `mfa_enabled_at`.
- Tests 293/293; the parallel-test race on the `traced_app` password is fixed.

Earlier notes follow.
**Pilot on www (28 Nov):** the owner opens the newest setup email, passes the pilot prompt (user `traced` + pilot password), sets a password and enrols MFA. Claude then verifies `last_login_at`/`mfa_enabled_at` for account `68e1a2d9…`. Production deploys: `vercel deploy --prod --scope linus-bio-mena` from the reviewed checkout (the build refuses the portal without the pilot password). Re-run `vm_13_e2e.sh` after API changes. The earlier notes follow.
**Preview super admin = info@tracedmena.life** (account `68e1a2d9…`, moved from `info+admin@` with the audited `vm_14_change_email.sh`; report §13). The owner must open the newest setup email and enrol MFA, then Claude verifies `last_login_at`/`mfa_enabled_at`. The rest follows.
- **Owner:** manual testing per `docs/deploy/preview-testing-guide.md` (plus-addressed accounts on info@tracedmena.life); give a preview admin address so it can be created with `vm_08`; sign in to Vercel in the browser pane if a visual pass by Claude is wanted.
- **Claude:** fix reported bugs with tests and re-run `vm_13_e2e.sh` after each API change.
- **Production switch** (`vm_07 … production`, no capture, approved consents) only after the release gate.
- **Proxy secret** = the Vault content as the Console shows it (base64).
