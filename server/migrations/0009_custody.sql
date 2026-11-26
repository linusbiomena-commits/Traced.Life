-- Phase 6: physical sample identification and chain of custody. Additive; 0001-0008 untouched.

-- ---- Physical sample identifier: TRC-SA-MM/YY-XXXXX-SXX (tracking ID + per-registration seq) --
-- Reuses samples.sample_code (Phase 4 placeholder, never populated by the application); its
-- original format check didn't allow the tracking ID's "/" and is replaced here.
ALTER TABLE samples DROP CONSTRAINT samples_sample_code_check;
ALTER TABLE samples ADD COLUMN sample_seq smallint CHECK (sample_seq BETWEEN 1 AND 99);
ALTER TABLE samples ADD COLUMN status_changed_at timestamptz NOT NULL DEFAULT now();

-- Backfill samples collected before Phase 6 (local/dev data): S01, S02… in collection order.
WITH n AS (
  SELECT s.id, r.tracking_id, row_number() OVER (PARTITION BY s.registration_id ORDER BY s.collected_at, s.id) AS seq
    FROM samples s JOIN registrations r ON r.id = s.registration_id
)
UPDATE samples s SET sample_seq = n.seq, sample_code = n.tracking_id || '-S' || lpad(n.seq::text, 2, '0'), status_changed_at = s.collected_at
  FROM n WHERE n.id = s.id;

ALTER TABLE samples ALTER COLUMN sample_seq SET NOT NULL;
ALTER TABLE samples ALTER COLUMN sample_code SET NOT NULL;
ALTER TABLE samples ADD CONSTRAINT samples_sample_code_format
  CHECK (sample_code ~ '^TRC-SA-(0[1-9]|1[0-2])/[0-9]{2}-[0-9]{5}-S[0-9]{2}$');
ALTER TABLE samples ADD CONSTRAINT samples_registration_seq_key UNIQUE (registration_id, sample_seq);
CREATE INDEX samples_status_idx ON samples (status, status_changed_at DESC);

-- Identity of a physical sample never changes once recorded.
CREATE FUNCTION samples_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sample_code IS DISTINCT FROM OLD.sample_code OR NEW.sample_seq IS DISTINCT FROM OLD.sample_seq
     OR NEW.registration_id IS DISTINCT FROM OLD.registration_id OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.collected_by IS DISTINCT FROM OLD.collected_by OR NEW.collected_at IS DISTINCT FROM OLD.collected_at
     OR NEW.collection_session_id IS DISTINCT FROM OLD.collection_session_id
     OR NEW.identity_verification_id IS DISTINCT FROM OLD.identity_verification_id
     OR NEW.instructions_id IS DISTINCT FROM OLD.instructions_id OR NEW.checklist IS DISTINCT FROM OLD.checklist THEN
    RAISE EXCEPTION 'physical sample identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER samples_guard BEFORE UPDATE ON samples FOR EACH ROW EXECUTE FUNCTION samples_guard();

-- ---- Physical sample QR tokens (separate from customer QR tokens; prefix s1_) -------------
CREATE TABLE sample_qr_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sample_id     uuid NOT NULL REFERENCES samples (id) ON DELETE RESTRICT,
  token_hmac    bytea NOT NULL UNIQUE,
  token_enc     text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES users (id) ON DELETE RESTRICT,
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users (id) ON DELETE RESTRICT,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 200),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX sample_qr_tokens_one_active ON sample_qr_tokens (sample_id) WHERE status = 'active';
CREATE FUNCTION sample_qr_tokens_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.token_hmac IS DISTINCT FROM OLD.token_hmac OR NEW.token_enc IS DISTINCT FROM OLD.token_enc
     OR NEW.sample_id IS DISTINCT FROM OLD.sample_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sample QR token identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'a revoked sample QR token cannot be reactivated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sample_qr_tokens_guard BEFORE UPDATE ON sample_qr_tokens FOR EACH ROW EXECUTE FUNCTION sample_qr_tokens_guard();
