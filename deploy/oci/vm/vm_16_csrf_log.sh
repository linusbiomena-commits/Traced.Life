#!/bin/bash
# TRACED VM: show recent CSRF rejections (shapes only; the log never contains cookie values or tokens).
docker logs --since "${1:-30m}" traced-api 2>&1 | grep '"csrf rejected"' | tail -5
echo "sessions for the preview super admin:"
docker exec traced-postgres psql -U postgres -d traced_preview -At -F ' | ' -c "select to_char(created_at at time zone 'Asia/Riyadh','HH24:MI:SS'), revoked_at is not null, expires_at > now() from sessions where user_id='68e1a2d9-b85a-4a97-bf97-03253827639d' order by created_at desc limit 4"
