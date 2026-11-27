#!/bin/bash
# TRACED VM: run the audit checkpoint + upload now and show timer/backup status (no secrets printed).
set -uo pipefail
. /etc/traced/api.conf
echo "== timers"; systemctl list-timers 'traced-*' --no-pager | head -8
echo "== audit checkpoint now"; /usr/local/sbin/traced-internal audit/checkpoint
echo "== checkpoint files"; ls -l /var/lib/traced/checkpoints | tail -3
echo "== upload"; /usr/local/sbin/traced-checkpoint-upload && echo "upload ok"
export OCI_CLI_AUTH=instance_principal
echo "== audit bucket objects"; oci os object list --namespace "$NS" --bucket-name traced-audit-checkpoints --query 'data[].{name:name,size:size}' --output table 2>&1 | tail -5
echo "== overwrite attempt (must fail)"
f=$(ls /var/lib/traced/checkpoints/checkpoint-*.json | head -1); b=$(basename "$f")
oci os object put --namespace "$NS" --bucket-name traced-audit-checkpoints --name "$b" --file "$f" --force >/dev/null 2>&1 && echo "OVERWRITE SUCCEEDED (unexpected)" || echo "overwrite refused"
echo "== delete attempt (must fail)"
oci os object delete --namespace "$NS" --bucket-name traced-audit-checkpoints --name "$b" --force >/dev/null 2>&1 && echo "DELETE SUCCEEDED (unexpected)" || echo "delete refused"
echo "== last backup"; journalctl -t traced-backup --no-pager -n 2 2>/dev/null | tail -2
echo "== outbox job log"; journalctl -u traced-outbox.service --no-pager -n 2 2>/dev/null | tail -2
