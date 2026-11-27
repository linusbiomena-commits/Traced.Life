#!/bin/bash
# TRACED VM step 7 (PREPARED, NOT RUN): API container + Caddy (HTTPS) + scheduled jobs + checkpoint upload.
# Needs, before running: owner approval for public API exposure, the API host name (DNS A record to the
# reserved public IP), Vault secrets traced-resend-api-key and traced-proxy-secret, and an NSG rule for 443.
#
# Usage (root): vm_07_api_install.sh <vault-ocid> <namespace> <git-commit> <api-host> <app-origin> <from-name> <from-address> <reply-to> [mode]
#   mode = preview (default): RESTRICTED PREVIEW with synthetic data only. Database traced_preview,
#          NODE_ENV=development so provisional consents/instructions and the development identity
#          verification work for end-to-end testing. Never use it with real people's data.
#   mode = production: database traced, NODE_ENV=production (approved consents/instructions only,
#          development identity verification refused). Only after the release gate.
#   e.g. ... <commit> api.tracedmena.life https://<preview-host> TRACED info@tracedmena.life info@tracedmena.life preview
# Caddy forwards /api/v1/* ONLY when the request carries x-traced-proxy-auth = traced-proxy-secret (i.e. it came
# through the Vercel middleware); everything else under /api/v1 gets 403, except /api/v1/health.
#
# Result:
#   traced-api      node container, NODE_ENV=production, listens on the internal network only (no host port)
#   traced-caddy    the ONLY published ports (80 for the ACME challenge/redirect, 443); routes /api/v1/* except
#                   /api/v1/internal/*, adds HSTS; automatic Let's Encrypt certificate for <api-host>
#   timers          outbox every 5 min, audit checkpoint daily 02:30 Riyadh, checkpoint upload every 15 min
# Secrets are fetched from Vault at each start into /run/traced/api.env (tmpfs, 0600) and are never on disk.
set -euo pipefail
VAULT="$1"; NS="$2"; REF="$3"; API_HOST="$4"; APP_ORIGIN="$5"; FROM_NAME="$6"; FROM_ADDR="$7"; REPLY_TO="$8"; MODE="${9:-preview}"
for a in "$FROM_ADDR" "$REPLY_TO"; do [[ "$a" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] || { echo "invalid address $a"; exit 2; }; done
[[ "$FROM_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "from-name must be one word"; exit 2; }
MAIL_FROM="$FROM_NAME <$FROM_ADDR>"
case "$MODE" in preview) DB=traced_preview; NODE_ENV=development; DEVIDV=true;; production) DB=traced; NODE_ENV=production; DEVIDV=false;; *) echo "mode must be preview or production"; exit 2;; esac
docker exec traced-postgres psql -U postgres -Atc "select 1 from pg_database where datname='$DB'" | grep -q 1 || { echo "database $DB missing: run vm_02_migrate.sh <vault> <commit> $DB"; exit 1; }
docker image inspect "traced-api:$REF" >/dev/null || { echo "image traced-api:$REF missing: run vm_02_migrate.sh first"; exit 1; }
install -d -m 700 /etc/traced
install -d -m 750 -o 1000 -g 1000 /var/lib/traced/checkpoints   # uid 1000 = "node" in the image
install -d -m 700 /var/lib/traced/caddy

cat > /etc/traced/api.conf <<EOF
VAULT=$VAULT
NS=$NS
REF=$REF
API_HOST=$API_HOST
APP_ORIGIN=$APP_ORIGIN
MAIL_FROM='$MAIL_FROM'
MAIL_REPLY_TO=$REPLY_TO
MODE=$MODE
DB=$DB
NODE_ENV=$NODE_ENV
DEVIDV=$DEVIDV
EOF
chmod 600 /etc/traced/api.conf

