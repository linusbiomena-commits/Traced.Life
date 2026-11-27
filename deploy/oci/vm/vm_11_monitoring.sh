#!/bin/bash
# TRACED VM step 11: publish health metrics to OCI Monitoring (namespace "traced") every 5 minutes, using the
# instance principal (policy: use metrics in compartment TRACED where namespace = 'traced'). Free tier.
#   api_health        1 if https://<api-host>/api/v1/health answers 200 through Caddy, else 0
#   containers_up     number of running containers among traced-api, traced-caddy, traced-postgres (expect 3)
#   disk_used_pct     root filesystem usage
#   backup_age_hours  hours since the last successful encrypted backup upload
# Usage (root): vm_11_monitoring.sh
set -euo pipefail
. /etc/traced/api.conf
# Mark successful backups (the backup script logs; this adds a timestamp file the health job reads).
grep -q 'last-backup-ok' /usr/local/sbin/traced-backup || \
  sed -i 's|^echo "uploaded \$OBJ"$|date +%s > /var/lib/traced/last-backup-ok\necho "uploaded $OBJ"|' /usr/local/sbin/traced-backup
[ -f /var/lib/traced/last-backup-ok ] || date -d '2026-11-27 15:00:41 UTC' +%s > /var/lib/traced/last-backup-ok

cat > /usr/local/sbin/traced-health <<'EOF'
#!/bin/bash
set -uo pipefail
. /etc/traced/api.conf
export OCI_CLI_AUTH=instance_principal
MD="http://169.254.169.254/opc/v2/instance"
CMP=$(curl -s -H "Authorization: Bearer Oracle" "$MD/compartmentId")
REGION=$(curl -s -H "Authorization: Bearer Oracle" "$MD/canonicalRegionName")
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$API_HOST/api/v1/health")
api=0; [ "$code" = 200 ] && api=1
up=$(docker ps --format '{{.Names}}' | grep -cE '^traced-(api|caddy|postgres)$')
disk=$(df --output=pcent / | tail -1 | tr -dc '0-9')
last=$(cat /var/lib/traced/last-backup-ok 2>/dev/null || echo 0)
age=$(( ( $(date +%s) - last ) / 3600 ))
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
m() { printf '{"namespace":"traced","compartmentId":"%s","name":"%s","dimensions":{"host":"traced-app-1"},"datapoints":[{"timestamp":"%s","value":%s}]}' "$CMP" "$1" "$ts" "$2"; }
oci monitoring metric-data post --endpoint "https://telemetry-ingestion.$REGION.oraclecloud.com" \
  --metric-data "[$(m api_health $api),$(m containers_up $up),$(m disk_used_pct $disk),$(m backup_age_hours $age)]" >/dev/null \
  && logger -t traced-health "api=$api containers=$up disk=$disk% backup_age=${age}h" \
  || logger -t traced-health "metric post FAILED"
echo "api_health=$api containers_up=$up disk_used_pct=$disk backup_age_hours=$age"
EOF
chmod 700 /usr/local/sbin/traced-health
printf '[Unit]\nDescription=TRACED health metrics\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/traced-health\n' > /etc/systemd/system/traced-health.service
printf '[Unit]\nDescription=TRACED health metrics every 5 minutes\n[Timer]\nOnCalendar=*:0/5\nPersistent=true\n[Install]\nWantedBy=timers.target\n' > /etc/systemd/system/traced-health.timer
systemctl daemon-reload
systemctl enable --now traced-health.timer
/usr/local/sbin/traced-health
grep -c 'last-backup-ok' /usr/local/sbin/traced-backup | sed 's/^/backup script marks success: /'
