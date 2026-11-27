#!/bin/bash
# TRACED VM: read-only status (bootstrap, OS, Docker, listeners, firewall, updates).
echo "bootstrap: $(test -f /var/lib/cloud/instance/traced-bootstrap-done && echo done || echo pending)"
cloud-init status 2>/dev/null | head -2
. /etc/os-release; echo "os: $PRETTY_NAME $(uname -m) kernel $(uname -r)"
echo "docker: $(docker --version 2>/dev/null || echo missing); compose: $(docker compose version 2>/dev/null || echo missing)"
echo "oci cli: $(/usr/local/bin/oci --version 2>/dev/null || echo missing)"
echo "timezone: $(timedatectl show -p Timezone --value 2>/dev/null)"
echo "listening TCP sockets:"; ss -ltnH | awk '{print "  " $4}' | sort -u
echo "ssh password auth: $(sshd -T 2>/dev/null | awk '/^passwordauthentication/{print $2}')"
echo "authorized ssh keys: $(cat /home/*/.ssh/authorized_keys /root/.ssh/authorized_keys 2>/dev/null | grep -c . || true)"
echo "unattended-upgrades: $(systemctl is-enabled unattended-upgrades 2>/dev/null)"
free -m | awk 'NR<=2'; df -h / | tail -1
