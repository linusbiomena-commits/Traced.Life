#!/bin/bash
# TRACED VM: publish APPROVED consent documents with the publish-consent command (Phase 8E).
# Usage (root): vm_21_publish_consent.sh <release-name> <publisher-email> <dry-run|publish>
#   The release folder must first be uploaded with deploy/oci/upload-consent-release.sh (ops/consents/<name>/).
#   Runs against the database the API currently uses (production mode -> traced, target production;
#   preview mode -> traced_preview, target preview), connecting as the least-privilege traced_app role.
#   "publish" writes all documents in one transaction with audit entries; "dry-run" writes nothing.
set -euo pipefail
NAME="$1"; PUBLISHER="$2"; ACTION="$3"
[[ "$NAME" =~ ^[A-Za-z0-9._-]{3,60}$ ]] || { echo "invalid release name"; exit 2; }
[[ "$PUBLISHER" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] || { echo "invalid publisher email"; exit 2; }
case "$ACTION" in dry-run) FLAG=--dry-run;; publish) FLAG=--publish;; *) echo "action must be dry-run or publish"; exit 2;; esac
. /etc/traced/api.conf
case "$MODE" in production) TARGET=production;; preview) TARGET=preview;; *) echo "unknown MODE $MODE"; exit 1;; esac
echo "API mode: $MODE (database $DB), image traced-api:$REF, target $TARGET, action $ACTION"
docker run --rm --entrypoint test "traced-api:$REF" -f server/src/cli/publish-consent.ts \
  || { echo "image traced-api:$REF has no publish-consent command: build a newer image with vm_02_migrate.sh (migration 0012 required)"; exit 1; }

export OCI_CLI_AUTH=instance_principal
NS=$(oci os ns get --query data --raw-output)
WORK=$(mktemp -d /root/consent-release.XXXXXX); chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
oci os object bulk-download --namespace "$NS" --bucket-name traced-db-backups --prefix "ops/consents/$NAME/" --download-dir "$WORK" >/dev/null
REL="$WORK/ops/consents/$NAME"
[ -f "$REL/manifest.json" ] || { echo "release $NAME not found in ops/consents/"; exit 1; }
chmod -R a+rX "$WORK"   # the container runs as uid 1000 and mounts the folder read-only
echo "Files: $(cd "$REL" && ls | tr '\n' ' ')"

cid=$(docker create --network traced-db --env-file /run/traced/api.env -v "$REL:/release:ro" "traced-api:$REF" \
  node --import tsx server/src/cli/publish-consent.ts --manifest /release/manifest.json --publisher "$PUBLISHER" --target "$TARGET" "$FLAG")
docker start -a "$cid" && rc=0 || rc=$?
docker rm "$cid" >/dev/null; exit $rc
