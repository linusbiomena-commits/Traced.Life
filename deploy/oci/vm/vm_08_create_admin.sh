#!/bin/bash
# TRACED VM step 8: create a staff-side account (first super administrators) in the database the API is
# currently using (traced_preview in preview mode, traced in production mode), using the running API's
# configuration. The person receives a one-time setup link by email (Resend) and must set a password and
# enrol two-step verification at first sign-in. No password is created or stored here.
# Usage (root): vm_08_create_admin.sh <email> [role] [locale]     role default super_admin, locale en|ar
set -euo pipefail
EMAIL="$1"; ROLE="${2:-super_admin}"; LOCALE="${3:-en}"
[[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[A-Za-z]{2,}$ ]] || { echo "invalid email"; exit 2; }
[ -f /run/traced/api.env ] || { echo "API not configured (run vm_07_api_install.sh first)"; exit 1; }
. /etc/traced/api.conf
echo "mode: $MODE, database: $DB"
# Database network (internal) + edge network (outbound HTTPS to Resend), so the first send succeeds.
cid=$(docker create --network traced-db --env-file /run/traced/api.env "traced-api:$REF" \
  node --import tsx server/src/cli/create-user.ts --email "$EMAIL" --role "$ROLE" --locale "$LOCALE")
docker network connect traced-edge "$cid"
docker start -a "$cid"; rc=$?; docker rm "$cid" >/dev/null; exit $rc
