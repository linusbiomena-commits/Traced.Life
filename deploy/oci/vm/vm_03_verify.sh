#!/bin/bash
# TRACED VM step 3: read-only verification of schema, migrations and runtime-role restrictions.
# Usage (root): vm_03_verify.sh <vault-ocid>. Writes nothing except what the denied statements attempt.
set -uo pipefail
VAULT="$1"
export OCI_CLI_AUTH=instance_principal
sec() { oci secrets secret-bundle get-secret-bundle-by-name --vault-id "$VAULT" --secret-name "$1" \
          --query 'data."secret-bundle-content".content' --raw-output | base64 -d; }
q() { docker exec traced-postgres psql -U postgres -d traced -At -F ' | ' -c "$1"; }

echo "== migrations"; q "select version, left(checksum,12) from schema_migrations order by version"
echo "== counts"
q "select 'tables', count(*) from pg_tables where schemaname='public'"
q "select 'indexes', count(*) from pg_indexes where schemaname='public'"
q "select 'constraints '||contype, count(*) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public' group by contype order by 1"
q "select 'triggers', count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal"
echo "== append-only triggers on evidence tables"
q "select c.relname, string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and c.relname in ('audit_logs','custody_events','consent_records','registration_status_history','audit_checkpoints','sample_label_prints') group by c.relname order by 1"
echo "== audit chain"; q "select * from audit_verify_chain()"
echo "== custody digest (empty db)"; q "select custody_events_digest(0) is not null"
echo "== role attributes"
q "select rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls, rolconnlimit from pg_roles where rolname like 'traced%' order by 1"
echo "== table owner"; q "select distinct tableowner from pg_tables where schemaname='public'"

APW=$(sec traced-db-app-password); export APW
app() { docker exec -e PGPASSWORD="$APW" traced-postgres psql -h 127.0.0.1 -U traced_app -d traced -At -v ON_ERROR_STOP=1 -c "$1" 2>&1 | head -1; }
echo "== traced_app (TCP + SCRAM) checks"
echo "connect/select audit_logs: $(app 'select count(*) from audit_logs')"
for t in audit_logs custody_events consent_records registration_status_history audit_checkpoints; do
  echo "UPDATE $t: $(app "update $t set id = id where false")"
  echo "DELETE $t: $(app "delete from $t where false")"
  echo "TRUNCATE $t: $(app "truncate $t")"
done
echo "CREATE TABLE: $(app 'create table zz_probe(i int)')"
echo "DROP TABLE audit_logs: $(app 'drop table audit_logs')"
echo "ALTER TABLE audit_logs DISABLE TRIGGER ALL: $(app 'alter table audit_logs disable trigger all')"
echo "SET ROLE postgres: $(app 'set role postgres')"
echo "SET ROLE traced_migrator: $(app 'set role traced_migrator')"
echo "COPY TO PROGRAM: $(app "copy (select 1) to program 'id'")"
unset APW
RPW=$(sec traced-db-readonly-password)
echo "traced_readonly INSERT audit_logs: $(docker exec -e PGPASSWORD="$RPW" traced-postgres psql -h 127.0.0.1 -U traced_readonly -d traced -At -c "insert into audit_logs default values" 2>&1 | head -1)"
echo "traced_readonly read users: $(docker exec -e PGPASSWORD="$RPW" traced-postgres psql -h 127.0.0.1 -U traced_readonly -d traced -At -c "select count(*) from users" 2>&1 | head -1)"
unset RPW
echo "== exposure"
docker inspect traced-postgres --format 'published ports: {{json .HostConfig.PortBindings}}'
ss -ltnp | awk 'NR==1 || /:5432/' ; echo "(no host listener on 5432 expected)"
echo "== host"; free -m | awk 'NR<=2'; df -h / | tail -1; docker stats --no-stream --format '{{.Name}} cpu {{.CPUPerc}} mem {{.MemUsage}}'
