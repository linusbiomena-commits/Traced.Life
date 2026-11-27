#!/bin/bash
# TRACED VM: confirm the instance principal can read each runtime secret. Prints only format checks, never values.
set -uo pipefail
VAULT="$1"; export OCI_CLI_AUTH=instance_principal
for s in traced-resend-api-key traced-proxy-secret traced-db-app-password traced-token-hmac-key traced-data-encryption-key traced-audit-checkpoint-key traced-internal-cron-secret; do
  v=$(oci secrets secret-bundle get-secret-bundle-by-name --vault-id "$VAULT" --secret-name "$s" --query 'data."secret-bundle-content".content' --raw-output 2>/dev/null | base64 -d 2>/dev/null)
  if [ -z "$v" ]; then echo "$s: NOT READABLE"; continue; fi
  fmt=ok
  case "$s" in traced-resend-api-key) [[ "$v" =~ ^re_[A-Za-z0-9_]+$ ]] || fmt="unexpected format (expected re_...)";; esac
  [[ "$v" == *$'\n'* || "$v" == *" "* ]] && fmt="contains whitespace/newline"
  echo "$s: readable, length ${#v}, format $fmt"
  unset v
done
