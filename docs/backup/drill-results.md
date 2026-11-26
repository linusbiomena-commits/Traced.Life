# TRACED: Backup and restore drill results

Run by `npm run drill:backup` on 2026-11-26 on a throw-away local cluster with synthetic data only (temporary folder, random ports; never the development database). Procedure and what this does not prove: `docs/backup/README.md`.

1. Synthetic data before the backup: 350 rows across 34 tables (6 registrations, 3 samples, 3 custody events, 61 audit entries).
2. Cold backup: clean stop 4081 ms, copy of 77.4 MB in 2527 ms.
3. Restore: copy started as a separate server in 512 ms (crash-recovery not needed: the backup was taken from a cleanly stopped server).
4. Every table matches the pre-backup fingerprint (row count and content hash): 34 / 34.
5. Writes made after the backup are absent from the restore, as expected (tables that differ from the live original: audit_checkpoints, audit_logs, rate_limits, sessions, users). This is the recovery point: anything after the last backup or log position is lost.
6. Application on the restored database with the same keys: customer sign-in and registration detail work; the laboratory operator completes two-step verification (the encrypted authenticator secret decrypts); a queued email still has its encrypted payload. With a different DATA_ENCRYPTION_KEY the encrypted values cannot be read: the keys must be backed up separately from the database (Secret Manager versions are kept; never destroy a key version while backups made with it are retained).
7. Audit verification on the restore: hash chain intact; the external copy of the checkpoint signed after the backup has no database row, reported as `checkpoint_missing_in_database` (findings: checkpoint_missing_in_database). This is expected after any restore to an earlier point and must be recorded in the incident log, not "fixed".

## Table fingerprints (restored copy)

| table | rows | content hash (first 12) | matches pre-backup |
|---|---|---|---|
| audit_checkpoints | 1 | `85d3546f8e20` | yes |
| audit_logs | 61 | `201027933d18` | yes |
| audit_verifications | 0 | `` | yes |
| auth_tokens | 9 | `7e780bd68163` | yes |
| collection_branches | 3 | `3cf9df981ff6` | yes |
| collection_instruction_drafts | 0 | `` | yes |
| collection_instructions | 2 | `24b955fe26ea` | yes |
| collection_sessions | 3 | `5b92b0d69823` | yes |
| consent_documents | 8 | `512e264bef06` | yes |
| consent_records | 24 | `fd45b2777820` | yes |
| custody_events | 3 | `2b85223382b7` | yes |
| customer_qr_tokens | 6 | `2e11c787c517` | yes |
| email_outbox | 13 | `b0844c2165ec` | yes |
| identity_verifications | 3 | `0e7e360e705e` | yes |
| mfa_recovery_codes | 20 | `96b043313033` | yes |
| patient_revisions | 1 | `08f47514c747` | yes |
| patients | 6 | `c8e1d225ceee` | yes |
| permissions | 21 | `63842c784b3b` | yes |
| rate_limits | 53 | `a2175fd021da` | yes |
| recollection_authorizations | 0 | `` | yes |
| registration_branch_transfers | 0 | `` | yes |
| registration_status_history | 15 | `e7b2f06db580` | yes |
| registrations | 6 | `902b8afbcdfd` | yes |
| role_permissions | 39 | `20e4bd453f75` | yes |
| roles | 6 | `6348290b5847` | yes |
| sample_label_prints | 0 | `` | yes |
| sample_qr_tokens | 3 | `82698e484ea4` | yes |
| samples | 3 | `17febb4dddd4` | yes |
| schema_migrations | 10 | `e320e5a5b7b0` | yes |
| sessions | 11 | `fb9275a0e9a2` | yes |
| staff_branch_assignments | 1 | `900a445e0f81` | yes |
| tracking_sequences | 1 | `f8b0c8ccc3c3` | yes |
| user_roles | 9 | `8c439dcae5b7` | yes |
| users | 9 | `3fefcd3d4f09` | yes |
