#!/bin/bash
# TRACED VM: run one backup now and a full restore check (temporary database; primary untouched).
set -euo pipefail
/usr/local/sbin/traced-backup
/usr/local/sbin/traced-restore-check
docker exec traced-postgres psql -U postgres -At -c "select 'databases now: ' || string_agg(datname, ', ' order by datname) from pg_database where not datistemplate"
