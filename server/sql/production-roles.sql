-- DRAFT — production database roles for TRACED. NOT executed anywhere yet.
-- To be reviewed and applied during Phase 7/8 by the database owner, with real passwords set
-- out of band (never committed). Assumes the schema is owned by traced_owner.
--
-- Roles
--   traced_owner     owns the schema; runs migrations only; credentials kept offline.
--   traced_app       the API's runtime login: no DDL, no TRUNCATE, no UPDATE/DELETE on
--                    append-only tables (defence in depth on top of the triggers).
--   traced_readonly  reporting / support read access (no personal-data tables by default).

CREATE ROLE traced_owner NOLOGIN;
CREATE ROLE traced_app LOGIN PASSWORD NULL;        -- set with \password, never in a file
CREATE ROLE traced_readonly LOGIN PASSWORD NULL;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO traced_app, traced_readonly;

-- Default: the app may read and write ordinary tables...
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO traced_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO traced_app;
GRANT EXECUTE ON FUNCTION allocate_tracking_id(timestamptz) TO traced_app;
GRANT EXECUTE ON FUNCTION audit_verify_chain() TO traced_app, traced_readonly;

-- ...but append-only evidence tables are INSERT + SELECT only.
REVOKE UPDATE, DELETE, TRUNCATE ON
  audit_logs, consent_records, registration_status_history, patient_revisions
FROM traced_app;

-- Rows the app must be able to delete (housekeeping only).
GRANT DELETE ON rate_limits, mfa_recovery_codes TO traced_app;

-- Nothing in the app needs these.
REVOKE ALL ON schema_migrations FROM traced_app;
GRANT SELECT ON schema_migrations TO traced_app;

-- Read-only role: operational tables without personal data. Extend deliberately.
GRANT SELECT ON collection_branches, tracking_sequences, registration_status_history, audit_logs TO traced_readonly;

-- Superuser / owner access must be limited to named individuals, logged by the cloud provider,
-- and is the reason audit checkpoints are exported outside the database (see
-- docs/audit-hardening-plan.md).
