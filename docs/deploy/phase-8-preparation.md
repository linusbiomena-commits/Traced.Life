# TRACED: Phase 8 deployment preparation (Stage 8A done; 8B–8D await approval)

Prepared 27 Nov 2026. **Nothing in this document has been created, provisioned, configured or deployed.** No Google Cloud project, service account, database, secret, bucket, scheduler job, budget, DNS record, Resend account or Vercel setting exists or was changed. Every command below is a plan for Stage 8B and runs only after the owner's explicit approval.

Prices: official Google Cloud SKU list (cloud.google.com/skus, read 26–27 Nov 2026, USD list prices) for **me-central2 (Dammam)** unless marked otherwise. Full cost model: `docs/deploy/cost-estimate.md`.

---

## 1. Stage 8A — local manual-testing upgrade (DONE, verified)

| Step | Result |
|---|---|
| Checkpoint | `feature/traced-portal` at `dee1101` = origin; tests 263/263 unit, 30/30 browser (one earlier intermittent staff camera failure, not reproduced since: see `docs/TEST_STATUS.md`) |
| Backup before upgrade | **online** physical backup of the running dev DB with PostgreSQL's backup API (`npm run dev:db-backup`, new local-only CLI; no downtime) → `.dev-db-backups/2026-11-26T17-43-44-118Z/` (gitignored) |
| Restore verified | the copy was started on a separate port: **32/32 tables identical** (row counts + content hashes), audit chain intact |
| Upgrade | manual-testing worktree moved from `8f4c870` → `dee1101`; migrations **0010, 0011** applied with the local owner role (`npm run migrate`) |
| Data after upgrade | 31/31 data tables byte-identical to the backup; `schema_migrations` 9 → 11; 2 new tables; audit chain intact. Re-checked again on 27 Nov after the dev DB had stopped uncleanly overnight (app restart): still identical |
| Accounts, MFA, links | unchanged (7 synthetic accounts, 13 one-time links, 0 MFA enrolments at backup time; no password reset, no link invalidated) |
| New local settings | `AUDIT_CHECKPOINT_KEY` (generated locally, never printed or committed) and `AUDIT_CHECKPOINT_DIR=.dev-audit-checkpoints` in the worktree's gitignored `.env`; `.env` backup kept with the DB backup |
| Services | only the TRACED dev DB (54329) and manual portal (8787) were restarted; nothing else touched. Orphaned test PostgreSQL workers left running as instructed |
| Dev identity guard | production config refuses `DEV_IDENTITY_VERIFICATION=true` (checked against the upgraded worktree) |

Manual testing of Phase 7 features: `docs/manual-testing.md` §7. Rollback of the local upgrade: §8.

---

## 2. Google Cloud project

| Item | Plan |
|---|---|
| Name | TRACED Production |
| Project ID | preferred `traced-production`; IDs are global and permanent, so if taken use `traced-production-sa` or `traced-prod-<4 digits>`. Check at creation (`gcloud projects create` fails cleanly if taken) |
| Billing | existing company billing account (no new Google account or card) |
| Separate audit project | **`traced-audit-archive`** (same billing account) holding only the checkpoint bucket, administered by a person who is **not** the database administrator (§8) |
| Staging | optional `traced-staging` project for Stage 8C; or Stage 8C runs in `traced-production` with synthetic data and is wiped before launch (cheaper; decision D13) |
| Org policies (recommended) | `iam.disableServiceAccountKeyCreation` (no JSON keys), `iam.allowedPolicyMemberDomains` permitting `allUsers` only for the Cloud Run invoker if the org uses domain restriction, `gcp.resourceLocations` = `in:me-central2-locations` |

```bash
# Stage 8B (NOT RUN). Run by the company Cloud administrator.
gcloud projects create traced-production --name="TRACED Production"
gcloud billing projects link traced-production --billing-account=<BILLING_ACCOUNT_ID>
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  cloudscheduler.googleapis.com artifactregistry.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com logging.googleapis.com monitoring.googleapis.com --project=traced-production
```

---

## 3. IAM permission matrix

TRACED users (customers, staff, laboratory, admins) never get Google Cloud identities; they use the application's own accounts. No service account gets Owner or Editor. No service account key files: GitHub deploys through Workload Identity Federation; everything else uses Google-managed identities.

