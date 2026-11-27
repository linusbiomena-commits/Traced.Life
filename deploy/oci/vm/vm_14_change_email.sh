#!/bin/bash
# TRACED VM: audited login-email change in the RESTRICTED PREVIEW (refused in production by the code).
# Usage (root): vm_14_change_email.sh <from> <to> <reason_with_underscores> [send-setup]
#   reason: underscores become spaces (Run Command arguments cannot contain quotes)
set -euo pipefail
FROM="$1"; TO="$2"; REASON="${3//_/ }"; SETUP="${4:-}"
. /etc/traced/api.conf
[ "$MODE" = preview ] || { echo "refusing: API is not in preview mode"; exit 1; }
EXTRA=(); [ "$SETUP" = send-setup ] && EXTRA=(--send-setup)
cid=$(docker create --network traced-db --env-file /run/traced/api.env -v /var/lib/traced/devmail:/var/lib/traced/devmail "traced-api:$REF" \
  node --import tsx server/src/cli/change-user-email.ts --from "$FROM" --to "$TO" --reason "$REASON" "${EXTRA[@]}")
docker network connect traced-edge "$cid"
docker start -a "$cid"; rc=$?; docker rm "$cid" >/dev/null; exit $rc
