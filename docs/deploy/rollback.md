# TRACED: Rollback procedures

Principles: roll back the smallest thing that fixes the problem; never delete evidence (audit, custody, consent rows); every rollback is written up in the incident log with the time, who, why and what was verified afterwards.

## 1. Application (Cloud Run revision) — minutes

1. Cloud Run keeps every revision. Find the last good one: `gcloud run revisions list --service traced-api --region <REGION>`.
2. Shift all traffic: `gcloud run services update-traffic traced-api --region <REGION> --to-revisions <GOOD_REVISION>=100`.
3. Verify: `/api/v1/health`, sign in as a test staff account in staging style smoke test, check 5xx rate.
4. Code rollbacks are safe because migrations are **additive only** (old code ignores new tables and columns). Before each release, confirm the previous revision runs against the new schema (staging check in the launch checklist).

## 2. Static site / portal pages (Vercel) — minutes

- Vercel → Deployments → previous production deployment → "Promote to Production" (instant rollback). The public LinusBio pages and the portal shells roll back together.
- If only the `/api` rewrite is the problem, roll back the deployment that introduced it; the API itself is unaffected.

## 3. Configuration and secrets — minutes

- Secret Manager versions are immutable: point the service back to the previous version (`key: <N>` instead of `latest`) and deploy a new revision. Never destroy a key version that encrypted data or signed checkpoints still need.
- Environment variable mistakes: redeploy the previous revision (step 1), which carries its own env.
- Feature switches (`CUSTOMER_STATUS_EMAILS`, export limits) are env vars: change and redeploy.

## 4. Database schema — avoid; forward-fix

- Migrations are forward-only and checksummed. There are no down-migrations, by design (dropping a column can destroy evidence).
- A bad migration is fixed by a **new** migration. If a migration fails midway it rolls back by itself (each file runs in one transaction).
- Before every production migration: take an on-demand Cloud SQL backup and note the time (PITR anchor).

## 5. Data — restore, carefully

Use only for data loss or corruption, after the security owner agrees, because every write after the restore point is lost.

1. **Do not restore over production.** Restore the backup / PITR to a **new instance** (`traced-db-restore-<date>`).
2. Verify on the copy: row counts and spot checks, `SELECT audit_verify_chain()` is NULL, run the audit-integrity verification against the checkpoint bucket (expect `checkpoint_missing_in_database` / `audit_rows_missing` only for checkpoints taken after the restore point — this is exactly what `npm run drill:backup` demonstrated), decrypt a test value with the current keys.
3. Decide: switch the service to the restored instance (update `traced-database-url`, redeploy), or copy specific rows back by hand with a reviewed script.
4. Record the gap (from restore point to switch-over) in the incident log. Registrations, collections and custody events made in the gap must be reconciled with Wareed / the laboratory from paper or system records; they cannot be recreated silently. Customers whose registrations were lost must be contacted.
5. After a restore, sessions and links issued in the gap no longer exist; users sign in again.

## 6. Who decides

| Action | Needs |
|---|---|
| Revision / Vercel rollback | on-call engineer |
| Secret version rollback | engineer + security owner informed |
| Data restore / instance switch | security owner + LinusBio MENA operations lead |