| Identity | Type | Role | Scope | Why |
|---|---|---|---|---|
| Company Cloud administrator (existing) | human | `roles/owner` | `traced-production` | create project, IAM, budgets. After setup: break-glass only, hardware security key |
| Company Cloud administrator | human | `roles/billing.costsManager` | billing account | create the project budget and alerts |
| Finance contact | human | `roles/billing.viewer` | billing account (or project via billing reports) | read costs; cannot change anything |
| TRACED engineer (day-to-day) | human | `roles/run.developer`, `roles/logging.viewer`, `roles/monitoring.viewer`, `roles/cloudsql.viewer`, `roles/secretmanager.secretVersionAdder` | `traced-production` | deploy/inspect; add secret versions without reading them |
| TRACED engineer | human | `roles/iam.serviceAccountUser` | on `traced-backend-sa`, `traced-scheduler-sa`, `traced-migrate-sa` only | attach those identities when deploying / creating jobs |
| Release approver | human | `roles/run.invoker` | on the Cloud Run **job** `traced-migrate` only | runs production migrations after approval |
| **`traced-backend-sa`** | service account | `roles/cloudsql.client` | project | connect through the Cloud SQL connector |
| `traced-backend-sa` | | `roles/secretmanager.secretAccessor` | **each** of the 6 runtime secrets individually (not project-wide) | read its own configuration |
| `traced-backend-sa` | | `roles/logging.logWriter`, `roles/monitoring.metricWriter` | project | logs and metrics |
| `traced-backend-sa` | | `roles/storage.objectCreator` + `roles/storage.objectViewer` | **bucket** in `traced-audit-archive` | write checkpoint copies and read them for verification; **cannot delete or overwrite** (retention lock) |
| **`traced-deployer-sa`** | service account (GitHub via WIF) | `roles/run.developer` | service `traced-api` | deploy new revisions |
| `traced-deployer-sa` | | `roles/artifactregistry.writer` | repository `traced` | push images |
| `traced-deployer-sa` | | `roles/iam.serviceAccountUser` | on `traced-backend-sa` only | revisions run as the backend identity |
| WIF pool `github` / provider | federation | attribute condition `assertion.repository=='linusbiomena-commits/Traced.Life' && assertion.ref=='refs/heads/main'` | — | only `main` of this repository can deploy (CI not yet built; until then deploys are manual) |
| **`traced-scheduler-sa`** | service account | `roles/run.invoker` | service `traced-api` only | sign OIDC tokens for scheduled calls |
| **`traced-migrate-sa`** | service account | `roles/cloudsql.client` | project | migration job connects |
| `traced-migrate-sa` | | `roles/secretmanager.secretAccessor` | secret `traced-database-url-owner` only | owner credentials, migrations only |
| Audit-archive owner (LinusBio compliance, **not** the DB admin) | human | `roles/storage.admin` | `traced-audit-archive` | owns the WORM bucket; DB admins have no role there |
| Cloud Scheduler service agent | Google-managed | (automatic) | — | mints tokens for `traced-scheduler-sa` |

Database roles (inside PostgreSQL, `docs/security/db-permissions.md`): `traced_owner` (built-in Cloud SQL user created with `gcloud sql users create`, used only by the migration job), `traced_app` (runtime, created by `server/sql/production-roles.sql`), `traced_readonly` (support, optional).

---

## 4. Cloud Run (backend)

| Setting | Value | Reason |
|---|---|---|
| Region | me-central2 | residency (D1) |
| CPU / memory | 1 vCPU / **512 MiB** | local process uses ~100–160 MB idle incl. dev tooling; exports are capped at 2,000 rows in memory. Move to 1 GiB only on memory alerts |
| Billing | **request-based** (`--cpu-throttling`) | pay only while handling requests; the in-process outbox timer is replaced by Cloud Scheduler |
| Min / max instances | 0 / 2 | lowest cost; caps DB connections (budget 25) |
| Concurrency | 20 | pool of 5 DB connections per instance; requests queue briefly rather than open more connections |
| Timeout | 60 s | longest normal request (CSV/verification) well below |
| Health | startup probe `GET /api/v1/health` (checks the DB) | |
| Listen address | `HOST=0.0.0.0`, `PORT` from Cloud Run (8080) | Phase 7 `HOST` setting; the default stays loopback for local use |
| Ingress / auth | public HTTPS; app does authentication; `/internal/*` requires the scheduler's OIDC token | |
| DB connection | Cloud SQL connector (`--add-cloudsql-instances`), Unix socket | no IP allowlists, no VPC connector cost |
| Migrations | separate Cloud Run **job** `traced-migrate` with `traced-migrate-sa` (owner role) | runtime never has DDL rights |

