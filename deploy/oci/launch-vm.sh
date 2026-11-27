#!/usr/bin/env bash
# Launch traced-app-1: VM.Standard.A1.Flex, 1 OCPU / 4 GB, 50 GB boot, Ubuntu 24.04 aarch64, Riyadh.
# No SSH key, public IP for outbound traffic only (security list and NSG have NO ingress rules),
# legacy IMDS disabled, in-transit encryption on, Run Command agent enabled.
# Owner approval: hosting approved 27 Nov 2026; provisioning paused until the Pay As You Go upgrade
# is confirmed. Run once; it refuses if the instance already exists.
source "$(dirname "$0")/lib.sh"
if [ -n "$(oci_ compute instance list --compartment-id "$CMP" --display-name traced-app-1 --query 'data[?"lifecycle-state"!=`TERMINATED`].id | [0]' --raw-output 2>/dev/null | grep -v null)" ]; then
  echo "traced-app-1 already exists"; exit 0; fi
AD=$(oci_ iam availability-domain list --compartment-id "$TEN" --query 'data[0].name' --raw-output)
IMG=$(oci_ compute image list --compartment-id "$CMP" --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
        --shape VM.Standard.A1.Flex --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' --raw-output)
SUB=$(oci_ network subnet list --compartment-id "$CMP" --display-name traced-subnet-app --query 'data[0].id' --raw-output)
NSG=$(oci_ network nsg list --compartment-id "$CMP" --display-name traced-nsg-app --query 'data[0].id' --raw-output)
cat > "$WORK/agent.json" <<'EOF'
{"isMonitoringDisabled":false,"isManagementDisabled":false,"areAllPluginsDisabled":false,
 "pluginsConfig":[{"name":"Compute Instance Run Command","desiredState":"ENABLED"},
                  {"name":"Compute Instance Monitoring","desiredState":"ENABLED"},
                  {"name":"Custom Logs Monitoring","desiredState":"ENABLED"},
                  {"name":"Bastion","desiredState":"DISABLED"}]}
EOF
oci_ compute instance launch --compartment-id "$CMP" --availability-domain "$AD" --display-name traced-app-1 \
  --shape VM.Standard.A1.Flex --shape-config '{"ocpus":1,"memoryInGBs":4}' \
  --image-id "$IMG" --boot-volume-size-in-gbs 50 \
  --subnet-id "$SUB" --nsg-ids "[\"$NSG\"]" --assign-public-ip true --hostname-label traced-app-1 \
  --user-data-file "$(winpath "$HERE/vm/cloud-init.yaml")" --agent-config "file://$(winpath "$WORK/agent.json")" \
  --is-pv-encryption-in-transit-enabled true --instance-options '{"areLegacyImdsEndpointsDisabled":true}' \
  --wait-for-state RUNNING --max-wait-seconds 900 \
  --query 'data.{name:"display-name",shape:shape,state:"lifecycle-state",ocpus:"shape-config".ocpus,mem:"shape-config"."memory-in-gbs"}'
# "Out of host capacity" (500) or "Too many requests" (429) means no A1 capacity right now: retry later,
# a few attempts at most, minutes apart. Do not switch shape or region without the owner's approval.
