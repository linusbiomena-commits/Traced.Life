#!/bin/bash
# TRACED VM: deployed end-to-end journey on the RESTRICTED PREVIEW (traced_preview, synthetic data only).
#  1. seeds synthetic reference data (development seed; refuses production) as traced_migrator
#  2. invites a preview super admin at the captured domain @preview.tracedmena.test
#  3. runs deploy/oci/e2e/preview-journey.mjs against the API container (inside the server)
#  4. deletes the captured mail files (they contain one-time links for synthetic accounts)
# Usage (root): vm_13_e2e.sh <vault-ocid>
set -uo pipefail
VAULT="$1"
. /etc/traced/api.conf
[ "$MODE" = preview ] && [ "$DB" = traced_preview ] || { echo "refusing: API is not in preview mode on traced_preview"; exit 1; }
grep -q '^MAIL_CAPTURE_DOMAINS=preview.tracedmena.test' /run/traced/api.env || { echo "mail capture not enabled"; exit 1; }
export OCI_CLI_AUTH=instance_principal
MIG=$(oci secrets secret-bundle get-secret-bundle-by-name --vault-id "$VAULT" --secret-name traced-db-migrator-password --query 'data."secret-bundle-content".content' --raw-output | base64 -d)
RUN=$(date -u +%m%d%H%M)

echo "== seed synthetic reference data (traced_preview)"
DATABASE_URL="postgres://traced_migrator:$MIG@traced-postgres:5432/traced_preview" NODE_ENV=development \
  docker run --rm --network traced-db -e DATABASE_URL -e NODE_ENV "traced-api:$REF" node --import tsx server/src/cli/seed-dev.ts 2>&1 | tail -1
unset MIG

echo "== invite preview super admin"
docker run --rm --network traced-db --env-file /run/traced/api.env -v /var/lib/traced/devmail:/var/lib/traced/devmail "traced-api:$REF" \
  node --import tsx server/src/cli/create-user.ts --email "superadmin-$RUN@preview.tracedmena.test" --role super_admin --locale en 2>&1 | tail -1

echo "== journey"
mkdir -p /opt/traced/e2e && oci os object get --namespace "$NS" --bucket-name traced-db-backups --name ops/preview-journey.mjs --file /opt/traced/e2e/preview-journey.mjs >/dev/null  # uploaded by vmrun-e2e (admin PC)
docker run --rm --network traced-edge -e BASE=http://traced-api:8080/api/v1 -e ORIGIN="$APP_ORIGIN" -e MAILDIR=/mail -e RUN_ID="$RUN" \
  -v /var/lib/traced/devmail:/mail:ro -v /opt/traced/e2e:/e2e:ro "traced-api:$REF" \
  sh -c 'mkdir -p /tmp/q && cd /tmp/q && npm init -y >/dev/null 2>&1 && npm install --silent --no-audit --no-fund jsqr@1.4.0 pngjs@7.0.0 >/dev/null 2>&1 && cd /app && node /e2e/preview-journey.mjs'
rc=$?
echo "== cleanup captured mail"; find /var/lib/traced/devmail -type f -delete; echo "captured files left: $(find /var/lib/traced/devmail -type f | wc -l)"
exit $rc
