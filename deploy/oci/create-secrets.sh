#!/usr/bin/env bash
# Already applied on 27 Nov 2026 (kept as the record; re-running creates duplicates for the network).
# Generates TRACED secrets locally and stores them in OCI Vault. Values are never printed or written to disk.
source "$(dirname "$0")/lib.sh"
VAULT=$(oci_ kms management vault list --compartment-id "$CMP" --all --query "data[?\"display-name\"=='traced-vault'].id | [0]" --raw-output)
EP=$(oci_ kms management vault get --vault-id "$VAULT" --query 'data."management-endpoint"' --raw-output)
KEY=$(oci_ kms management key list --compartment-id "$CMP" --endpoint "$EP" --all --query "data[?\"display-name\"=='traced-master-key'].id | [0]" --raw-output)

gen() { # $1 = kind: b64key | password
  if [ "$1" = b64key ]; then node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))"
  else node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"; fi
}
existing=$(oci_ vault secret list --compartment-id "$CMP" --all --query 'data[?"lifecycle-state"!=`DELETED` && "lifecycle-state"!=`PENDING_DELETION`]."secret-name"' --raw-output 2>/dev/null || echo '[]')
mk() { # name kind description
  if echo "$existing" | grep -q "\"$1\""; then echo "exists: $1"; return; fi
  local v; v=$(gen "$2")
  local b; b=$(printf '%s' "$v" | base64 -w0)
  oci_ vault secret create-base64 --compartment-id "$CMP" --vault-id "$VAULT" --key-id "$KEY" \
    --secret-name "$1" --description "$3" --secret-content-content "$b" --secret-content-name v1 \
    --wait-for-state ACTIVE --query 'data."secret-name"' --raw-output | tail -1
  unset v b
}
mk traced-pg-superuser-password password "PostgreSQL superuser (postgres) on the TRACED VM: break-glass administration only"
mk traced-db-migrator-password  password "traced_migrator: owns the traced database, runs migrations and production-roles.sql"
mk traced-db-app-password       password "traced_app: runtime role used by the API"
mk traced-db-readonly-password  password "traced_readonly: support/reporting role"
mk traced-token-hmac-key        b64key   "TOKEN_HMAC_KEY (32 bytes, base64). Rotating invalidates sessions, links and QR lookups"
mk traced-data-encryption-key   b64key   "DATA_ENCRYPTION_KEY (AES-256-GCM, 32 bytes, base64). Never delete old versions while backups made with them exist"
mk traced-audit-checkpoint-key  password "AUDIT_CHECKPOINT_KEY (HMAC for signed audit checkpoints). Keep all versions"
mk traced-internal-cron-secret  password "INTERNAL_CRON_SECRET for local scheduled jobs on the VM"
mk traced-backup-passphrase     password "Passphrase for client-side encryption of database backups. Keep all versions"
