#!/usr/bin/env bash
# Replace traced-app-1's ephemeral public IP with a reserved one (traced-api-ip), so DNS can point at it.
# OCI does not charge for public IPs. Outbound traffic pauses for a few seconds; nothing is opened inbound.
source "$(dirname "$0")/lib.sh"
INST=$(oci_ compute instance list --compartment-id "$CMP" --display-name traced-app-1 --lifecycle-state RUNNING --query 'data[0].id' --raw-output)
VNIC=$(oci_ compute instance list-vnics --instance-id "$INST" --query 'data[0].id' --raw-output)
PRIV=$(oci_ network private-ip list --vnic-id "$VNIC" --query 'data[?"is-primary"].id | [0]' --raw-output)
RES=$(oci_ network public-ip list --compartment-id "$CMP" --scope REGION --lifetime RESERVED --all --query "data[?\"display-name\"=='traced-api-ip'].id | [0]" --raw-output 2>/dev/null || true)
if [ -z "$RES" ] || [ "$RES" = null ]; then
  RES=$(oci_ network public-ip create --compartment-id "$CMP" --lifetime RESERVED --display-name traced-api-ip --wait-for-state AVAILABLE --query 'data.id' --raw-output)
  echo "reserved traced-api-ip"
fi
CUR=$(oci_ network public-ip get --private-ip-id "$PRIV" --query 'data.{id:id,lifetime:lifetime}' 2>/dev/null || echo '{}')
if echo "$CUR" | grep -q "$RES"; then echo "already attached"; else
  EPH=$(echo "$CUR" | python -I -c "import sys,json;d=json.load(sys.stdin) if sys.stdin.readable() else {};print(d.get('id','') if d.get('lifetime')=='EPHEMERAL' else '')" 2>/dev/null || true)
  [ -n "$EPH" ] && oci_ network public-ip delete --public-ip-id "$EPH" --force --wait-for-state TERMINATED >/dev/null && echo "released ephemeral IP"
  oci_ network public-ip update --public-ip-id "$RES" --private-ip-id "$PRIV" --wait-for-state ASSIGNED --query 'data."lifecycle-state"' --raw-output
fi
echo "traced-api-ip = $(oci_ network public-ip get --public-ip-id "$RES" --query 'data."ip-address"' --raw-output)"
