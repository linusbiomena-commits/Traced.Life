#!/bin/bash
# TRACED VM step 1: PostgreSQL 18 container (no published ports) + migration owner role + database.
# Usage (root): vm_01_db.sh <vault-ocid>. Secrets come from OCI Vault via the instance principal and
# are never echoed; they live only in process environment or on /run (tmpfs).
set -euo pipefail
VAULT="$1"
test -f /var/lib/cloud/instance/traced-bootstrap-done || { echo "bootstrap not finished yet"; exit 3; }
export OCI_CLI_AUTH=instance_principal
sec() { oci secrets secret-bundle get-secret-bundle-by-name --vault-id "$VAULT" --secret-name "$1" \
          --query 'data."secret-bundle-content".content' --raw-output | base64 -d; }

docker network inspect traced-db >/dev/null 2>&1 || docker network create --internal traced-db >/dev/null
install -d -m 700 /var/lib/traced/pgdata

PGARGS=(-c shared_buffers=384MB -c effective_cache_size=1GB -c max_connections=60
        -c password_encryption=scram-sha-256 -c log_min_duration_statement=500
        -c log_connections=on -c log_disconnections=on -c log_line_prefix='%m [%p] %u@%d ')
run_pg() { docker run -d --name traced-postgres --restart unless-stopped --network traced-db \
  --network-alias traced-postgres -v /var/lib/traced/pgdata:/var/lib/postgresql \
  --shm-size=256m --memory=1500m "$@" postgres:18 "${PGARGS[@]}" >/dev/null; }

if ! docker ps -a --format '{{.Names}}' | grep -qx traced-postgres; then
  install -d -m 700 /run/traced
  sec traced-pg-superuser-password > /run/traced/pg_super; chmod 600 /run/traced/pg_super
  # First start initialises the cluster with the superuser password from a tmpfs file ...
  run_pg -v /run/traced/pg_super:/run/secrets/pg_super:ro -e POSTGRES_PASSWORD_FILE=/run/secrets/pg_super \
         -e POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale=C.UTF-8 --data-checksums"
  for i in $(seq 1 60); do docker exec traced-postgres pg_isready -U postgres -q && break; sleep 2; done
  sleep 3; docker exec traced-postgres pg_isready -U postgres -q
  # ... then it is recreated WITHOUT the password file or any password in its configuration.
  docker rm -f traced-postgres >/dev/null; shred -u /run/traced/pg_super
  run_pg
fi
for i in $(seq 1 60); do docker exec traced-postgres pg_isready -U postgres -q && break; sleep 2; done

PGPW=$(sec traced-db-migrator-password); export PGPW
docker exec -i -e PGPW traced-postgres psql -q -v ON_ERROR_STOP=1 -U postgres <<'SQL'
\getenv pw PGPW
SELECT 'CREATE ROLE traced_migrator LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'traced_migrator') \gexec
ALTER ROLE traced_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'pw';
SELECT 'CREATE DATABASE traced OWNER traced_migrator ENCODING ''UTF8'' TEMPLATE template0' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'traced') \gexec
REVOKE ALL ON DATABASE traced FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE traced TO traced_migrator;
\c traced
ALTER SCHEMA public OWNER TO traced_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL
unset PGPW
docker exec traced-postgres psql -U postgres -At -c "select 'server ' || current_setting('server_version') || ', data checksums ' || current_setting('data_checksums') || ', db traced owner ' || pg_get_userbyid(datdba) from pg_database where datname='traced'"
docker inspect traced-postgres --format 'published ports: {{json .HostConfig.PortBindings}}; networks: {{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
echo "password variables in container config: $(docker inspect traced-postgres --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -c '^POSTGRES_PASSWORD' || true)"
