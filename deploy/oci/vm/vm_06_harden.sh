#!/bin/bash
# TRACED VM: disable services that are not used (management is through OCI Run Command only).
set -euo pipefail
for u in rpcbind.socket rpcbind.service ssh.socket ssh.service; do systemctl disable --now "$u" >/dev/null 2>&1 || true; done
echo "ssh: $(systemctl is-active ssh 2>/dev/null || true), rpcbind: $(systemctl is-active rpcbind 2>/dev/null || true)"
echo "listening TCP:"; ss -ltnH | awk '{print "  " $4}' | sort -u
