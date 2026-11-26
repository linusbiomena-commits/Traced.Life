# TRACED Platform: Architecture and Deployment Plan

Status: **approved target architecture; nothing is provisioned.** Production resources, credentials and migrations require separate approval (Phase 8). Last updated in Phase 4.

## 1. Approved stack

| Layer | Choice | Notes |
|---|---|---|
| Public site + portal pages | **Vercel** (existing) | Static `dist/`: public TRACED pages, customer portal, staff portal |
| API | **Google Cloud Run**, region **me-central2 (Dammam)** | Existing Hono + TypeScript server (`server/`), one container image |
| Database | **Cloud SQL for PostgreSQL**, me-central2 | Initial `db-f1-micro`, 10 GB storage, subject to performance validation |
| Secrets | **Google Secret Manager** | Mounted into Cloud Run as environment variables |
| Email | **Resend Free** | See §6 for data-location implications |
| Scheduled jobs | **Cloud Scheduler** → Cloud Run | Outbox delivery and retries while Cloud Run is scaled to zero |
| Source | GitHub `linusbiomena-commits/Traced.Life` | Development on `feature/traced-portal` |
| Local development | Embedded PostgreSQL (UTF-8) | `npm run dev:db` |

Not used: AWS, Supabase, Render.

## 2. Request flow

```
Browser ──HTTPS──► Vercel (static pages)
   │                 └─ rewrite /api/*  ──HTTPS──►  Cloud Run (me-central2) ──private IP / connector──► Cloud SQL (me-central2)
   │                                                     │
   └─ same origin for /api (cookies SameSite=Strict,      ├─► Resend API (transactional email)
      CSRF Origin check unchanged)                        └─◄ Cloud Scheduler (every 5 min: /api/v1/internal/outbox/run)
```

- **Same origin is a design requirement.** The session cookie is `__Host-`, `SameSite=Strict`, and CSRF checks require the request `Origin` to equal `APP_ORIGIN`. Vercel therefore proxies `/api/*` to Cloud Run with a `vercel.json` rewrite, rather than the browser calling a different domain. `TRUST_PROXY=true` makes the API read the client IP from `X-Forwarded-For`.
- **Implication to approve:** with a rewrite, API traffic (including personal data in transit) passes through Vercel's edge network before reaching Dammam. Data is **stored** only in Cloud SQL (me-central2). If legal requires that no personal data transits non-Saudi infrastructure, use a custom domain pointing directly at Cloud Run (or a Google HTTPS load balancer) for both static pages and `/api`. That moves static hosting off Vercel, or uses a split domain with a matching cookie/CSRF review.

## 3. Cloud Run configuration (initial)

| Setting | Value | Why |
|---|---|---|
| Min instances | 0 | Cost: no idle charges |
| Max instances | 2 (initial) | Caps cost and database connections |
| Memory | 512 MB (test 1 GB if Argon2 + QR rendering need it) | Argon2id uses 19 MiB per hash; QR PNGs are small |
| CPU | 1, **request-based billing** | CPU only billed during requests |
| Concurrency | 40–80 | Hono is async; keeps instance count low |
| `DB_POOL_MAX` | 5 | 2 instances × 5 = 10 connections, within f1-micro limits (verify `max_connections`) |
| Ingress | All (behind Vercel rewrite), or internal + load balancer if chosen | |
| Service account | Dedicated, least privilege: Cloud SQL Client, Secret Accessor | |

**Background email when scaled to zero:** in-process timers stop when there are no requests. Registration still triggers delivery immediately. Retries and anything left over are delivered by **Cloud Scheduler** calling `POST /api/v1/internal/outbox/run` with `Authorization: Bearer <INTERNAL_CRON_SECRET>` every 5 minutes. The endpoint is built and tested; it returns 404 unless the secret is configured. Optionally use OIDC tokens from Scheduler instead of a shared secret.

## 4. Cloud SQL

