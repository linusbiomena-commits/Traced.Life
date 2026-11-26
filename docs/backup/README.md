# TRACED: Backup and recovery

## Production plan (Phase 8, Cloud SQL)

| Item | Setting |
|---|---|
| Automated backups | daily, retain 30 |
| Point-in-time recovery | on, 7 days of write-ahead logs |
| On-demand backup | before every migration and release |
| Deletion protection | on |
| Restore target | **always a new instance**, never over production |
| Keys | Secret Manager versions retained for as long as any backup encrypted with them exists |
| Targets (proposal) | RPO ≤ 5 minutes (PITR), RTO ≤ 4 hours for a full restore + switch-over |
| Drill | on staging before launch, then quarterly; results recorded like `drill-results.md` |

Procedure: `docs/deploy/rollback.md` §5. Integrity after restore: `docs/security/audit-integrity.md` §3.

## Local drill (Phase 7)

`npm run drill:backup` (`server/test/drills/backup-restore.drill.ts`) on a throw-away cluster with synthetic data:

1. Creates realistic data through the real API: customers, registrations, collections with custody events, MFA staff, an admin patient correction (encrypted previous values), a queued email with an encrypted payload, a signed checkpoint.
2. Fingerprints every table (row count + content hash).
3. **Backup:** clean stop, full copy of the cluster directory (the bundled PostgreSQL has no `pg_dump`; a cold physical copy is the closest local equivalent of a Cloud SQL instance backup).
4. Keeps writing to the original after the backup (new audit rows and a second checkpoint).
5. **Restore:** starts the copy as a separate server on another port.
6. Verifies: all 34 tables match the pre-backup fingerprints; post-backup writes are absent (the recovery point); hash chain intact; customer sign-in and registration view work on the restore; a laboratory operator passes MFA (encrypted secret decrypts with the same key); the queued email payload is intact; **a different data key cannot decrypt** (keys must be backed up separately); integrity verification reports the post-backup checkpoint as `checkpoint_missing_in_database`, which is the expected signature of a restore to an earlier point.

Results: `drill-results.md`.

**Not proved locally:** Cloud SQL automated backups, PITR to a timestamp, cross-region copies, restore duration at production size, and Cloud SQL's own consistency guarantees. These are part of the staging drill in Phase 8.
