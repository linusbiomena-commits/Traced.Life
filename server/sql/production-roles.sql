-- TRACED production database roles (Phase 7 revision). NOT executed against any real database.
-- Verified locally by server/test/db-roles.test.ts, which runs this file on a throw-away test
-- database, connects as traced_app and exercises the application.
--
-- How to apply (Phase 8, by the database owner, after approval; see docs/security/db-permissions.md):
--   1. Run all migrations as traced_owner (Cloud Run job / one-off, `npm run migrate`).
--   2. Run this file as traced_owner (or the Cloud SQL admin user), once per database.
--   3. Set passwords out of band (Secret Manager); never in a file:
--        ALTER ROLE traced_app PASSWORD '...';   -- from a psql session, not committed
--   4. Re-run this file after every new migration that adds a table (grants are per table).
--
-- Roles
--   traced_owner     owns the schema and runs migrations. Not used by the running service.
--   traced_app       the API's runtime login. No DDL, no TRUNCATE, no ownership. INSERT+SELECT
--                    only on evidence tables; DELETE only where the code deletes by design.
--   traced_readonly  support/reporting. Operational tables without personal data only.
--
-- The append-only triggers (reject_modification) stay as a second, independent layer: they also
-- stop the owner by accident; the grants stop the runtime even if a trigger is ever dropped.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'traced_owner') THEN CREATE ROLE traced_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'traced_app') THEN CREATE ROLE traced_app LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'traced_readonly') THEN CREATE ROLE traced_readonly LOGIN; END IF;
END $$;

-- Runtime roles must never be able to create objects, own anything, or bypass row security.
-- New roles have all of these off by default. They are ASSERTED here rather than set, because on
-- Cloud SQL the migration user is not a true superuser and PostgreSQL refuses
-- ALTER ROLE … NOSUPERUSER / NOREPLICATION / NOBYPASSRLS from non-superusers (Phase 8 review).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('traced_app', 'traced_readonly')
              AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'traced_app / traced_readonly must not have SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS';
  END IF;
END $$;
ALTER ROLE traced_app CONNECTION LIMIT 40;
ALTER ROLE traced_readonly CONNECTION LIMIT 5;
-- Long-running or idle transactions hold locks and connections on a tiny instance.
ALTER ROLE traced_app SET statement_timeout = '15s';
ALTER ROLE traced_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE traced_readonly SET statement_timeout = '60s';
ALTER ROLE traced_readonly SET default_transaction_read_only = on;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM traced_app, traced_readonly;
GRANT USAGE ON SCHEMA public TO traced_app, traced_readonly;

-- Start from nothing, then grant table by table.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM traced_app, traced_readonly;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM traced_app, traced_readonly;

-- 1. Reference data the runtime reads only.
GRANT SELECT ON roles, permissions, role_permissions, schema_migrations TO traced_app;

-- 2. Operational tables the runtime reads, inserts and updates (never deletes).
GRANT SELECT, INSERT, UPDATE ON
  users, sessions, auth_tokens, collection_branches, patients, registrations, tracking_sequences,
  customer_qr_tokens, staff_branch_assignments, email_outbox, collection_sessions, samples,
  collection_instruction_drafts
TO traced_app;

-- 3. Rows the code deletes by design: expired rate-limit windows, replaced recovery codes,
--    removed role grants.
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits, mfa_recovery_codes TO traced_app;
GRANT SELECT, INSERT, DELETE ON user_roles TO traced_app;

-- 4. Evidence and history: INSERT + SELECT only (no UPDATE, DELETE or TRUNCATE).
GRANT SELECT, INSERT ON
  audit_logs, audit_checkpoints, audit_verifications, consent_documents, consent_records,
  registration_status_history, patient_revisions, identity_verifications, custody_events,
  sample_label_prints, recollection_authorizations, registration_branch_transfers,
  collection_instructions, sample_qr_tokens
TO traced_app;

-- Identity columns need their sequences.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO traced_app;

-- Functions run with the caller's rights (none is SECURITY DEFINER), so the table grants above
-- still apply inside them. Restrict EXECUTE to what is called.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON FUNCTION allocate_tracking_id(timestamptz), audit_verify_chain(), audit_verify_chain_range(bigint, bigint),
  custody_events_digest(bigint), audit_row_digest_input(audit_logs) TO traced_app;
-- Trigger functions are invoked by the trigger mechanism; EXECUTE is still checked for them.
GRANT EXECUTE ON FUNCTION set_updated_at(), reject_modification(), audit_logs_chain(), consent_documents_freeze(),
  customer_qr_tokens_guard(), collection_instructions_freeze(), collection_instruction_drafts_freeze(),
  samples_guard(), sample_qr_tokens_guard() TO traced_app;

-- 5. Read-only role: operational, non-personal tables. Extend deliberately and document it.
GRANT SELECT ON collection_branches, tracking_sequences, audit_checkpoints, audit_verifications TO traced_readonly;
GRANT EXECUTE ON FUNCTION audit_verify_chain(), audit_verify_chain_range(bigint, bigint), audit_row_digest_input(audit_logs) TO traced_readonly;
GRANT SELECT ON audit_logs TO traced_readonly; -- metadata never contains names/emails (see audit.service.ts)

-- Owner/superuser access must be limited to named individuals, logged by the cloud provider
-- (Cloud SQL admin activity + data access logs), and is the reason audit checkpoints are signed
-- with a key outside the database and copied to a retention-locked bucket.
