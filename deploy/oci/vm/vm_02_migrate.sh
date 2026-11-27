#!/bin/bash
# TRACED VM step 2: build the API image at a fixed commit, apply migrations as traced_migrator,
# re-run them (checksum verification), apply production-roles.sql, set runtime passwords.
# Usage (root): vm_02_migrate.sh <vault-ocid> <git-commit> [database]   (database: traced (default) | traced_preview)
set -euo pipefail
VAULT="$1"; REF="$2"; DB="${3:-traced}"
case "$DB" in traced|traced_preview) ;; *) echo "database must be traced or traced_preview"; exit 2;; esac
export OCI_CLI_AUTH=instance_principal
sec() { oci secrets secret-bundle get-secret-bundle-by-name --vault-id "$VAULT" --secret-name "$1" \
          --query 'data."secret-bundle-content".content' --raw-output | base64 -d; }

cd /opt/traced
[ -d app/.git ] || git clone --quiet https://github.com/linusbiomena-commits/Traced.Life.git app
cd app
git fetch --quiet origin
git -c advice.detachedHead=false checkout --quiet --detach "$REF"
echo "source: $(git rev-parse --short HEAD)"
docker build -q -f docs/deploy/Dockerfile.example -t "traced-api:$REF" . >/dev/null
echo "image: traced-api:$REF ($(docker image inspect "traced-api:$REF" --format '{{.Architecture}}'))"

# Separate databases share the cluster roles; create the requested one if missing (owned by traced_migrator).
docker exec -i traced-postgres psql -q -v ON_ERROR_STOP=1 -U postgres -v db="$DB" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER traced_migrator ENCODING ''UTF8'' TEMPLATE template0', :'db') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO traced_migrator', :'db') \gexec
SQL
docker exec traced-postgres psql -q -v ON_ERROR_STOP=1 -U postgres -d "$DB" -c "ALTER SCHEMA public OWNER TO traced_migrator" -c "REVOKE ALL ON SCHEMA public FROM PUBLIC"
echo "database: $DB"
DATABASE_URL="postgres://traced_migrator:$(sec traced-db-migrator-password)@traced-postgres:5432/$DB"; export DATABASE_URL
echo "-- migrate (1st run)"; docker run --rm --network traced-db -e DATABASE_URL "traced-api:$REF" node --import tsx server/src/cli/migrate.ts
echo "-- migrate (2nd run: verifies stored checksums, applies nothing)"; docker run --rm --network traced-db -e DATABASE_URL "traced-api:$REF" node --import tsx server/src/cli/migrate.ts
unset DATABASE_URL

echo "-- production-roles.sql (as postgres)"
docker exec -i traced-postgres psql -q -v ON_ERROR_STOP=1 -U postgres -d "$DB" < server/sql/production-roles.sql
PGPW_APP=$(sec traced-db-app-password); PGPW_RO=$(sec traced-db-readonly-password); export PGPW_APP PGPW_RO
docker exec -i -e PGPW_APP -e PGPW_RO traced-postgres psql -q -v ON_ERROR_STOP=1 -U postgres -d "$DB" -v db="$DB" <<'SQL'
\getenv a PGPW_APP
\getenv r PGPW_RO
ALTER ROLE traced_app PASSWORD :'a';
ALTER ROLE traced_readonly PASSWORD :'r';
SELECT format('GRANT CONNECT ON DATABASE %I TO traced_app, traced_readonly', :'db') \gexec
SQL
unset PGPW_APP PGPW_RO
echo "roles applied"