```bash
# Stage 8B/8C (NOT RUN). Image built from docs/deploy/Dockerfile.example copied to the repo root in a reviewed PR.
gcloud artifacts repositories create traced --repository-format=docker --location=me-central2 --project=traced-production
gcloud artifacts repositories set-cleanup-policies traced --location=me-central2 --policy=keep-last-5.json   # keep 5 newest images

gcloud run deploy traced-api --project=traced-production --region=me-central2 \
  --image=me-central2-docker.pkg.dev/traced-production/traced/traced-api:<GIT_SHA> \
  --service-account=traced-backend-sa@traced-production.iam.gserviceaccount.com \
  --cpu=1 --memory=512Mi --cpu-throttling --min-instances=0 --max-instances=2 --concurrency=20 --timeout=60 \
  --add-cloudsql-instances=traced-production:me-central2:traced-db \
  --no-allow-unauthenticated --no-invoker-iam-check \
  --set-env-vars=NODE_ENV=production,HOST=0.0.0.0,APP_ORIGIN=https://<PUBLIC_DOMAIN>,COOKIE_SECURE=true,SERVE_STATIC=false,MAIL_TRANSPORT=resend,MAIL_FROM="TRACED <no-reply@<MAIL_DOMAIN>>",DEV_IDENTITY_VERIFICATION=false,TRUSTED_PROXY_HOPS=2,DB_POOL_MAX=5,CUSTOMER_STATUS_EMAILS=false,SCHEDULER_OIDC_AUDIENCE=https://<RUN_URL>,SCHEDULER_OIDC_SERVICE_ACCOUNT=traced-scheduler-sa@traced-production.iam.gserviceaccount.com \
  --set-secrets=DATABASE_URL=traced-database-url:latest,TOKEN_HMAC_KEY=traced-token-hmac-key:latest,DATA_ENCRYPTION_KEY=traced-data-encryption-key:latest,RESEND_API_KEY=traced-resend-api-key:latest,TRUSTED_PROXY_SECRET=traced-proxy-secret:latest,AUDIT_CHECKPOINT_KEY=traced-audit-checkpoint-key:latest
# --no-invoker-iam-check makes the HTTP API public without granting allUsers (works with domain-restricted orgs).
# The first deploy uses a placeholder SCHEDULER_OIDC_AUDIENCE; update it once the service URL is known.
```

---

## 5. Cloud SQL (PostgreSQL)

**Availability in Dammam:** the official SKU list has *Cloud SQL for PostgreSQL: Zonal – Micro instance in Dammam* (SKU C040-FA80-0826, **$0.0168/hour**) and *Small instance* ($0.056/hour), so the shared-core tiers are priced for me-central2. Final confirmation happens in the console at creation (the instance-creation page lists the tiers actually offered). Shared-core tiers exist only in the **Enterprise** edition, so the edition must be set explicitly, because newer PostgreSQL versions may default to Enterprise Plus.

| Aspect | db-f1-micro | db-g1-small (alternative) |
|---|---|---|
| CPU | shared vCPU (burstable) | shared vCPU |
| Memory | ~0.6 GB | ~1.7 GB |
| Default `max_connections` | 25 (third-party sources; confirm with `SHOW max_connections`) | 50 |
| SLA | **none**: shared-core is excluded from the Cloud SQL SLA | none |
| Backups / PITR | supported | supported |
| Price (Dammam, zonal) | $0.0168/h ≈ **$12.26/month** | $0.056/h ≈ $40.88/month |
| High availability (regional) | $0.0336/h ≈ $24.53/month | not planned |
| SSD storage | $0.272/GiB-month (10 GiB ≈ $2.72) | same |
| Backup storage | $0.128/GiB-month | same |

**Recommendation:** db-f1-micro, zonal, for the pilot. The ten-year synthetic data set was 136 MB, and the connection budget fits 25. Local tests do **not** prove its performance: a shared vCPU is far slower than the test laptop. Upgrade triggers are in `docs/performance/README.md`. db-g1-small would roughly triple the database cost and push the monthly total above the SAR 110 budget. It is not selected.

