#!/bin/bash
# TRACED VM: read-only. Lists which client IPs the API counted for restricted-pilot password attempts
# (rate_limits keys pilot:ip:<ip>) on the preview DB. Used to prove a client-sent X-Forwarded-For cannot
# choose the IP the API records (security regression for the Vercel header forwarding).
set -euo pipefail
. /etc/traced/api.conf
[ "$MODE" = preview ] || { echo "refusing: not preview"; exit 1; }
docker exec traced-postgres psql -U postgres -d traced_preview -At -F ' | ' -c \
  "select key, count, to_char(window_start at time zone 'Asia/Riyadh','HH24:MI:SS') from rate_limits where key like 'pilot:ip:%' order by window_start desc limit 10"
