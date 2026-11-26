# TRACED: Deployment templates (Phase 7)

**Status: templates only.** Nothing here has been provisioned, applied or deployed. No Google Cloud project, service account, secret, bucket, scheduler job or billing alert exists yet. Phase 8 starts only after explicit approval (`docs/deploy/phase-8-plan.md`).

| File | Purpose |
|---|---|
| `Dockerfile.example` | API container (Node 22, runs as `node`, no static files, no migrations at start) |
| `cloudrun-service.example.yaml` | Cloud Run service: scale 0–2, Cloud SQL socket, Secret Manager references, env |
| `vercel.example.json` | `/api/v1` rewrite to Cloud Run and no-store/noindex headers for portal pages. **Kept out of the repo root** so the live site is unchanged |
| `phase-8-plan.md` | Ordered provisioning and go-live plan, decisions needed |
| `cost-estimate.md` | Monthly cost ranges and the assumptions behind them |
| `rollback.md` | Rollback procedures for app, schema, config and data |
| `launch-checklist.md` | Go/no-go checklist |

## 1. Projects, region, identities

- One project for production (`traced-prod`) and one for staging (`traced-staging`). Staging uses synthetic data only.
- Region: **me-central2 (Dammam)**, assumed for data residency. Confirm that Cloud SQL, Cloud Run, Cloud Scheduler, Secret Manager and Artifact Registry are available there, and that the chosen machine types are offered there, before provisioning.
- Service accounts (least privilege):

| Service account | Roles (project unless noted) | Used by |
|---|---|---|
| `traced-api` | `roles/cloudsql.client`; `roles/secretmanager.secretAccessor` **on the 6 runtime secrets only**; `roles/logging.logWriter`; `roles/storage.objectCreator` on the checkpoint bucket only (no read/delete) | Cloud Run service |
| `traced-migrate` | `roles/cloudsql.client`; secret accessor on `traced-database-url-owner` only | Cloud Run job that runs `npm run migrate` and `server/sql/production-roles.sql` |
| `traced-scheduler` | `roles/run.invoker` on `traced-api` only | Cloud Scheduler OIDC tokens |
| `traced-deploy` (CI, optional) | `roles/run.developer` on the service, `roles/artifactregistry.writer`, `roles/iam.serviceAccountUser` on `traced-api` | GitHub Actions via Workload Identity Federation (no JSON keys) |

- Humans: two named owners with hardware security keys, nobody else with `owner` or `cloudsql.admin`. Break-glass access is logged (Admin Activity + Data Access audit logs on Cloud SQL and Secret Manager enabled).

## 2. Secrets (Secret Manager)

| Secret | Content | Rotation |
|---|---|---|
| `traced-database-url` | `postgres://traced_app:<pw>@/traced?host=/cloudsql/<instance>` | yearly or on staff change; new version + redeploy |
| `traced-database-url-owner` | owner role URL, migrations only | on every use window; disabled between releases |
| `traced-token-hmac-key` | 32 random bytes, base64 | rotating invalidates sessions, links and QR lookups: plan it (see `docs/security/privacy-review.md` §Keys) |
| `traced-data-encryption-key` | 32 random bytes, base64 | **never destroy old versions while backups made with them exist** (proved by the backup drill) |
| `traced-resend-api-key` | Resend sending key (send-only scope) | yearly |
| `traced-proxy-secret` | ≥ 32 chars, also in Vercel env | yearly |
| `traced-audit-checkpoint-key` | ≥ 32 chars HMAC key | keep all versions; verification needs the key that signed each checkpoint |

