#!/usr/bin/env bash
# Already applied on 27 Nov 2026 (kept as the record; re-running creates duplicates for the network).
source "$(dirname "$0")/lib.sh"
VAULT=$(oci_ kms management vault list --compartment-id "$CMP" --all --query "data[?\"display-name\"=='traced-vault'].id | [0]" --raw-output)
EP=$(oci_ kms management vault get --vault-id "$VAULT" --query 'data."management-endpoint"' --raw-output)
KEY=$(oci_ kms management key list --compartment-id "$CMP" --endpoint "$EP" --all --query "data[?\"display-name\"=='traced-master-key'].id | [0]" --raw-output)
NS=$(oci_ os ns get --query data --raw-output)
D="$WORK"; W=$(winpath "$D")

# Object Storage (Riyadh) may use the TRACED master key and run lifecycle deletes in compartment TRACED only.
cat > "$D/svc.json" <<EOF
["Allow service objectstorage-me-riyadh-1 to use keys in compartment TRACED where target.key.id = '$KEY'",
 "Allow service objectstorage-me-riyadh-1 to manage object-family in compartment TRACED"]
EOF
oci_ iam policy create --compartment-id "$CMP" --name TRACED-Services-Policy \
  --description "Object Storage in me-riyadh-1: encrypt with traced-master-key; apply lifecycle rules in TRACED" \
  --statements "file://$W/svc.json" --query 'data.name' --raw-output
sleep 20  # IAM propagation

for B in traced-db-backups traced-audit-checkpoints; do
  oci_ os bucket create --compartment-id "$CMP" --namespace "$NS" --name "$B" --kms-key-id "$KEY" \
    --public-access-type NoPublicAccess --storage-tier Standard --versioning Disabled \
    --query 'data.name' --raw-output
done

cat > "$D/lc.json" <<'EOF'
{"items":[{"name":"delete-after-35-days","action":"DELETE","timeAmount":35,"timeUnit":"DAYS","isEnabled":true,"target":"objects"}]}
EOF
oci_ os object-lifecycle-policy put --namespace "$NS" --bucket-name traced-db-backups --items "$(python -I -c "import json;print(json.dumps(json.load(open('$W/lc.json'))['items']))")" --force --query 'length(data.items)' >/dev/null
echo "lifecycle: traced-db-backups delete after 35 days"

# Retention rule on the audit bucket: 400 days, NOT locked (no time-rule-locked). Removable until the owner approves locking.
oci_ os retention-rule create --namespace "$NS" --bucket-name traced-audit-checkpoints --display-name keep-400-days-unlocked \
  --time-amount 400 --time-unit DAYS --query 'data.{name:"display-name",locked:"time-rule-locked"}'