```bash
# Stage 8B (NOT RUN)
gcloud sql instances create traced-db --project=traced-production --region=me-central2 \
  --database-version=<NEWEST_SUPPORTED_POSTGRES ≥ 15> --edition=ENTERPRISE --tier=db-f1-micro --availability-type=zonal \
  --storage-type=SSD --storage-size=10 --storage-auto-increase --storage-auto-increase-limit=30 \
  --backup-start-time=23:00 --retained-backups-count=30 --enable-point-in-time-recovery --retained-transaction-log-days=7 \
  --maintenance-window-day=FRI --maintenance-window-hour=0 --deletion-protection \
  --connector-enforcement=REQUIRED --ssl-mode=ENCRYPTED_ONLY \
  --database-flags="^:^log_min_duration_statement=500:cloudsql.enable_pgaudit=on:pgaudit.log=ddl,role"
# "^:^" switches the list delimiter to ":" so the comma inside pgaudit.log is kept.
# Public IP with NO authorized networks + connector enforcement: only IAM-authorised Cloud SQL connector
# clients (Cloud Run, the migration job) can connect. Private IP is an option (D12) but needs VPC setup.
gcloud sql databases create traced --instance=traced-db
gcloud sql users create traced_owner --instance=traced-db --prompt-for-password   # password straight into Secret Manager
```

After the first migration job: run `server/sql/production-roles.sql` as `traced_owner`, then set the `traced_app` password interactively. **Staging check:** the script was adjusted on 27 Nov so that it no longer sets superuser-only role attributes, which Cloud SQL's owner role cannot do. It must still be proven on the real instance in Stage 8C.

---

## 6. Secret Manager inventory (derived from `server/src/config.ts`)

| Secret | Env var | Purpose | Accessor |
|---|---|---|---|
| `traced-database-url` | `DATABASE_URL` | `traced_app` connection (Unix socket) | backend |
| `traced-database-url-owner` | (migration job only) | owner connection for migrations/role script | migrate job; version disabled between releases |
| `traced-token-hmac-key` | `TOKEN_HMAC_KEY` | 32 random bytes. Domain-separated HMAC for **session tokens, CSRF, one-time links, recovery codes, customer QR tokens (`qr:customer:`), sample QR tokens (`qr:sample:`)**, rate-limit keys | backend |
| `traced-data-encryption-key` | `DATA_ENCRYPTION_KEY` | 32 random bytes. AES-256-GCM for MFA secrets, QR redisplay (customer and sample), outbox payloads, patient revisions | backend |
| `traced-audit-checkpoint-key` | `AUDIT_CHECKPOINT_KEY` | checkpoint HMAC signatures | backend |
| `traced-resend-api-key` | `RESEND_API_KEY` | send-only Resend key | backend |
| `traced-proxy-secret` | `TRUSTED_PROXY_SECRET` | header from Vercel middleware proving the request came through Vercel | backend (+ Vercel env var) |

**Not needed (do not create):** separate QR or session keys (the code uses the two keys above with per-purpose separation); `INTERNAL_CRON_SECRET` (production uses OIDC; the config accepts either); Google service-account keys. Scheduler settings (`SCHEDULER_OIDC_AUDIENCE`, `…_SERVICE_ACCOUNT`) are not secret and are plain env vars. Replication: **user-managed, me-central2 only**. Per-secret IAM only. Version history kept (never destroy a data-key or checkpoint-key version while data or backups need it).

---

## 7. Vercel integration (review only, nothing changed)

**Verified facts (27 Nov):**
- `https://linusbiomena.vercel.app/traced/` is served by Vercel (`Server: Vercel`, edge cache HIT, `Last-Modified: 23 Nov 2026`). Its HTML is **byte-identical** to `LinusBio MENA Website/dist/traced/index.html` and to this repo's baseline commit `0e54770`.
- GitHub `linusbiomena-commits/Traced.Life` has **0 deployments and 0 environments**, and no repo folder has a `.vercel/project.json`. So the live site is **not** deployed by a Vercel Git integration on this repository. It was most likely deployed from the *LinusBio MENA Website* folder via CLI or dashboard upload.
- Every portal path (`/traced/account/`, `/traced/admin/…`, `/api/v1/health`) returns 404 on the live site.