Generate keys offline (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`), paste once into Secret Manager, never into chat, tickets, files or `.env` on shared machines.

## 3. Cloud SQL

- PostgreSQL 18 (or the newest version Cloud SQL offers in the region; the app needs ≥ 15), `db-f1-micro` to start, 10 GB SSD, automatic storage increase on with a cap.
- Private IP + Cloud SQL Auth (Unix socket) only; no public IP. `cloudsql.iam_authentication` optional later.
- Backups: automated daily, **retain 30**, point-in-time recovery on (7 days of logs). Deletion protection on.
- Flags: `max_connections` default (25 on db-f1-micro, check with `SHOW max_connections`), `log_min_duration_statement=500`, `cloudsql.enable_pgaudit=on` with `pgaudit.log=ddl,role` (owner activity trail).
- After the first migration: run `server/sql/production-roles.sql` as owner, set the `traced_app` password from Secret Manager, re-run after every migration that adds a table.

## 4. Scheduled jobs (Cloud Scheduler → Cloud Run, OIDC)

| Job | Schedule (Asia/Riyadh) | Target |
|---|---|---|
| `traced-outbox` | every 5 minutes | `POST https://<run-url>/api/v1/internal/outbox/run` |
| `traced-audit-checkpoint` | daily 02:30 | `POST https://<run-url>/api/v1/internal/audit/checkpoint` (signs a checkpoint, then verifies) |

Each job uses an OIDC token: service account `traced-scheduler`, audience = the service URL (exactly `SCHEDULER_OIDC_AUDIENCE`). The API verifies RS256 signature (Google JWKS), issuer, audience, email and expiry (`server/src/lib/scheduler-auth.ts`, tests in `audit-integrity.test.ts`). **Recommendation: OIDC only in production** (no long-lived shared secret). `INTERNAL_CRON_SECRET` remains supported for staging or as a fallback; if used, store it in Secret Manager and rotate it.

Note that the `run.app` URL is public: the internal routes are protected by the token check in the app, not by network position.

## 5. Checkpoint sink (WORM)

- Bucket `traced-audit-checkpoints-<project>` in the same region, uniform access, **retention policy 400 days, then locked** (bucket lock is irreversible: lock only after a staging trial), object versioning off (retention covers it).
- `traced-api` may only create objects. Nobody but the two owners can read; nobody can delete before retention ends.
- The app currently writes checkpoints to a local folder (`AUDIT_CHECKPOINT_DIR`). **Phase 8 work:** add a GCS writer (same JSON document, `ifGenerationMatch=0` to forbid overwrite) and point verification at the bucket. Until then, production must not claim an external sink.

## 6. Monitoring and alerts

| Alert | Condition | Severity |
|---|---|---|
| Audit integrity failed | log entry `audit integrity verification failed` (log-based metric) | page owners immediately; follow `docs/security/audit-integrity.md` |
| Checkpoint job missing | no `audit.checkpoint_created` log in 26 h | high |
| Outbox backlog | log-based metric on `email delivery failed` final=true > 0, or outbox scheduler errors | high |
| 5xx rate | Cloud Run 5xx > 2% for 10 min | high |
| Latency | p95 > 2 s for 15 min | medium |
| DB connections | Cloud SQL connections > 20 for 5 min | medium (budget is 25) |
| DB CPU / memory | > 80% for 15 min | medium (consider db-g1-small) |
| Storage | > 80% | medium |
| Uptime check | `/api/v1/health` from 2 locations every 5 min | high |
| Budget | 50 / 90 / 100% of the monthly budget | email owners |

Logs: structured JSON, no personal data by design (emails are HMAC'd in rate-limit keys; audit metadata has no names/emails). Set log retention to 30 days for request logs, 400 days for the audit-related log bucket.

## 7. Billing controls

- Billing account with budget + alerts (above), and a **Pub/Sub budget notification** that the owners watch. Do not auto-disable billing (it would take the service down silently).
- Cloud Run `maxScale: 2` caps compute spend and database connections together.
- Resend free plan limit (100 emails/day) is a hard functional cap; confirm volume.

## 8. CI/CD (proposal)

GitHub Actions on `main` merges only, after required checks (`typecheck`, `test`, `test:e2e`, `check:portal`, `npm audit`): build image → push to Artifact Registry (tag = commit SHA) → deploy a **new revision with no traffic** → smoke test → shift traffic. Authentication by Workload Identity Federation. Migrations are a separate, manually approved job. Not set up in Phase 7.
