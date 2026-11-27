#!/usr/bin/env bash
# Already applied on 27 Nov 2026 (kept as the record; re-running creates duplicates for the network).
# TRACED network: VCN, internet gateway (egress only), route table, security list with NO ingress,
# public subnet, NSG with no ingress rules. All free.
source "$(dirname "$0")/lib.sh"
D="$WORK"; W=$(winpath "$D")

VCN=$(oci_ network vcn list --compartment-id "$CMP" --display-name traced-vcn --query 'data[0].id' --raw-output 2>/dev/null || true)
if [ -z "$VCN" ] || [ "$VCN" = "null" ]; then
  VCN=$(oci_ network vcn create --compartment-id "$CMP" --display-name traced-vcn --cidr-blocks '["10.20.0.0/16"]' --dns-label traced --wait-for-state AVAILABLE --query 'data.id' --raw-output)
fi
echo "vcn ok"
IGW=$(oci_ network internet-gateway create --compartment-id "$CMP" --vcn-id "$VCN" --display-name traced-igw --is-enabled true --wait-for-state AVAILABLE --query 'data.id' --raw-output)
echo "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" > "$D/rt.json"
RT=$(oci_ network route-table create --compartment-id "$CMP" --vcn-id "$VCN" --display-name traced-rt-public --route-rules "file://$W/rt.json" --wait-for-state AVAILABLE --query 'data.id' --raw-output)
echo '[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]' > "$D/egress.json"
SL=$(oci_ network security-list create --compartment-id "$CMP" --vcn-id "$VCN" --display-name traced-sl-no-ingress --ingress-security-rules '[]' --egress-security-rules "file://$W/egress.json" --wait-for-state AVAILABLE --query 'data.id' --raw-output)
SUB=$(oci_ network subnet create --compartment-id "$CMP" --vcn-id "$VCN" --display-name traced-subnet-app --cidr-block 10.20.1.0/24 --dns-label app --route-table-id "$RT" --security-list-ids "[\"$SL\"]" --prohibit-public-ip-on-vnic false --wait-for-state AVAILABLE --query 'data.id' --raw-output)
NSG=$(oci_ network nsg create --compartment-id "$CMP" --vcn-id "$VCN" --display-name traced-nsg-app --wait-for-state AVAILABLE --query 'data.id' --raw-output)
echo "[{\"direction\":\"EGRESS\",\"protocol\":\"all\",\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"isStateless\":false,\"description\":\"outbound updates, images, OCI APIs\"}]" > "$D/nsg.json"
oci_ network nsg rules add --nsg-id "$NSG" --security-rules "file://$W/nsg.json" --query 'length(data."security-rules")' >/dev/null
# The VCN's default security list allows SSH from anywhere; it is not attached to our subnet, but empty it anyway.
DSL=$(oci_ network vcn get --vcn-id "$VCN" --query 'data."default-security-list-id"' --raw-output)
oci_ network security-list update --security-list-id "$DSL" --ingress-security-rules '[]' --force --query 'data."display-name"' >/dev/null
echo "network ok: igw, route table, no-ingress security list, subnet 10.20.1.0/24, nsg (egress only); default list emptied"
