#!/bin/bash
# TRACED VM: print the newest captured link (verification, invitation, reset...) for ONE synthetic preview
# address. Read-only. Captured mail exists only on the restricted preview (MAIL_CAPTURE_DOMAINS); nothing is sent.
# QR emails: prints the customer QR link (/traced/c/#c1_...) used for manual entry on the staff scan page.
# Usage (root): vm_18_captured_link.sh <address@preview.tracedmena.test>
set -euo pipefail
TO="$1"; . /etc/traced/api.conf
[ "$MODE" = preview ] || { echo "refusing: not preview"; exit 1; }
case "$TO" in *@preview.tracedmena.test) ;; *) echo "refusing: synthetic preview addresses only"; exit 2;; esac
f=$(grep -l "^To: $TO\$" /var/lib/traced/devmail/*.txt 2>/dev/null | xargs -r ls -t | head -1 || true)
[ -n "$f" ] || { echo "no captured mail for $TO"; exit 0; }
echo "file: $(basename "$f")"
grep -oE 'https://[^ ]*#(token=[A-Za-z0-9_-]+|c1_[A-Za-z0-9_-]{43})' "$f" | head -1
