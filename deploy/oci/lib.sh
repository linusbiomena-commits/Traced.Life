#!/usr/bin/env bash
# Shared helpers for the TRACED Oracle Cloud admin scripts (run from Git Bash on the admin PC).
# Auth: a browser session token (`oci session authenticate --region me-riyadh-1 --profile-name TRACED`),
# refreshed with `oci session refresh --profile TRACED`. No API keys. Nothing here prints secrets.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OCI_EXE="${OCI_EXE:-$HOME/oci-cli-venv/Scripts/oci.exe}"
oci_() { "$OCI_EXE" --profile "${OCI_PROFILE:-TRACED}" --auth security_token "$@"; }
# Windows oci.exe cannot read Git Bash /tmp paths: keep work files in deploy/oci/.work (gitignored).
WORK="$HERE/.work"; mkdir -p "$WORK"
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
TEN=$(grep -A8 "^\[${OCI_PROFILE:-TRACED}\]" ~/.oci/config | grep '^tenancy' | cut -d= -f2 | tr -d ' ')
CMP=$(oci_ iam compartment list --compartment-id "$TEN" --name TRACED --query 'data[0].id' --raw-output)
vault_id() { oci_ kms management vault list --compartment-id "$CMP" --all --query "data[?\"display-name\"=='traced-vault' && \"lifecycle-state\"=='ACTIVE'].id | [0]" --raw-output; }
os_ns() { oci_ os ns get --query data --raw-output; }
