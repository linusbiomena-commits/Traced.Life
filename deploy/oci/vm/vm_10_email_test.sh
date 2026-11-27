#!/bin/bash
# TRACED VM: transactional email test against the RESTRICTED PREVIEW (database traced_preview only).
# Recipients are Resend's test inboxes (delivered@ / bounced@resend.dev, which never reach a person) plus
# ONE owner-authorised real mailbox (argument 1, e.g. info@tracedmena.life) for the sender/reply-to/DMARC check.
# Requests go straight to the API container (inside the server); passwords are random and never printed.
# Usage (root): vm_10_email_test.sh <owner-mailbox>
set -euo pipefail
OWNER="$1"
[[ "$OWNER" =~ ^[^@[:space:]]+@[^@[:space:]]+$ ]] || { echo "invalid owner mailbox"; exit 2; }
. /etc/traced/api.conf
[ "$MODE" = preview ] || { echo "refusing: API is not in preview mode"; exit 1; }
api() { docker run --rm --network traced-edge -e P="$2" "traced-api:$REF" node -e '
  const [path, body] = [process.argv[1], process.env.P];
  fetch("http://traced-api:8080/api/v1" + path, { method: "POST", headers: { "content-type": "application/json" }, body })
    .then(async (r) => console.log(path, r.status, (await r.text()).slice(0, 120)));' "$1"; }
pw() { printf '%sAa1!' "$(head -c 24 /dev/urandom | base64 -w0 | tr -d '/+=')"; }

echo "== customer sign-up (verification email)"
for to in delivered+signup@resend.dev bounced+signup@resend.dev "$OWNER"; do
  api /auth/sign-up "{\"email\":\"$to\",\"password\":\"$(pw)\",\"locale\":\"en\",\"confirmAdult\":true}"
done
echo "== Arabic sign-up"
api /auth/sign-up "{\"email\":\"delivered+signup-ar@resend.dev\",\"password\":\"$(pw)\",\"locale\":\"ar\",\"confirmAdult\":true}"
echo "== password reset"
api /auth/password/forgot '{"email":"delivered+signup@resend.dev"}'
echo "== password reset for an unknown address (must not reveal anything)"
api /auth/password/forgot '{"email":"delivered+nobody@resend.dev"}'

echo "== staff-side invitations (account setup links)"
for spec in "delivered+collection@resend.dev collection_staff" "delivered+lab@resend.dev lab_operator" "delivered+admin@resend.dev super_admin" "delivered+auditor@resend.dev auditor"; do
  set -- $spec
  if docker exec traced-postgres psql -U postgres -d traced_preview -Atc "select 1 from users where email='$1'" | grep -q 1; then echo "exists: $2"; continue; fi
  docker run --rm --network traced-db --env-file /run/traced/api.env "traced-api:$REF" \
    node --import tsx server/src/cli/create-user.ts --email "$1" --role "$2" --locale en 2>&1 | tail -1
done

echo "== run the outbox now (the in-process worker also runs)"
/usr/local/sbin/traced-internal outbox/run || true
sleep 8
/usr/local/sbin/traced-internal outbox/run || true
echo "== email_outbox (traced_preview)"
docker exec traced-postgres psql -U postgres -d traced_preview -At -F ' | ' -c "
  select kind, locale, regexp_replace(to_email, '^[^@]{3}', '***'), status, attempts, provider,
         provider_message_id is not null as has_provider_id, payload_enc is null as payload_cleared,
         coalesce(left(last_error, 80), '') from email_outbox order by created_at"