cat > /usr/local/sbin/traced-api-env <<'EOF'
#!/bin/bash
# Builds /run/traced/api.env from Vault (instance principal). Called by traced-api.service before start.
set -euo pipefail
. /etc/traced/api.conf
export OCI_CLI_AUTH=instance_principal
sec() { oci secrets secret-bundle get-secret-bundle-by-name --vault-id "$VAULT" --secret-name "$1" \
          --query 'data."secret-bundle-content".content' --raw-output | base64 -d; }
install -d -m 700 /run/traced
umask 077
{
  echo "NODE_ENV=$NODE_ENV"
  echo "HOST=0.0.0.0"
  echo "PORT=8080"
  echo "DATABASE_URL=postgres://traced_app:$(sec traced-db-app-password)@traced-postgres:5432/$DB"
  echo "DB_POOL_MAX=10"
  echo "APP_ORIGIN=$APP_ORIGIN"
  echo "COOKIE_SECURE=true"
  echo "TOKEN_HMAC_KEY=$(sec traced-token-hmac-key)"
  echo "DATA_ENCRYPTION_KEY=$(sec traced-data-encryption-key)"
  echo "AUDIT_CHECKPOINT_KEY=$(sec traced-audit-checkpoint-key)"
  echo "AUDIT_CHECKPOINT_DIR=/var/lib/traced/checkpoints"
  echo "INTERNAL_CRON_SECRET=$(sec traced-internal-cron-secret)"
  echo "MAIL_TRANSPORT=resend"
  echo "MAIL_FROM=$MAIL_FROM"
  echo "MAIL_REPLY_TO=$MAIL_REPLY_TO"
  echo "RESEND_API_KEY=$(sec traced-resend-api-key)"
  echo "CUSTOMER_STATUS_EMAILS=false"
  echo "DEV_IDENTITY_VERIFICATION=$DEVIDV"
  echo "TRACED_DEPLOYMENT_MODE=$MODE"
  echo "AUTO_MIGRATE=false"   # migrations run separately as traced_migrator (vm_02)
  # Chain: browser -> Vercel (adds x-traced-proxy-auth) -> Caddy -> API. Two proxy hops.
  echo "TRUSTED_PROXY_HOPS=2"
  echo "TRUSTED_PROXY_SECRET=$(sec traced-proxy-secret)"
} > /run/traced/api.env.tmp
mv /run/traced/api.env.tmp /run/traced/api.env
# Caddy only needs the proxy secret (gate for /api/v1/*).
echo "TRACED_PROXY_SECRET=$(sec traced-proxy-secret)" > /run/traced/caddy.env.tmp && mv /run/traced/caddy.env.tmp /run/traced/caddy.env
EOF
chmod 700 /usr/local/sbin/traced-api-env

