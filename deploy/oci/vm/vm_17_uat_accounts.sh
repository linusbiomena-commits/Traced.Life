#!/bin/bash
# TRACED VM: synthetic UAT accounts on the RESTRICTED PREVIEW (traced_preview, captured mail; nothing is sent).
# Prints each account's one-time setup link (synthetic preview accounts only; links are single-use).
# Usage (root): vm_17_uat_accounts.sh <run-id>
set -euo pipefail
RUN="$1"; . /etc/traced/api.conf
[ "$MODE" = preview ] || { echo "refusing: not preview"; exit 1; }
mk() { # who role [branch]
  local email="uat-$1-$RUN@preview.tracedmena.test" extra=()
  [ -n "${3:-}" ] && extra=(--branch "$3")
  cid=$(docker create --network traced-db --env-file /run/traced/api.env -v /var/lib/traced/devmail:/var/lib/traced/devmail "traced-api:$REF" \
    node --import tsx server/src/cli/create-user.ts --email "$email" --role "$2" --locale en --name "UAT $1" "${extra[@]}")
  docker network connect traced-edge "$cid"; docker start -a "$cid" | tail -1; docker rm "$cid" >/dev/null
}
mk admin admin
mk superadmin super_admin
mk superadminmfa super_admin
mk auditor auditor
mk collector collection_staff DEV-RUH-01
mk lab lab_operator
sleep 2
for who in admin superadmin superadminmfa auditor collector lab; do
  f=$(grep -l "^To: uat-$who-$RUN@preview.tracedmena.test" /var/lib/traced/devmail/*account_setup*.txt 2>/dev/null | head -1)
  echo "$who: $(grep -o 'https://[^ ]*#token=[A-Za-z0-9_-]*' "$f" | head -1)"
done