CREATE TRIGGER sample_qr_tokens_no_delete BEFORE DELETE ON sample_qr_tokens FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---- Append-only custody events ---------------------------------------------------------
-- One row per custody step. Corrections are new rows that reference the corrected event.
-- Timestamps are server-generated (now()); displayed in Asia/Riyadh.
CREATE TABLE custody_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sample_id         uuid NOT NULL REFERENCES samples (id) ON DELETE RESTRICT,
  registration_id   uuid NOT NULL REFERENCES registrations (id) ON DELETE RESTRICT,
  event_type        text NOT NULL CHECK (event_type IN ('transition', 'correction')),
  from_status       text,
  to_status         text NOT NULL CHECK (to_status IN ('collected', 'packaged', 'ready_for_dispatch', 'dispatched', 'in_transit',
                      'received_by_laboratory', 'analysis_in_progress', 'analysis_completed', 'report_available', 'rejected')),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  recorded_by       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  actor_role        text NOT NULL,
  location_type     text NOT NULL CHECK (location_type IN ('branch', 'laboratory', 'administration')),
  branch_id         uuid REFERENCES collection_branches (id) ON DELETE RESTRICT,
  identified_by     text CHECK (identified_by IN ('sample_qr', 'sample_id_entry', 'collection_session', 'admin_record')),
  handover          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(handover) = 'object'),
  condition         text CHECK (condition IN ('intact', 'damaged')),
  reason_category   text CHECK (reason_category IN ('damaged_packaging', 'missing_sample', 'unreadable_label', 'identification_mismatch', 'insufficient_sample', 'other')),
  remarks           text CHECK (remarks IS NULL OR length(remarks) <= 1000),
  corrects_event_id bigint REFERENCES custody_events (id) ON DELETE RESTRICT,
  idempotency_key   uuid,
  request_id        text,
  CHECK ((event_type = 'correction') = (corrects_event_id IS NOT NULL)),
  CHECK (event_type <> 'correction' OR remarks IS NOT NULL),
  CHECK (to_status <> 'rejected' OR reason_category IS NOT NULL OR event_type = 'correction')
);
CREATE INDEX custody_events_sample_idx ON custody_events (sample_id, id);
CREATE INDEX custody_events_registration_idx ON custody_events (registration_id, id);
CREATE INDEX custody_events_recorded_by_idx ON custody_events (recorded_by, occurred_at DESC);
CREATE UNIQUE INDEX custody_events_idempotency ON custody_events (sample_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TRIGGER custody_events_no_update BEFORE UPDATE OR DELETE ON custody_events FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER custody_events_no_truncate BEFORE TRUNCATE ON custody_events FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();

-- Initial custody event for samples collected before Phase 6.
INSERT INTO custody_events (sample_id, registration_id, event_type, from_status, to_status, occurred_at, recorded_by, actor_role, location_type, branch_id, identified_by)
SELECT s.id, s.registration_id, 'transition', NULL, 'collected', s.collected_at, s.collected_by, 'collection_staff', 'branch', s.branch_id, 'collection_session'
  FROM samples s;

-- ---- Label prints (append-only; every reprint after the first needs a reason) -----------
CREATE TABLE sample_label_prints (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sample_id   uuid NOT NULL REFERENCES samples (id) ON DELETE RESTRICT,
  printed_by  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  actor_role  text NOT NULL,
  label_size  text NOT NULL CHECK (label_size ~ '^[0-9]{2,3}x[0-9]{2,3}$'),
  reprint     boolean NOT NULL,
  reason      text CHECK (reason IS NULL OR length(reason) BETWEEN 5 AND 500),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT reprint OR reason IS NOT NULL)
);
CREATE INDEX sample_label_prints_sample_idx ON sample_label_prints (sample_id, id);
CREATE TRIGGER sample_label_prints_no_update BEFORE UPDATE OR DELETE ON sample_label_prints FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---- Recollection authorisations (admin, after a rejected sample) -----------------------
CREATE TABLE recollection_authorizations (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registration_id    uuid NOT NULL REFERENCES registrations (id) ON DELETE RESTRICT,
  rejected_sample_id uuid NOT NULL UNIQUE REFERENCES samples (id) ON DELETE RESTRICT,
  reason             text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  authorized_by      uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  actor_role         text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recollection_authorizations_reg_idx ON recollection_authorizations (registration_id, id);
CREATE TRIGGER recollection_authorizations_no_update BEFORE UPDATE OR DELETE ON recollection_authorizations FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---- Customer status emails (templates exist; sending is switched by configuration) -----
ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_kind_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_kind_check CHECK (kind IN (
  'verify_email', 'account_exists', 'reset_password', 'password_changed', 'account_setup',
  'registration_confirmation', 'registration_qr_resend', 'registration_branch_changed',
  'sample_received', 'report_available', 'recollection_required'));