**Cannot verify without Vercel access (owner to confirm in the Vercel dashboard):** the Vercel team and project name serving `linusbiomena.vercel.app`, its Git connection (if any), production branch, domains, environment variables and Deployment Protection. The Vercel connector in this session isn't authorised. (D11)

**Proposed routing (unchanged from Phase 7, refined):**
- Same origin: the browser calls `https://<domain>/api/v1/...`; Vercel rewrites to `https://<RUN_URL>/api/v1/...` (`docs/deploy/vercel.example.json`, kept out of the repo root). Cookies stay first-party (`__Host-`, `Secure`, `SameSite=Strict`); CSRF token + Origin check unchanged; **no CORS headers are needed or sent** (the API sends none).
- **Trusted proxy header:** `vercel.json` `headers` are *response* headers and cannot add an upstream request header. Use **Vercel Routing Middleware** (`middleware.ts` at the project root, matcher `/api/v1/:path*`) to rewrite to Cloud Run while setting `x-traced-proxy-auth: <TRUSTED_PROXY_SECRET>` from a Vercel *sensitive, production-only* environment variable. Stage 8C must prove on a **preview** deployment that the header actually arrives at Cloud Run (e.g. client IP correct in the audit log) and that a forged `X-Forwarded-For` sent directly to `run.app` is ignored (`docs/architecture.md` §2a).
- Caching: API responses carry `Cache-Control: no-store`; confirm `x-vercel-cache: MISS/BYPASS` on API paths in preview.
- Logs: QR tokens are in the URL fragment (`#c1_…`/`#s1_…`) and never reach any server; scanned codes travel in POST bodies, which Vercel and Cloud Run request logs don't record.
- Marketing site: unchanged until a reviewed release; preview first, then production (D11 decides whether a new Vercel project linked to `Traced.Life` replaces the upload-based deployment).

---

## 8. Cloud Scheduler and audit checkpoints

| Job | Schedule (Asia/Riyadh) | Endpoint | Auth | Retry | Monitoring |
|---|---|---|---|---|---|
| `traced-outbox` | every 5 min (`*/5 * * * *`) | `POST /api/v1/internal/outbox/run` | OIDC, `traced-scheduler-sa`, audience = service URL | 3 attempts, backoff 30–300 s, deadline 120 s | alert on job failures (scheduler logs) and on final email failures |
| `traced-audit-checkpoint` | daily 02:30 (`30 2 * * *`) | `POST /api/v1/internal/audit/checkpoint` (sign, then verify) | same | 3 attempts, deadline 300 s | **page** on `audit integrity verification failed`; alert if no `audit.checkpoint_created` in 26 h |

There are no other background jobs in the code. Housekeeping purges (expired sessions, links, rate-limit rows, old outbox rows) are a Phase 8 code task and would become a third, daily job. Cost: Cloud Scheduler gives 3 free jobs per billing account, then **$0.10 per job per month**, so $0–$0.30. Scheduler location: me-central2 if offered there, otherwise the nearest region. The job holds no personal data.

```bash
# Stage 8B (NOT RUN)
gcloud scheduler jobs create http traced-outbox --project=traced-production --location=me-central2 \
  --schedule="*/5 * * * *" --time-zone="Asia/Riyadh" --http-method=POST \
  --uri="https://<RUN_URL>/api/v1/internal/outbox/run" \
  --oidc-service-account-email=traced-scheduler-sa@traced-production.iam.gserviceaccount.com --oidc-token-audience="https://<RUN_URL>" \
  --attempt-deadline=120s --max-retry-attempts=3 --min-backoff=30s --max-backoff=300s
# traced-audit-checkpoint: same with --schedule="30 2 * * *", .../internal/audit/checkpoint, --attempt-deadline=300s
```

**Independent checkpoint destination:** a bucket `traced-audit-checkpoints` in the **separate project `traced-audit-archive`**. It sits in me-central2 with uniform access and a 400-day retention policy, **locked** after a trial week. The administrator is a LinusBio compliance owner who has no Cloud SQL role. The backend can only create and read objects. The database administrator cannot delete or rewrite copies, and the checkpoint key sits in Secret Manager under separate IAM. **Code task before launch:** a GCS writer for checkpoints, since the app currently writes to a local folder. Until it exists, production must not claim an external copy. Cost: a few KB per day, effectively $0.

