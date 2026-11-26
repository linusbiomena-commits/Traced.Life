# TRACED: Database roles and permissions

Source of truth: `server/sql/production-roles.sql`. Verified by `server/test/db-roles.test.ts`, which applies the file to a throw-away database, runs the application **entirely as `traced_app`** (sign-up, registration, QR, collection, label print, custody, laboratory, admin search/audit/CSV, MFA reset, checkpoint, verification), and checks that PostgreSQL itself refuses everything outside the grants. **Not yet applied to any real database.**

## Roles

| Role | Login | Purpose |
|---|---|---|
| `traced_owner` | no (used via a separate migration job identity) | owns schema, runs migrations, runs this file |
| `traced_app` | yes | the API at runtime. NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOBYPASSRLS, connection limit 40, `statement_timeout` 15 s, `idle_in_transaction_session_timeout` 30 s |
| `traced_readonly` | yes | support / reporting on non-personal tables, read-only transactions, 5 connections |

## Table grants for `traced_app`

| Access | Tables |
|---|---|
| SELECT only | `roles`, `permissions`, `role_permissions`, `schema_migrations` |
| SELECT, INSERT, UPDATE | `users`, `sessions`, `auth_tokens`, `collection_branches`, `patients`, `registrations`, `tracking_sequences`, `customer_qr_tokens`, `staff_branch_assignments`, `email_outbox`, `collection_sessions`, `samples`, `collection_instruction_drafts` |
| + DELETE (by design) | `rate_limits` (expired windows), `mfa_recovery_codes` (replaced codes); `user_roles` (SELECT, INSERT, DELETE: role removal) |
| **SELECT, INSERT only** (evidence) | `audit_logs`, `audit_checkpoints`, `audit_verifications`, `consent_documents`, `consent_records`, `registration_status_history`, `patient_revisions`, `identity_verifications`, `custody_events`, `sample_label_prints`, `recollection_authorizations`, `registration_branch_transfers`, `collection_instructions`, `sample_qr_tokens` |
| none | everything else; no CREATE on schema; no TRUNCATE anywhere |

Functions: EXECUTE revoked from PUBLIC and granted only for the functions the app calls (tracking allocation, chain verification, custody digest) and the trigger functions. None is SECURITY DEFINER, so table grants apply inside them.

## Two independent layers on evidence tables

1. **Grants** (this file): the runtime role cannot UPDATE/DELETE/TRUNCATE, even if a trigger were dropped.
2. **Triggers** (`reject_modification`, migrations 0002–0010): also stop the owner by accident.

Neither stops a deliberate superuser. That is covered by signed checkpoints outside the database (`audit-integrity.md`) and by restricting owner access to named people with cloud audit logs on.

## How the grants were derived

Every `UPDATE`, `DELETE`, `INSERT` and `SELECT … FOR UPDATE/SHARE` statement in `server/src` was listed (row locks need UPDATE privilege). Tables only ever inserted got INSERT + SELECT. Re-run that review and this file whenever a migration adds a table or the code starts updating a table it did not before; `db-roles.test.ts` fails if the app needs a grant it does not have.

## Applying (Phase 8)

1. Migration job as owner: `npm run migrate`.
2. Same job: `psql "$OWNER_URL" -v ON_ERROR_STOP=1 -f server/sql/production-roles.sql`.
3. `ALTER ROLE traced_app PASSWORD '<from Secret Manager>'` in an interactive session (never in a file).
4. Point `traced-database-url` at `traced_app`. Disable the owner secret version until the next release.