- PostgreSQL 16+ in me-central2, **UTF-8** database (the migration runner refuses anything else), private IP with the Cloud SQL connector (no public IP).
- `db-f1-micro` is a **shared-core** tier: it has limited memory/connections and is **not covered by the Cloud SQL SLA**. Validate under load before launch; moving to a dedicated-core tier is a setting change. **Confirm the tier is offered in me-central2.**
- Automated daily backups + point-in-time recovery (WAL). **Test a restore** before launch (Phase 7).
- Roles per `server/sql/production-roles.sql` (draft): the app connects as `traced_app` (no UPDATE/DELETE on audit, consent, status-history, revision or verification tables); migrations run as `traced_owner` with offline credentials.
- Audit checkpoints exported outside the database (see `docs/audit-hardening-plan.md`).

## 5. Secrets (Secret Manager)

`DATABASE_URL`, `TOKEN_HMAC_KEY`, `DATA_ENCRYPTION_KEY`, `RESEND_API_KEY`, `INTERNAL_CRON_SECRET`. Rotation plan: HMAC/encryption keys need a versioned-key migration (documented for Phase 7). Never in Git; `.env` is gitignored, and production refuses dev transports and `DEV_IDENTITY_VERIFICATION`.

Production environment (summary): `NODE_ENV=production`, `APP_ORIGIN=https://<official domain>`, `COOKIE_SECURE=true`, `TRUST_PROXY=true`, `MAIL_TRANSPORT=resend`, `MAIL_FROM=TRACED <no-reply@<verified domain>>`, `SERVE_STATIC=false`, `DEV_IDENTITY_VERIFICATION=false`.

## 6. Email: Resend Free, and its data implications

- Free plan (from Resend's documentation, to re-check at sign-up): 3,000 emails/month, **100/day**, 3 custom domains. The outbox spreads retries but cannot exceed the daily cap, so the volume forecast must fit or a paid plan needs approval.
- **Data location:** Resend states that *all account data, logs and email metadata are stored in the United States regardless of the sending region*. Every email (recipient address, subject, content: tracking ID, QR image, branch) is therefore processed and stored in the US. This is an **international data transfer under PDPL** and needs privacy/legal approval before production. Emails already exclude patient name, date of birth and phone number.
- Sending domain configurable (`MAIL_FROM`); needs SPF, DKIM and DMARC on the official domain.

## 7. Monitoring and cost control

- Cloud Monitoring alerts: Cloud Run 5xx rate, latency, instance count; Cloud SQL CPU, memory, connections, storage; outbox `failed` count (log-based metric); scheduler failures.
- **Billing budget + alerts** at 50/90/100 % of the SAR 60–110/month target.
- Logs: structured JSON, ids only (no personal data, no tokens).

### Cost verification checklist (no figures are assumed here)
Use the Google Cloud pricing calculator for **me-central2** (regional prices differ from US prices) and record the results before approval:
1. Cloud SQL `db-f1-micro` instance hours (always on) + 10 GB SSD + backup storage.
2. Cloud Run vCPU-seconds, GiB-seconds and requests at the forecast volume (request-based billing, min 0).
3. Cloud Scheduler job (first jobs are typically free; confirm).
4. Secret Manager versions and access operations.
5. Network egress (Cloud Run → Vercel/clients, → Resend).
6. Vercel plan (existing) and any bandwidth/function limits for the rewrite.
7. Resend Free (SAR 0) within 100/day.
Compare the total with the SAR 60–110 target. The database instance is expected to be the largest fixed cost.

## 8. Deployment and rollback (Phase 8, requires approval)

1. Build the container from `feature/traced-portal` after the merge is approved; push it to Artifact Registry (me-central2).
2. Take a backup snapshot, then run migrations as `traced_owner`, forward-only (`npm run migrate`), then `npm run backfill:phase3` if needed.
3. Deploy a Cloud Run revision with no traffic; smoke-test; shift traffic.
4. Vercel: deploy the static site with the `/api` rewrite; feature-flag the portal entry links if needed.
5. **Rollback:** shift Cloud Run traffic to the previous revision (instant); roll back Vercel to the previous deployment; migrations are additive, so the old code keeps working; point-in-time restore is the last resort.

## 9. Open items before production
- Confirm me-central2 availability and pricing for every service above.
- Legal approval: Vercel transit (§2), Resend US storage (§6), US laboratory transfer, PDPL notices and consents.
- Official domain and DNS (email authentication, HTTPS).
- Approved identity-verification method (`docs/identity-verification.md`), approved collection instructions, approved consent texts.
- Make the GitHub repository private (it is currently public).
