# TRACED Oracle Cloud hosting report (server and database)

**Date:** 27 Nov 2026. Tenancy `karamait`, compartment `TRACED`, region me-riyadh-1. All results below are from commands actually run on the server through OCI Run Command (`deploy/oci/vmrun.sh`); outputs are summarised, no secrets.

## Server
- `traced-app-1`, `VM.Standard.A1.Flex`, 1 OCPU, 4 GB RAM, 50 GB balanced boot volume, Ubuntu 24.04.5 aarch64.
- Launched at 14:08 UTC on the first attempt after the Pay As You Go upgrade (`deploy/oci/launch-vm.sh`). The 5 earlier Free Tier attempts failed with Out of host capacity.
- No SSH key. Password authentication off. SSH and rpcbind disabled (`vm_06_harden.sh`). Legacy IMDS disabled. In-transit volume encryption on. Unattended upgrades on.
- Listening sockets: localhost and the local DNS resolver only.
- From the internet, ports 22, 80, 443, 5432 and 111 are all closed/filtered (tested from the admin PC). The security list and NSG have no ingress rules.

## Database (`vm_01_db.sh`, `vm_02_migrate.sh`)
- PostgreSQL **18.7** (`postgres:18`), data checksums on, SCRAM-SHA-256, container memory limit 1.5 GB, **no published port**, internal Docker network `traced-db` only.
- The superuser password was used only at initialisation (tmpfs file, shredded). No password is in the container configuration.
- Database `traced`, owned by `traced_migrator` (NOSUPERUSER, NOCREATEDB, NOCREATEROLE). CONNECT is revoked from PUBLIC.
- API image `traced-api:67e0161` built on the server (arm64, npm 11.6.2 to match the lockfile).
- Migrations: **0001–0011 applied** by `traced_migrator`. A second run applied 0 and re-verified all 11 stored checksums.
- `server/sql/production-roles.sql` applied by the superuser. `traced_app` and `traced_readonly` passwords were set from Vault.

## Verification (`vm_03_verify.sh`)

| Check | Result |
|---|---|
| Migrations / checksums | 11 rows, checksums present and verified |
| Tables / indexes / triggers | 34 / 102 / 42 |
| Constraints | check 118, foreign key 70, not-null 241, primary key 34, unique 18 |
| Append-only triggers | `audit_logs` (+ chain), `custody_events`, `consent_records`, `registration_status_history`, `audit_checkpoints`, `sample_label_prints`: no-update + no-truncate |
| Audit chain | intact (`audit_verify_chain()` is NULL) |
| Custody digest function | works |
| Role attributes | no `traced_*` role has superuser, create-role, create-db, replication or bypass-RLS; `traced_app` limit 40, `traced_readonly` limit 5 |
| Table owner | `traced_migrator` only |
| `traced_app` (TCP + SCRAM) | SELECT allowed; UPDATE/DELETE/TRUNCATE on `audit_logs`, `custody_events`, `consent_records`, `registration_status_history`, `audit_checkpoints`: **permission denied**; CREATE TABLE denied; DROP / DISABLE TRIGGER: must be owner; SET ROLE postgres / traced_migrator: denied; COPY TO PROGRAM: denied |
| `traced_readonly` | INSERT refused (read-only transaction); `users` table: permission denied |
| Exposure | no published ports; no host listener on 5432 |

## Backups (`vm_04_backup_install.sh`, `vm_05_backup_test.sh`)
- How it works: `pg_dump -Fc`, encrypted with gpg AES-256 using a passphrase from Vault (`traced-backup-passphrase`), uploaded with `--no-overwrite` to `traced-db-backups/db/` with a SHA-256 in the object metadata.
- Bucket: private, encrypted with `traced-master-key`, objects deleted after 35 days.
- Timer: daily at 01:30 Asia/Riyadh (`traced-backup.timer`; first scheduled run 22:31 UTC on 27 Nov).
- **Real test:**
  - backup `db/traced-20261127T150037Z.dump.gpg` (26,598 bytes) uploaded;
  - the object starts with an OpenPGP header and contains no `PGDMP` plaintext marker;
  - restore check downloaded it, decrypted it, restored it into a temporary database and compared exact row counts: **34/34 tables match**;
  - the temporary database was dropped, leaving `postgres` and `traced`.
- Limits: recovery point up to 24 hours (no WAL archiving); restore is into a temporary or new database, never over the primary.

## Problems found and fixed during the run
1. `postgres:18` crash-looped because the data directory was root-owned with mode 700. Fixed: owned by uid 999. The failed empty initialisation was removed.
2. `npm ci` failed in the image because `package-lock.json` was written by npm 11 and Node 22's npm 10 rejects it. Fixed: the Dockerfile installs npm 11.6.2 first.
3. Verification-script probes (identity column, constraint cast, NULL chain output) were corrected and re-run.
4. The OCI CLI session expired mid-run. `lib.sh` now fails fast with re-authentication instructions.

## Not done (needs approval or inputs: `docs/deploy/launch-plan-1-dec.md` §3)
- The API is not started: production requires Resend (D-C/D-D/D-E) and an API host name with HTTPS (D-A/D-B).
- `vm_07_api_install.sh` is prepared, not run.
- No public IP is reserved yet; the current ephemeral one changes if the instance is stopped.
- Monitoring alarms are not created (D-M).
- The audit-bucket retention rule is unlocked; the separate audit compartment (D-K) is not created.

## Cost
- A1 1 OCPU / 4 GB and the 50 GB boot volume are within Always Free on the Pay As You Go account.
- Vault (DEFAULT), the software key, 9 secrets and the ~26 KB backups are within free allowances.
- Expected: **EUR 0 a month**. Worst case with no free allowance: about EUR 13.5, roughly SAR 64 incl. VAT. Budget alerts are at EUR 23.25 (SAR 110 incl. VAT).
