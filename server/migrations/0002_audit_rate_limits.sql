-- Phase 1: append-only, hash-chained audit log and a Postgres-backed rate limiter.

-- Shared guard for append-only tables (audit_logs now; custody events in Phase 6).
CREATE FUNCTION reject_modification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TABLE audit_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_seq       bigint NOT NULL UNIQUE,      -- order of the hash chain (assigned under lock)
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid,                        -- no FK: rows must never change if a user is removed
  actor_role      text,
  action          text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  outcome         text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  target_type     text,
  target_id       text,
  fields_accessed text[],
  ip              inet,
  user_agent      text CHECK (length(user_agent) <= 512),
  request_id      text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash       bytea,
  hash            bytea NOT NULL
);
CREATE INDEX audit_logs_actor_idx  ON audit_logs (actor_user_id, occurred_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, occurred_at DESC);
CREATE INDEX audit_logs_target_idx ON audit_logs (target_type, target_id);

-- Canonical text of a row for hashing. Shared by the insert trigger and audit_verify_chain().
CREATE FUNCTION audit_row_digest_input(r audit_logs) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT convert_to(concat_ws('|',
    r.chain_seq, to_char(r.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    r.actor_user_id, r.actor_role, r.action, r.outcome, r.target_type, r.target_id,
    r.fields_accessed::text, host(r.ip), r.user_agent, r.request_id, r.metadata::text), 'UTF8');
$$;

CREATE FUNCTION audit_logs_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_row audit_logs%ROWTYPE;
BEGIN
  -- Serialise writers so every row links to exactly one predecessor.
  PERFORM pg_advisory_xact_lock(7270001);
  SELECT * INTO last_row FROM audit_logs ORDER BY chain_seq DESC LIMIT 1;
  NEW.chain_seq := COALESCE(last_row.chain_seq, 0) + 1;
  NEW.prev_hash := last_row.hash;
  NEW.hash := sha256(COALESCE(last_row.hash, '\x'::bytea) || audit_row_digest_input(NEW));
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_logs_chain BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_chain();
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();

-- Returns the chain_seq of the first broken link, or NULL if the whole chain verifies.
CREATE FUNCTION audit_verify_chain() RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_logs%ROWTYPE;
  expected_prev bytea := NULL;
  expected_seq bigint := 1;
BEGIN
  FOR r IN SELECT * FROM audit_logs ORDER BY chain_seq LOOP
    IF r.chain_seq <> expected_seq
       OR r.prev_hash IS DISTINCT FROM expected_prev
       OR r.hash <> sha256(COALESCE(expected_prev, '\x'::bytea) || audit_row_digest_input(r)) THEN
      RETURN r.chain_seq;
    END IF;
    expected_prev := r.hash;
    expected_seq := expected_seq + 1;
  END LOOP;
  RETURN NULL;
END;
$$;

-- Fixed-window counters. Keys never contain raw personal data (emails are HMAC'd).
CREATE TABLE rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_limits_window_idx ON rate_limits (window_start);
