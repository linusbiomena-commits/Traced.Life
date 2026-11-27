#!/usr/bin/env bash
# Run a script from deploy/oci/vm/ on traced-app-1 as root through OCI Run Command (no SSH, no open port).
#   deploy/oci/vmrun.sh vm/vm_01_db.sh '<vault-ocid>'
# Arguments are substituted literally; pass only identifiers (OCIDs, commit hashes), never secrets.
# The script is staged in traced-db-backups/ops/ and its output in ops/out/ (both deleted after 35 days).
source "$(dirname "$0")/lib.sh"
SCRIPT="$1"; shift; NAME=$(basename "$SCRIPT"); ARGS="$*"
case "$ARGS" in *[\'\"\`\$\;\&\|]*) echo "refusing unsafe characters in arguments"; exit 2;; esac
INST=$(oci_ compute instance list --compartment-id "$CMP" --display-name traced-app-1 --lifecycle-state RUNNING --query 'data[0].id' --raw-output)
[ -n "$INST" ] && [ "$INST" != null ] || { echo "traced-app-1 is not running"; exit 1; }
NS=$(os_ns); STAMP=$(date -u +%Y%m%dT%H%M%SZ)
oci_ os object put --namespace "$NS" --bucket-name traced-db-backups --name "ops/$NAME" --file "$(winpath "$HERE/$SCRIPT")" --force >/dev/null
TEXT="sudo bash -c 'set -o pipefail; /usr/local/bin/oci os object get --auth instance_principal --namespace $NS --bucket-name traced-db-backups --name ops/$NAME --file /root/$NAME >/dev/null && bash /root/$NAME $ARGS 2>&1; echo EXIT=\$?'"
python -I - "$(winpath "$WORK/content.json")" "$TEXT" "$NS" "ops/out/$NAME.$STAMP.txt" <<'EOF'
import json, sys
p, text, ns, obj = sys.argv[1:]
json.dump({"source": {"sourceType": "TEXT", "text": text},
           "output": {"outputType": "OBJECT_STORAGE_TUPLE", "bucketName": "traced-db-backups", "namespaceName": ns, "objectName": obj}}, open(p, "w"))
EOF
CMD=$(oci_ instance-agent command create --compartment-id "$CMP" --timeout-in-seconds "${TIMEOUT:-3000}" \
  --target "{\"instanceId\":\"$INST\"}" --content "file://$(winpath "$WORK/content.json")" \
  --display-name "$NAME-$STAMP" --query 'data.id' --raw-output)
st=PENDING
for _ in $(seq 1 400); do
  st=$(oci_ instance-agent command-execution get --command-id "$CMD" --instance-id "$INST" --query 'data."lifecycle-state"' --raw-output 2>/dev/null || echo PENDING)
  case "$st" in SUCCEEDED|FAILED|TIMED_OUT|CANCELED) break;; esac
  sleep 10
done
echo "[run command: $st]"
oci_ os object get --namespace "$NS" --bucket-name traced-db-backups --name "ops/out/$NAME.$STAMP.txt" --file "$(winpath "$WORK/out.txt")" >/dev/null 2>&1 \
  && cat "$WORK/out.txt" && rm -f "$WORK/out.txt"
