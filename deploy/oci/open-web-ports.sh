#!/usr/bin/env bash
# Adds ingress TCP 443 (HTTPS API) and TCP 80 (Let's Encrypt HTTP-01 + redirect to HTTPS) to traced-nsg-app.
# Nothing else is opened: PostgreSQL (5432) and SSH (22) stay closed. Owner approval: Phase 8C, 27 Nov 2026.
source "$(dirname "$0")/lib.sh"
NSG=$(oci_ network nsg list --compartment-id "$CMP" --display-name traced-nsg-app --query 'data[0].id' --raw-output)
have=$(oci_ network nsg rules list --nsg-id "$NSG" --direction INGRESS --query 'data[]."tcp-options"."destination-port-range".min' --raw-output 2>/dev/null || echo '[]')
rules='['; sep=''
for p in 443 80; do
  echo "$have" | grep -qw "$p" && { echo "port $p already open"; continue; }
  rules+="$sep{\"direction\":\"INGRESS\",\"protocol\":\"6\",\"source\":\"0.0.0.0/0\",\"sourceType\":\"CIDR_BLOCK\",\"isStateless\":false,\"description\":\"TRACED API $p\",\"tcpOptions\":{\"destinationPortRange\":{\"min\":$p,\"max\":$p}}}"; sep=','
done
rules+=']'
[ "$rules" = '[]' ] || { echo "$rules" > "$WORK/nsg-in.json"; oci_ network nsg rules add --nsg-id "$NSG" --security-rules "file://$(winpath "$WORK/nsg-in.json")" --query 'data."security-rules"[].{dir:direction,port:"tcp-options"."destination-port-range".min}' --output table; }
