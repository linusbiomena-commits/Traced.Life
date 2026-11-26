-- Phase 3: tracking IDs, customer QR tokens, email outbox, staff branch assignments,
-- plus the approved Phase 2 decisions (adult account holders, protected patient corrections).
-- Additive only; existing rows stay valid. Phase 2 registrations without a tracking ID are
-- backfilled by `npm run backfill:phase3` (see docs/phase-3-report.md, migration strategy).

-- ---- Account holders must be adults (confirmed at sign-up) ---------------------------------
ALTER TABLE users ADD COLUMN adult_confirmed_at timestamptz;

-- ---- Registrations are never deleted (IDs are never reused) --------------------------------
CREATE TRIGGER registrations_no_delete BEFORE DELETE ON registrations
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- The stored tracking ID must be exactly the formatted (period, sequence) pair.
ALTER TABLE registrations ADD CONSTRAINT registrations_tracking_id_matches_parts CHECK (
  tracking_id IS NULL OR tracking_id =
    'TRC-SA-' || substr(tracking_period, 3, 2) || '/' || substr(tracking_period, 1, 2) || '-' || lpad(tracking_seq::text, 5, '0'));

-- ---- Patient corrections: previous values kept, encrypted, append-only ----------------------
CREATE TABLE patient_revisions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id      uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  registration_id uuid REFERENCES registrations (id) ON DELETE RESTRICT,
  changed_fields  text[] NOT NULL CHECK (cardinality(changed_fields) > 0),
  previous_enc    text NOT NULL,          -- AES-256-GCM JSON of the values before the change
  changed_by      uuid REFERENCES users (id) ON DELETE RESTRICT,
  actor_role      text,
  reason          text CHECK (reason IS NULL OR length(reason) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patient_revisions_patient_idx ON patient_revisions (patient_id, id);
CREATE TRIGGER patient_revisions_no_update BEFORE UPDATE OR DELETE ON patient_revisions
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER patient_revisions_no_truncate BEFORE TRUNCATE ON patient_revisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();

-- ---- Tracking IDs: TRC-SA-MM/YY-XXXXX, monthly sequence in Asia/Riyadh time ------------------
CREATE TABLE tracking_sequences (
  period     char(4) PRIMARY KEY CHECK (period ~ '^[0-9]{2}(0[1-9]|1[0-2])$'),   -- YYMM
  last_value integer NOT NULL CHECK (last_value BETWEEN 0 AND 99999),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Allocates the next number for the Riyadh calendar month containing `at`. The row lock taken
-- by the upsert serialises concurrent callers until their transaction ends, so two
-- registrations can never receive the same number; if the calling transaction rolls back,
-- the increment rolls back too (the number was never issued). Past 99,999 it raises TRX01
-- and changes nothing.
CREATE FUNCTION allocate_tracking_id(at timestamptz DEFAULT now(),
                                     OUT period char(4), OUT seq integer, OUT tracking_id text)
LANGUAGE plpgsql AS $$
DECLARE
  p char(4) := to_char(at AT TIME ZONE 'Asia/Riyadh', 'YYMM');
BEGIN
  BEGIN
    INSERT INTO tracking_sequences AS t (period, last_value) VALUES (p, 1)
    ON CONFLICT (period) DO UPDATE SET last_value = t.last_value + 1, updated_at = now()
    RETURNING t.last_value INTO seq;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'TRACKING_SEQUENCE_EXHAUSTED: monthly limit of 99999 reached for %', p USING ERRCODE = 'TRX01';
  END;
  period := p;
  tracking_id := 'TRC-SA-' || substr(p, 3, 2) || '/' || substr(p, 1, 2) || '-' || lpad(seq::text, 5, '0');
END;
$$;

-- ---- Customer QR tokens (separate from future physical-sample QR tokens) -------------------
CREATE TABLE customer_qr_tokens (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id   uuid NOT NULL REFERENCES registrations (id) ON DELETE RESTRICT,
  token_hmac        bytea NOT NULL UNIQUE,  -- keyed hash used for validation lookups
  token_enc         text NOT NULL,          -- AES-256-GCM, only to redisplay/download the same QR
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
  revoked_at        timestamptz,
  revoked_by        uuid REFERENCES users (id) ON DELETE RESTRICT,
  revoke_reason     text CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 200),
  last_validated_at timestamptz,
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE UNIQUE INDEX customer_qr_tokens_one_active ON customer_qr_tokens (registration_id) WHERE status = 'active';

CREATE FUNCTION customer_qr_tokens_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.token_hmac IS DISTINCT FROM OLD.token_hmac OR NEW.token_enc IS DISTINCT FROM OLD.token_enc
     OR NEW.registration_id IS DISTINCT FROM OLD.registration_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'QR token identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'a revoked QR token cannot be reactivated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER customer_qr_tokens_guard BEFORE UPDATE ON customer_qr_tokens
  FOR EACH ROW EXECUTE FUNCTION customer_qr_tokens_guard();
CREATE TRIGGER customer_qr_tokens_no_delete BEFORE DELETE ON customer_qr_tokens
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---- Staff ↔ branch assignments (managed in the admin portal, Phase 5) ---------------------
CREATE TABLE staff_branch_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  branch_id   uuid NOT NULL REFERENCES collection_branches (id) ON DELETE RESTRICT,
  assigned_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);
CREATE UNIQUE INDEX staff_branch_assignments_active ON staff_branch_assignments (user_id, branch_id) WHERE revoked_at IS NULL;

-- ---- Transactional email outbox ------------------------------------------------------------
CREATE TABLE email_outbox (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                text NOT NULL CHECK (kind IN ('verify_email', 'account_exists', 'reset_password', 'password_changed',
                                                    'account_setup', 'registration_confirmation', 'registration_qr_resend')),
  locale              text NOT NULL CHECK (locale IN ('en', 'ar')),
  to_email            text NOT NULL CHECK (length(to_email) BETWEEN 3 AND 254),
  user_id             uuid REFERENCES users (id) ON DELETE RESTRICT,
  registration_id     uuid REFERENCES registrations (id) ON DELETE RESTRICT,
  payload_enc         text,                  -- encrypted template data (one-time links); cleared after sending
  dedupe_key          text UNIQUE,           -- prevents duplicate automatic emails
  status              text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempts            integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts        integer NOT NULL DEFAULT 6 CHECK (max_attempts > 0),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  locked_until        timestamptz,
  last_error          text CHECK (last_error IS NULL OR length(last_error) <= 500),
  provider            text,
  provider_message_id text,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_outbox_due_idx ON email_outbox (next_attempt_at) WHERE status IN ('queued', 'sending');
CREATE INDEX email_outbox_registration_idx ON email_outbox (registration_id, created_at DESC);
CREATE TRIGGER email_outbox_set_updated_at BEFORE UPDATE ON email_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
