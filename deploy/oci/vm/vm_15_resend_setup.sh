#!/bin/bash
# TRACED VM: re-send a staff-side setup invitation (older unused setup links stop working). Uses the running
# API's configuration, so the link points at the current APP_ORIGIN. Usage (root): vm_15_resend_setup.sh <email>
set -euo pipefail
EMAIL="$1"; . /etc/traced/api.conf
echo "mode: $MODE, database: $DB, origin: $APP_ORIGIN"
cid=$(docker create --network traced-db --env-file /run/traced/api.env -v /var/lib/traced/devmail:/var/lib/traced/devmail "traced-api:$REF" \
  node --import tsx server/src/cli/resend-setup.ts --email "$EMAIL")
docker network connect traced-edge "$cid"
docker start -a "$cid"; rc=$?; docker rm "$cid" >/dev/null; exit $rc