cat > /etc/traced/Caddyfile <<EOF
{
  admin off
  # Keep the incoming X-Forwarded-For (from Vercel) and append the peer; the API decides whom to trust
  # (TRUSTED_PROXY_HOPS=2 only when x-traced-proxy-auth matches, else 1 hop = the address Caddy saw).
  servers {
    trusted_proxies static 0.0.0.0/0 ::/0
  }
}
$API_HOST {
  encode gzip
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options nosniff
    Referrer-Policy no-referrer
    X-Frame-Options DENY
    -Server
  }
  route {
    respond /api/v1/internal/* 404
    reverse_proxy /api/v1/health traced-api:8080
    @proxied {
      path /api/v1/*
      header X-Traced-Proxy-Auth "{\$TRACED_PROXY_SECRET}"
    }
    reverse_proxy @proxied traced-api:8080
    respond /api/v1/* "Forbidden" 403
    respond 404
  }
}
EOF

cat > /etc/systemd/system/traced-api.service <<'EOF'
[Unit]
Description=TRACED API and Caddy reverse proxy (mode in /etc/traced/api.conf)
After=docker.service network-online.target
Requires=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=/etc/traced/api.conf
ExecStartPre=/usr/local/sbin/traced-api-env
ExecStartPre=-/usr/bin/docker network create traced-edge
ExecStartPre=-/usr/bin/docker rm -f traced-api traced-caddy
ExecStart=/usr/bin/docker run -d --name traced-api --restart unless-stopped --network traced-db \
  --env-file /run/traced/api.env --read-only --tmpfs /tmp --memory 768m \
  -v /var/lib/traced/checkpoints:/var/lib/traced/checkpoints traced-api:${REF}
ExecStart=/usr/bin/docker network connect traced-edge traced-api
ExecStart=/usr/bin/docker run -d --name traced-caddy --restart unless-stopped --network traced-edge \
  -p 80:80 -p 443:443 --env-file /run/traced/caddy.env -v /etc/traced/Caddyfile:/etc/caddy/Caddyfile:ro -v /var/lib/traced/caddy:/data \
  --memory 256m caddy:2
ExecStop=/usr/bin/docker rm -f traced-caddy traced-api
[Install]
WantedBy=multi-user.target
EOF

# Scheduled jobs call the API from the VM itself (Caddy never routes /internal).
cat > /usr/local/sbin/traced-internal <<'EOF'
#!/bin/bash
set -euo pipefail
S=$(grep '^INTERNAL_CRON_SECRET=' /run/traced/api.env | cut -d= -f2-)
docker exec traced-api node -e "fetch('http://127.0.0.1:8080/api/v1/internal/$1',{method:'POST',headers:{authorization:'Bearer '+process.argv[1]}}).then(async r=>{console.log(r.status, await r.text()); process.exit(r.ok?0:1)})" "$S"
EOF
chmod 700 /usr/local/sbin/traced-internal

cat > /usr/local/sbin/traced-checkpoint-upload <<'EOF'
#!/bin/bash
# Copies new signed checkpoint files to the audit bucket. The VM may create but never overwrite or delete there.
set -euo pipefail
. /etc/traced/api.conf
export OCI_CLI_AUTH=instance_principal
for f in /var/lib/traced/checkpoints/checkpoint-*.json; do
  [ -e "$f" ] || exit 0
  b=$(basename "$f"); m=/var/lib/traced/checkpoints/.uploaded-$b
  [ -e "$m" ] && continue
  if oci os object put --namespace "$NS" --bucket-name traced-audit-checkpoints --name "$b" --file "$f" --no-overwrite >/dev/null 2>&1 \
     || oci os object head --namespace "$NS" --bucket-name traced-audit-checkpoints --name "$b" >/dev/null 2>&1; then
    touch "$m"; logger -t traced-checkpoint "uploaded $b"
  else logger -t traced-checkpoint "upload FAILED $b"; exit 1; fi
done
EOF
chmod 700 /usr/local/sbin/traced-checkpoint-upload

mk_timer() { # name, calendar, command
  printf '[Unit]\nDescription=TRACED %s\n[Service]\nType=oneshot\nExecStart=%s\n' "$1" "$3" > "/etc/systemd/system/traced-$1.service"
  printf '[Unit]\nDescription=TRACED %s timer\n[Timer]\nOnCalendar=%s\nPersistent=true\n[Install]\nWantedBy=timers.target\n' "$1" "$2" > "/etc/systemd/system/traced-$1.timer"
}
mk_timer outbox "*:0/5" "/usr/local/sbin/traced-internal outbox/run"
mk_timer audit-checkpoint "*-*-* 02:30:00 Asia/Riyadh" "/usr/local/sbin/traced-internal audit/checkpoint"
mk_timer checkpoint-upload "*:0/15" "/usr/local/sbin/traced-checkpoint-upload"

systemctl daemon-reload
systemctl enable --now traced-api.service
systemctl enable --now traced-outbox.timer traced-audit-checkpoint.timer traced-checkpoint-upload.timer
sleep 5
docker ps --format '{{.Names}} {{.Status}} {{.Ports}}'
docker exec traced-api node -e "fetch('http://127.0.0.1:8080/api/v1/health').then(async r=>console.log('health', r.status, await r.text()))"
