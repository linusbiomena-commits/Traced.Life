# TRACED: Audit integrity and investigation runbook

## 1. What protects the evidence

| Layer | What it does | Where |
|---|---|---|
| Append-only triggers | reject UPDATE/DELETE/TRUNCATE on audit, custody, consent, history, identity checks, label prints, recollections, checkpoints, verifications | migrations 0002–0010 |
| Least-privilege grants | runtime role has INSERT + SELECT only on those tables | `server/sql/production-roles.sql`, `db-permissions.md` |
| Hash chain | each audit row's SHA-256 covers its content and the previous row's hash; `audit_verify_chain()` finds the first broken link | 0002 |
| Signed checkpoints | chain head (sequence + hash) and a digest of **all custody events**, HMAC-signed with `AUDIT_CHECKPOINT_KEY` (outside the database), stored in `audit_checkpoints` **and** written as a JSON copy to an external sink | 0010, `server/src/modules/audit/integrity.service.ts` |
| Verification | recomputes the chain, checks every recent checkpoint (signature, chain head, custody digest) and cross-checks the external copies both ways | same |
| Schedule | `/internal/audit/checkpoint` daily: sign, then verify; failure logged at error level → alert | `internal.routes.ts` |
| UI | Admin → Audit integrity: status, history, run verification (audit.read), sign checkpoint (super admin) | `admin-integrity.js` |

What each attack looks like to the verifier (all covered by `server/test/audit-integrity.test.ts`):

| Attack (with owner access) | Detected as |
|---|---|
| Edit an audit row | `chain_broken` at that sequence |
| Delete rows from the end of the log (chain still self-consistent) | `audit_rows_missing` (a signed checkpoint says they existed) |
| Rewrite the whole chain consistently | `audit_head_mismatch` against the signed checkpoint |
| Edit or delete a custody event | `custody_digest_mismatch` |
| Edit a checkpoint row | `checkpoint_signature_invalid`, `sink_copy_mismatch` |
| Delete a checkpoint row | `checkpoint_missing_in_database` (copy still in the sink) |
| Delete or edit the external copy | `sink_file_missing` / `sink_copy_mismatch` |
| Re-sign with another key | `checkpoint_unknown_key` |

**Limits.** Someone who controls the database **and** the checkpoint key **and** the sink can still rewrite history. Keep these with different people; lock the bucket retention (Phase 8). Verification re-checks the newest 100 checkpoints in full; external copies older than that window are skipped. Each verification run reads one consistent snapshot. Locally, verifying 240,000 audit entries took about 2.5 s (`docs/performance/results.md`).

## 2. Keys and sink

- `AUDIT_CHECKPOINT_KEY`: ≥ 32 random characters in Secret Manager. The page shows only a fingerprint (`key_id`). **Keep every key version** as long as checkpoints signed with it are retained; rotation = new version + new checkpoints; old checkpoints then report `checkpoint_unknown_key` unless the old key is supplied for verification (document the rotation date in the incident log).
- Sink: local folder (`AUDIT_CHECKPOINT_DIR`) today; GCS bucket with retention lock planned (`docs/deploy/README.md` §5). Until then, production must not rely on the external copy.

## 3. Investigation runbook (verification failed)

**Do not "fix" data. Do not re-run migrations, restore backups or delete anything until the security owner decides.**

1. **Contain (first 30 minutes).** Note the time and the verification id from the alert or the page. Tell the security owner and the LinusBio MENA operations lead. If tampering is plausible, suspend owner-level database credentials (disable the owner secret version) and review who has `cloudsql.admin` / project owner.
2. **Preserve.** Take an on-demand Cloud SQL backup (do not restore it over production). Export Cloud Audit Logs (Admin Activity, Data Access for Cloud SQL and Secret Manager) and Cloud Run logs for the period since the last `ok` verification. Copy the checkpoint objects from the bucket (read-only).
3. **Read the findings.**
   - `chain_broken` at seq N → `SELECT * FROM audit_logs WHERE chain_seq BETWEEN N-2 AND N+2` on the backup copy; compare with log exports and the previous checkpoint.
   - `audit_rows_missing` / `audit_head_mismatch` → compare the database head with the newest valid checkpoint; rows after it are suspect or gone.
   - `custody_digest_mismatch` → compare custody events per sample with the paper handover records, label print records and laboratory receipts; identify which samples are affected.
   - Checkpoint / sink findings → check bucket access logs and Secret Manager access logs.
   - **After a legitimate restore** to an earlier point, `checkpoint_missing_in_database` and `audit_rows_missing` for checkpoints signed after the restore point are expected (proved in `docs/backup/drill-results.md`). Record them; they are not tampering.
4. **Scope.** Which registrations, samples and people are affected; since when.
5. **Decide and notify.** The security owner decides on breach handling (PDPL notification timelines, customer and laboratory communication). Affected samples may need recollection.
6. **Recover.** Restore to a new instance only if data was lost (`docs/deploy/rollback.md` §5). Sign a fresh checkpoint once the state is understood; the earlier findings stay in `audit_verifications` permanently.
7. **Post-incident.** Root cause, access changes, key rotation if a key may be exposed, update this runbook.

## 4. Routine

- Daily: scheduled checkpoint + verification (automatic). Weekly: an auditor opens Audit integrity and confirms recent runs passed.
- Monthly: review export audit entries (`report.exported_pii`) and MFA resets (`staff.mfa_reset`).
- Before and after every release or migration: run a manual verification.
