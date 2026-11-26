-- Phase 7: audit integrity. Additive only (0001–0009 are unchanged).
--
-- The hash chain in audit_logs (0002) detects edits to rows that are still present, but someone
-- with database-owner access could rewrite the whole chain, cut rows off its end, or disable the
-- triggers. Checkpoints close that gap: each one records the chain head and a digest of all
-- custody events, signed with an HMAC key that lives outside the database (Secret Manager), and a
-- copy is written to an external sink (a local folder in development; a GCS bucket with a
-- retention lock in production). Verification recomputes everything and compares.

-- Verify a slice of the chain, anchored on the stored hash of the row before it.
-- Returns the chain_seq of the first broken link, or NULL if the slice verifies.
CREATE FUNCTION audit_verify_chain_range(from_seq bigint, to_seq bigint) RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_logs%ROWTYPE;
  expected_prev bytea;
  expected_seq bigint := from_seq;
BEGIN
  IF from_seq < 1 OR to_seq < from_seq THEN
    RAISE EXCEPTION 'invalid range % to %', from_seq, to_seq;
  END IF;
  IF from_seq > 1 THEN
    SELECT hash INTO expected_prev FROM audit_logs WHERE chain_seq = from_seq - 1;
    IF NOT FOUND THEN RETURN from_seq - 1; END IF;
  END IF;
  FOR r IN SELECT * FROM audit_logs WHERE chain_seq BETWEEN from_seq AND to_seq ORDER BY chain_seq LOOP
    IF r.chain_seq <> expected_seq
       OR r.prev_hash IS DISTINCT FROM expected_prev
       OR r.hash <> sha256(COALESCE(expected_prev, '\x'::bytea) || audit_row_digest_input(r)) THEN
      RETURN expected_seq;
    END IF;
    expected_prev := r.hash;
    expected_seq := expected_seq + 1;
  END LOOP;
  IF expected_seq <= to_seq THEN RETURN expected_seq; END IF; -- rows missing at the end
  RETURN NULL;
END;
$$;

-- Deterministic digest of custody events up to and including an id. Each row is serialised as
-- jsonb text with explicit UTC timestamps (independent of the session time zone), NULLs kept.
CREATE FUNCTION custody_events_digest(upto_id bigint)
RETURNS TABLE (event_count bigint, digest bytea) LANGUAGE sql STABLE AS $$
  SELECT count(*)::bigint,
         sha256(convert_to(COALESCE(string_agg(jsonb_build_object(
           'id', id, 'sample_id', sample_id, 'registration_id', registration_id, 'event_type', event_type,
           'from_status', from_status, 'to_status', to_status,
           'occurred_at', to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
           'recorded_by', recorded_by, 'actor_role', actor_role, 'location_type', location_type, 'branch_id', branch_id,
           'identified_by', identified_by, 'handover', handover, 'condition', condition, 'reason_category', reason_category,
           'remarks', remarks, 'corrects_event_id', corrects_event_id, 'idempotency_key', idempotency_key, 'request_id', request_id
         )::text, E'\n' ORDER BY id), ''), 'UTF8'))
    FROM custody_events WHERE id <= upto_id;
$$;

CREATE TABLE audit_checkpoints (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,                                   -- NULL = scheduler; no FK (evidence must not change)
  trigger         text NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  audit_last_seq  bigint NOT NULL CHECK (audit_last_seq >= 0),
  audit_last_hash bytea,                                  -- NULL only when the log was empty
  custody_last_id bigint NOT NULL CHECK (custody_last_id >= 0),
  custody_count   bigint NOT NULL CHECK (custody_count >= 0),
  custody_digest  bytea NOT NULL,
  key_id          text NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),  -- fingerprint of the HMAC key, never the key
  signature       bytea NOT NULL,
  sink            text NOT NULL CHECK (sink IN ('none', 'file', 'gcs')),
  sink_ref        text CHECK (sink_ref IS NULL OR length(sink_ref) <= 300),
  CHECK ((audit_last_seq = 0) = (audit_last_hash IS NULL))
);
CREATE INDEX audit_checkpoints_created_idx ON audit_checkpoints (created_at DESC);
CREATE TRIGGER audit_checkpoints_no_update BEFORE UPDATE OR DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER audit_checkpoints_no_truncate BEFORE TRUNCATE ON audit_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();

CREATE TABLE audit_verifications (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_at              timestamptz NOT NULL DEFAULT now(),
  run_by              uuid,                               -- NULL = scheduler
  trigger             text NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
  outcome             text NOT NULL CHECK (outcome IN ('ok', 'failed')),
  chain_rows          bigint NOT NULL,
  first_broken_seq    bigint,
  checkpoints_checked integer NOT NULL,
  findings            jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(findings) = 'array'),
  duration_ms         integer NOT NULL
);
CREATE INDEX audit_verifications_run_idx ON audit_verifications (run_at DESC);
CREATE TRIGGER audit_verifications_no_update BEFORE UPDATE OR DELETE ON audit_verifications
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER audit_verifications_no_truncate BEFORE TRUNCATE ON audit_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();

-- Phase 6 append-only evidence tables blocked UPDATE/DELETE but not TRUNCATE; close that.
CREATE TRIGGER sample_label_prints_no_truncate BEFORE TRUNCATE ON sample_label_prints
  FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();
CREATE TRIGGER recollection_authorizations_no_truncate BEFORE TRUNCATE ON recollection_authorizations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();