---

## 9. Resend (transactional email)

| Item | Plan |
|---|---|
| Plan | Resend **Free**: per Resend's pricing page, 3,000 emails/month and **100/day** (re-check at sign-up). No purchase |
| Volume estimate | ~2–3 emails per registration (verification for new accounts, registration confirmation with QR, occasional QR resend/password reset); status emails **off** (`CUSTOMER_STATUS_EMAILS=false`). 100 reg/month ≈ 300; 500 ≈ 1,500 (watch the daily cap on busy days); **1,000 ≈ 3,000 → at the free limit: paid plan needed** (price to confirm on resend.com) |
| Sending domain | a subdomain of the approved official domain, e.g. `notify.<domain>` (D9) |
| Sender | `TRACED <no-reply@notify.<domain>>`; reply-to a monitored LinusBio support address |
| DNS (exact values come from Resend when the domain is added) | **DKIM**: TXT `resend._domainkey.notify.<domain>`; **SPF**: TXT on the bounce subdomain `send.notify.<domain>` = `v=spf1 include:amazonses.com ~all`; **MX** on `send.notify.<domain>` → Resend's feedback host; **DMARC**: TXT `_dmarc.<domain>` = `v=DMARC1; p=none; rua=mailto:<reports address>; adkim=s; aspf=s`, move to `p=quarantine` after two clean weeks |
| API key | send-only key, stored only in Secret Manager (`traced-resend-api-key`) |
| Integration | unchanged transactional outbox: retries with backoff, attempt cap, provider idempotency key, payload erased after send |
| Monitoring | admin **Email monitor** page; alert on final failures; Resend dashboard; webhooks (bounces/complaints) not implemented yet |
| Data | Resend stores data in the US: cross-border transfer **needs privacy approval** (D3). No real customer emails until approved |

---

## 10. Billing configuration (planned)

- Budget on the `traced-production` project: **SAR 110/month**, alerts at **50% (SAR 55), 80% (SAR 88), 100% (SAR 110)**, plus a *forecasted* 100% alert, emailed to the company Cloud administrator and finance contact.
- **Budget alerts do not cap or stop spending.** They only notify. No automatic shutdown on budget, because this is healthcare-related infrastructure and a silent stop would break sample custody. A human decides.
- Guard rails that do limit cost: `--max-instances=2`, `--min-instances=0`, storage auto-increase limit 30 GiB, Artifact Registry keep-last-5, log retention 30 days for request logs, a log exclusion for health-check noise.
- Usage monitoring (Cloud Monitoring alerts): Cloud Run billable instance time > 3× baseline/day; Cloud SQL CPU > 80% / connections > 20 / storage > 80%; log ingestion > 5 GiB/month (free allotment is 50 GiB); egress > 5 GiB/month; new unexpected SKUs on the billing report (monthly review).

```bash
# Stage 8B (NOT RUN) — budget amount in the billing account currency
gcloud billing budgets create --billing-account=<BILLING_ACCOUNT_ID> --display-name="TRACED Production monthly" \
  --budget-amount=110SAR --filter-projects=projects/traced-production \
  --threshold-rule=percent=0.5 --threshold-rule=percent=0.8 --threshold-rule=percent=1.0 \
  --threshold-rule=percent=1.0,basis=forecasted-spend
```

---

## 11. Repository visibility

- The repository is **public**; visibility unchanged; history not rewritten.
- **F-03:** 16 older screenshot versions in history decode to QR codes (14 customer tokens for `localhost:8791`, 2 MFA enrolment secrets with issuer `TRACED`). They belong to synthetic accounts in browser-test databases that were deleted after each run, and the keys that could validate them no longer exist. Verified 26 Nov with `scripts/scan-history-qr.mjs`. Current committed screenshots are clean (enforced by the evidence test). Remaining risk: low. They reveal the token format and the app's structure, not a usable credential.
- **Recommendation before public launch:** make the repository **private** (P2). Require pull-request review and branch protection on `main` (no direct pushes, required checks), enable secret scanning and Dependabot alerts, and limit write access to named maintainers. A history rewrite for F-03 is optional and needs explicit approval.

---

## 12. Deployment stages and release gate

