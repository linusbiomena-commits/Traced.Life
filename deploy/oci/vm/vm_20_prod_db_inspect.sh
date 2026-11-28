#!/bin/bash
# TRACED VM: strictly read-only inspection of the clean PRODUCTION database `traced` (Phase 8D).
# Only SELECT statements, run as postgres inside the container; no write is attempted (vm_03 is the
# version that also proves the runtime role's write denials). Prints counts and identifiers, no personal data.
# Usage (root): vm_20_prod_db_inspect.sh
set -uo pipefail
q() { docker exec traced-postgres psql -U postgres -d traced -At -F ' | ' -c "$1" 2>&1; }
echo "== server mode (api.conf, no secrets)"; grep -E '^(MODE|DB|NODE_ENV|REF|APP_ORIGIN|DEVIDV)=' /etc/traced/api.conf
echo "== databases"; docker exec traced-postgres psql -U postgres -At -F ' | ' -c "select datname, pg_get_userbyid(datdba), pg_size_pretty(pg_database_size(datname)) from pg_database where datname like 'traced%' order by 1"
echo "== data checksums"; q "show data_checksums"
echo "== migrations"; q "select version, left(checksum,12), to_char(applied_at,'YYYY-MM-DD HH24:MI') from schema_migrations order by version"
echo "== roles"; q "select rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin, rolbypassrls from pg_roles where rolname like 'traced%' order by 1"
echo "== table owner"; q "select distinct tableowner from pg_tables where schemaname='public'"
echo "== runtime grants on evidence tables (traced_app)"
q "select table_name, string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants where grantee='traced_app' and table_name in ('audit_logs','custody_events','consent_records','registration_status_history','audit_checkpoints') group by 1 order by 1"
echo "== row counts (expect 0 for every data table)"
for t in users user_roles sessions auth_tokens registrations patients samples custody_events consent_records consent_documents collection_instructions collection_instruction_drafts collection_branches staff_branch_assignments customer_qr_tokens sample_qr_tokens collection_sessions tracking_sequences mfa_recovery_codes registration_branch_transfers patient_revisions sample_label_prints email_outbox identity_verifications recollection_authorizations audit_logs audit_checkpoints audit_verifications rate_limits; do
  printf '%s | %s\n' "$t" "$(q "select count(*) from $t")"
done
echo "== reference data"; q "select 'roles', count(*) from roles"; q "select 'permissions', count(*) from permissions"; q "select 'role_permissions', count(*) from role_permissions"
q "select role_key, count(*) from role_permissions group by 1 order by 1"
echo "== audit chain"; q "select coalesce('BROKEN at chain_seq ' || audit_verify_chain(), 'intact (audit_verify_chain() is NULL)')"
echo "== timers"; systemctl list-timers --no-pager 'traced-*' | sed -n '1,12p'
echo "== last backup log"; journalctl -u traced-backup.service --no-pager -n 6 -o cat 2>/dev/null | tail -6
