#!/bin/bash
# TRACED VM step 4: install the nightly encrypted database backup and a restore check.
# Usage (root): vm_04_backup_install.sh <vault-ocid> <object-storage-namespace>
#   /usr/local/sbin/traced-backup         pg_dump (custom format) | gpg AES-256 (passphrase from Vault)
#                                         -> traced-db-backups/db/traced-<UTC>.dump.gpg (35-day lifecycle)
#   /usr/local/sbin/traced-restore-check  newest backup -> decrypt -> pg_restore into a temporary
#                                         database on the same server -> compare row counts -> drop it
#   traced-backup.timer                   daily 01:30 Asia/Riyadh
# The primary database is never overwritten. Recovery point: up to 24 hours.
set -euo pipefail
VAULT="$1"; NS="$2"
install -d -m 700 /etc/traced
cat > /etc/traced/backup.env <<EOF
VAULT=$VAULT
NS=$NS
BUCKET=traced-db-backups
EOF
chmod 600 /etc/traced/backup.env

cat > /usr/local/sbin/traced-backup <<'EOF'
#!/bin/bash
set -euo pipefail
. /etc/traced/backup.env
export OCI_CLI_AUTH=instance_principal
STAMP=$(date -u +%Y%m%dT%H%M%SZ); OBJ="db/traced-$STAMP.dump.gpg"
TMP=$(mktemp -d /var/tmp/traced-backup.XXXX); trap 'rm -rf "$TMP"' EXIT
docker exec traced-postgres pg_dump -U postgres -d traced -Fc -Z 6 > "$TMP/db.dump"
oci secrets secret-bundle get-secret-bundle-by-name --vault-id "$VAULT" --secret-name traced-backup-passphrase \
  --query 'data."secret-bundle-content".content' --raw-output | base64 -d > "$TMP/.p"
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$TMP/.p" --symmetric --cipher-algo AES256 -o "$TMP/db.dump.gpg" "$TMP/db.dump"
shred -u "$TMP/.p"
SHA=$(sha256sum "$TMP/db.dump.gpg" | cut -d' ' -f1)
oci os object put --namespace "$NS" --bucket-name "$BUCKET" --name "$OBJ" --file "$TMP/db.dump.gpg" \
  --metadata "{\"sha256\":\"$SHA\"}" --no-overwrite >/dev/null
logger -t traced-backup "uploaded $OBJ sha256=$SHA size=$(stat -c %s "$TMP/db.dump.gpg")"
echo "uploaded $OBJ"
EOF

cat > /usr/local/sbin/traced-restore-check <<'EOF'
#!/bin/bash
set -euo pipefail
. /etc/traced/backup.env
export OCI_CLI_AUTH=instance_principal
OBJ=$(oci os object list --namespace "$NS" --bucket-name "$BUCKET" --prefix db/ --all \
        --query 'sort_by(data, &"time-created")[-1].name' --raw-output)
TMP=$(mktemp -d /var/tmp/traced-restore.XXXX)
cleanup() { docker exec traced-postgres psql -U postgres -qc "DROP DATABASE IF EXISTS traced_restore_check" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
oci os object get --namespace "$NS" --bucket-name "$BUCKET" --name "$OBJ" --file "$TMP/db.dump.gpg" >/dev/null
oci secrets secret-bundle get-secret-bundle-by-name --vault-id "$VAULT" --secret-name traced-backup-passphrase \
  --query 'data."secret-bundle-content".content' --raw-output | base64 -d > "$TMP/.p"
gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$TMP/.p" -o "$TMP/db.dump" -d "$TMP/db.dump.gpg"
shred -u "$TMP/.p"
docker exec traced-postgres psql -U postgres -qc "DROP DATABASE IF EXISTS traced_restore_check" -c "CREATE DATABASE traced_restore_check TEMPLATE template0"
docker exec -i traced-postgres pg_restore -U postgres -d traced_restore_check --no-owner --exit-on-error < "$TMP/db.dump"
COUNTS="select string_agg(relname||'='||n_live_tup_exact, ',' order by relname) from (select c.relname, (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.'||quote_ident(c.relname), false, true, '')))[1]::text::bigint as n_live_tup_exact from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r') s"
A=$(docker exec traced-postgres psql -U postgres -d traced -At -c "$COUNTS")
B=$(docker exec traced-postgres psql -U postgres -d traced_restore_check -At -c "$COUNTS")
CHAIN=$(docker exec traced-postgres psql -U postgres -d traced_restore_check -At -c "select * from audit_verify_chain()")
if [ "$A" = "$B" ]; then echo "RESTORE CHECK PASS: $OBJ, $(echo "$B" | tr ',' '\n' | wc -l) tables match; restored audit chain: $CHAIN"
else echo "RESTORE CHECK FAIL: row counts differ for $OBJ (rows may have been added since the backup)"; exit 1; fi
EOF
chmod 700 /usr/local/sbin/traced-backup /usr/local/sbin/traced-restore-check

cat > /etc/systemd/system/traced-backup.service <<'EOF'
[Unit]
Description=TRACED nightly encrypted database backup to OCI Object Storage (Riyadh)
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/traced-backup
EOF
cat > /etc/systemd/system/traced-backup.timer <<'EOF'
[Unit]
Description=Run the TRACED database backup daily at 01:30 Riyadh time
[Timer]
OnCalendar=*-*-* 01:30:00 Asia/Riyadh
Persistent=true
RandomizedDelaySec=300
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now traced-backup.timer
systemctl list-timers traced-backup.timer --no-pager | head -3