| Stage | What | Gate to enter |
|---|---|---|
| **8A** | local manual-testing upgrade | **done** |
| **8B** | create project(s), IAM, Cloud SQL, secrets, Artifact Registry, scheduler, buckets, budget, alerts | owner approves this document + cost estimate + D1, D5, D6, D7, D12, D13 |
| **8C** | restricted deployment with **synthetic data only**: Cloud Run + migration job + role script; Vercel **preview** with middleware; proxy-chain test; restore-to-new-instance drill; ZAP baseline; device/printer pilot | 8B done; no real data; preview URL not announced |
| **8D** | production verification and **release approval** | release gate below fully signed |

**Release gate (all must be signed before public registration; collection additionally needs the identity item):**
Real patient identity verification (adult, child + guardian, dependent) · eligibility criteria · legal consent wording · privacy policy · hair collection instructions · packaging instructions · laboratory rejection criteria · professional Arabic review · real Wareed branches · real laboratory locations · Resend processing approval · Vercel processing approval · production sending domain + DNS · retention and deletion rules · report delivery process · real phone/scanner tests · label printer tests · deployed proxy-chain verification · production backup + restore drill · audit checkpoint bucket locked + GCS writer live · alerts test-fired · repository access controls.

**Infrastructure being up does not open registration or collection.** Collection stays blocked in production until an approved identity method is implemented. The development simulation cannot run in production (configuration refuses it).

---

## 13. Decisions

| # | Decision | Options | Recommended | Security | Cost | Before provisioning? | Before launch? |
|---|---|---|---|---|---|---|---|
| D1 | Region | me-central2 Dammam; me-central1 Doha; EU | **me-central2** | data stays in KSA (storage) | Dammam list prices (used in estimate) | **Yes** | Yes |
| D2 | API path | Vercel rewrite (same origin); custom domain → Cloud Run; HTTPS load balancer | **Vercel rewrite** for pilot, if privacy approves transit | rewrite: personal data transits Vercel edge; LB: all in GCP | rewrite $0; LB adds a fixed monthly forwarding-rule charge (price not verified) | No (Cloud Run same either way) | **Yes** |
| D3 | Email provider | Resend Free (US); in-region provider | Resend Free **if** privacy approves | US processing of email address, tracking ID, QR | $0 up to 3,000/month | No | **Yes** |
| D4 | Identity verification | approved method per scenario; launch registration-only | **registration-only launch**; collection blocked | dev simulation never in prod (enforced) | depends on method | No | **Yes (collection)** |
| D5 | Database size | db-f1-micro; db-g1-small; HA | **db-f1-micro zonal** | no SLA; tested restores + alerts | $12.26 vs $40.88 vs $24.53/month | **Yes** | — |
| D6 | Checkpoint sink | GCS bucket in separate project with lock; same project; none | **separate project, locked** | DB admin cannot erase evidence | ≈ $0 | **Yes** | Yes (writer code live) |
| D7 | Scheduler auth | OIDC only; shared secret; both | **OIDC only** | no long-lived secret | $0 | **Yes** | — |
| D8 | Customer status emails | off; on after wording approval | **off** | — | more emails count toward the cap | No | Yes (wording) |
| D9 | Official domain + mail subdomain | — | owner to provide | SPF/DKIM/DMARC protect against spoofing | domain cost (existing?) | No | **Yes** |
| D10 | Approved devices/printers | per checklist | pilot branch test | — | hardware cost | No | **Yes** |
| D11 | Vercel source for production *(new)* | new Vercel project linked to `Traced.Life` (`main`), domain moved after preview; keep the upload-based project and add portal files | **new linked project** (reviewable, reproducible) | Git-based deploys with protected `main` | Vercel plan unchanged (confirm plan limits) | No | **Yes** |
| D12 | Cloud SQL connectivity *(new)* | public IP, no authorized networks, connector enforced; private IP + Direct VPC egress | **public IP + connector enforced** | IAM + TLS via connector; no network allowlists | private IP: VPC setup, no connector charge with Direct VPC egress | **Yes** | — |
| D13 | Staging *(new)* | separate `traced-staging` project; stage inside prod project then wipe | **separate staging** if budget allows, else wipe | separation of test and real data | staging duplicates the fixed ≈ $16/month while it exists | **Yes** | — |
