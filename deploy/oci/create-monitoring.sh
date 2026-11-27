#!/usr/bin/env bash
# TRACED operations alerts (free tier): Notifications topic + email subscription + Monitoring alarms.
# The subscriber receives an Oracle confirmation email and must click it before alerts are delivered.
# Usage: deploy/oci/create-monitoring.sh <alert-email>
source "$(dirname "$0")/lib.sh"
EMAIL="$1"
TOPIC=$(oci_ ons topic list --compartment-id "$CMP" --name traced-ops-alerts --query 'data[0]."topic-id"' --raw-output 2>/dev/null || true)
if [ -z "$TOPIC" ] || [ "$TOPIC" = null ]; then
  TOPIC=$(oci_ ons topic create --compartment-id "$CMP" --name traced-ops-alerts --description "TRACED operational alerts" --query 'data."topic-id"' --raw-output)
  echo "topic created"
fi
if ! oci_ ons subscription list --compartment-id "$CMP" --topic-id "$TOPIC" --query 'data[].endpoint' 2>/dev/null | grep -q "$EMAIL"; then
  oci_ ons subscription create --compartment-id "$CMP" --topic-id "$TOPIC" --protocol EMAIL --subscription-endpoint "$EMAIL" --query 'data."lifecycle-state"' --raw-output
fi
alarm() { # name severity pending query body
  if [ -n "$(oci_ monitoring alarm list --compartment-id "$CMP" --display-name "$1" --query 'data[0].id' --raw-output 2>/dev/null | grep -v null)" ]; then echo "exists: $1"; return; fi
  oci_ monitoring alarm create --compartment-id "$CMP" --metric-compartment-id "$CMP" --display-name "$1" --severity "$2" \
    --pending-duration "$3" --namespace "$4" --query-text "$5" --body "$6" --destinations "[\"$TOPIC\"]" \
    --is-enabled true --repeat-notification-duration PT4H --query 'data."display-name"' --raw-output
}
alarm traced-api-unhealthy CRITICAL PT10M traced 'api_health[5m]{host = "traced-app-1"}.min() < 1' "TRACED API health check failing through HTTPS (Caddy/API/DB). Check traced-app-1 via Run Command."
alarm traced-health-metrics-missing CRITICAL PT15M traced 'api_health[5m]{host = "traced-app-1"}.absent()' "No health metrics from traced-app-1 for 15 minutes: instance down, agent or timer stopped."
alarm traced-containers-down CRITICAL PT10M traced 'containers_up[5m]{host = "traced-app-1"}.min() < 3' "One of traced-api, traced-caddy, traced-postgres is not running."
alarm traced-disk-high WARNING PT15M traced 'disk_used_pct[5m]{host = "traced-app-1"}.max() > 80' "Root disk on traced-app-1 above 80%."
alarm traced-backup-stale CRITICAL PT1H traced 'backup_age_hours[1h]{host = "traced-app-1"}.max() > 26' "No successful encrypted database backup for more than 26 hours."
alarm traced-cpu-high WARNING PT15M oci_computeagent 'CpuUtilization[5m]{resourceDisplayName = "traced-app-1"}.mean() > 85' "CPU above 85% for 15 minutes on traced-app-1."
alarm traced-memory-high WARNING PT15M oci_computeagent 'MemoryUtilization[5m]{resourceDisplayName = "traced-app-1"}.mean() > 90' "Memory above 90% for 15 minutes on traced-app-1."
