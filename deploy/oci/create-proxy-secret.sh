#!/usr/bin/env bash
# Generates TRUSTED_PROXY_SECRET (32 random bytes, base64url) straight into OCI Vault as traced-proxy-secret.
# Never printed. The owner copies it from the Vault into Vercel env TRACED_PROXY_SECRET (Preview).
source "$(dirname "$0")/lib.sh"
VAULT=$(vault_id)
EP=$(oci_ kms management vault get --vault-id "$VAULT" --query 'data."management-endpoint"' --raw-output)
KEY=$(oci_ kms management key list --compartment-id "$CMP" --endpoint "$EP" --all --query "data[?\"display-name\"=='traced-master-key'].id | [0]" --raw-output)
if [ -n "$(oci_ vault secret list --compartment-id "$CMP" --name traced-proxy-secret --query 'data[?"lifecycle-state"==`ACTIVE`].id | [0]' --raw-output 2>/dev/null | grep -v null)" ]; then
  echo "traced-proxy-secret already exists"; exit 0; fi
B=$(node -e "process.stdout.write(Buffer.from(require('crypto').randomBytes(32).toString('base64url')).toString('base64'))")
oci_ vault secret create-base64 --compartment-id "$CMP" --vault-id "$VAULT" --key-id "$KEY" --secret-name traced-proxy-secret \
  --description "TRUSTED_PROXY_SECRET: Vercel middleware sends it as x-traced-proxy-auth; same value in Vercel env TRACED_PROXY_SECRET" \
  --secret-content-content "$B" --secret-content-name v1 --wait-for-state ACTIVE --query 'data."secret-name"' --raw-output | tail -1
unset B
