#!/usr/bin/env bash
# Uploads an approved consent release folder (manifest.json + text files, no personal data) to the private
# ops area of the Riyadh bucket, for vm_21_publish_consent.sh. Nothing is published by this script.
#   deploy/oci/upload-consent-release.sh <local-folder> <release-name>
# release-name: letters, digits, dot, underscore, hyphen (e.g. consents-v1.0-2026-12-01).
source "$(dirname "$0")/lib.sh"
DIR="$1"; NAME="$2"
[[ "$NAME" =~ ^[A-Za-z0-9._-]{3,60}$ ]] || { echo "release-name: 3-60 of A-Z a-z 0-9 . _ -"; exit 2; }
[ -f "$DIR/manifest.json" ] || { echo "$DIR/manifest.json not found"; exit 2; }
NS=$(os_ns)
oci_ os object bulk-upload --namespace "$NS" --bucket-name traced-db-backups --src-dir "$(winpath "$DIR")" \
  --object-prefix "ops/consents/$NAME/" --overwrite --no-multipart >/dev/null
oci_ os object list --namespace "$NS" --bucket-name traced-db-backups --prefix "ops/consents/$NAME/" --query 'data[].name' --raw-output
echo "Uploaded. Next: deploy/oci/vmrun.sh vm/vm_21_publish_consent.sh $NAME <publisher-email> dry-run"
