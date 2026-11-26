-- Phase 4: sample collection by staff. Additive only; earlier migrations are untouched.
--   * customer QR codes gain a terminal 'used' state (after collection they authorise nothing)
--   * versioned, immutable collection instructions + checklist (EN/AR, provisional/approved)
--   * collection sessions: a short-lived, staff- and branch-bound context created by a valid scan
--   * identity verification events (append-only), bound to patient + registration + session
--   * samples: one live sample per registration; ready for Phase 6 labels and chain of custody

-- ---- Customer QR lifecycle: active → revoked | used (both terminal) -------------------------
ALTER TABLE customer_qr_tokens DROP CONSTRAINT customer_qr_tokens_status_check;
ALTER TABLE customer_qr_tokens ADD CONSTRAINT customer_qr_tokens_status_check CHECK (status IN ('active', 'revoked', 'used'));
ALTER TABLE customer_qr_tokens ADD COLUMN used_at timestamptz;
ALTER TABLE customer_qr_tokens ADD CONSTRAINT customer_qr_tokens_used_check CHECK ((status = 'used') = (used_at IS NOT NULL));

CREATE OR REPLACE FUNCTION customer_qr_tokens_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.token_hmac IS DISTINCT FROM OLD.token_hmac OR NEW.token_enc IS DISTINCT FROM OLD.token_enc
     OR NEW.registration_id IS DISTINCT FROM OLD.registration_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'QR token identity is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('revoked', 'used') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a % QR token cannot change state', OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- Collection instructions (configurable, versioned, immutable once published) ------------
CREATE TABLE collection_instructions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version        text NOT NULL CHECK (version ~ '^[0-9A-Za-z.\-]{1,32}$'),
  locale         text NOT NULL CHECK (locale IN ('en', 'ar')),
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  steps          jsonb NOT NULL CHECK (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) BETWEEN 1 AND 30),
  checklist      jsonb NOT NULL CHECK (jsonb_typeof(checklist) = 'array' AND jsonb_array_length(checklist) BETWEEN 1 AND 20),
  content_sha256 bytea NOT NULL,
  status         text NOT NULL CHECK (status IN ('provisional', 'approved', 'retired')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  approved_by    uuid REFERENCES users (id) ON DELETE RESTRICT,
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version, locale),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL) OR status = 'retired')
);
CREATE FUNCTION collection_instructions_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.steps IS DISTINCT FROM OLD.steps OR NEW.checklist IS DISTINCT FROM OLD.checklist OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.locale IS DISTINCT FROM OLD.locale OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 THEN
    RAISE EXCEPTION 'collection instructions are immutable; publish a new version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER collection_instructions_freeze BEFORE UPDATE ON collection_instructions
  FOR EACH ROW EXECUTE FUNCTION collection_instructions_freeze();
CREATE TRIGGER collection_instructions_no_delete BEFORE DELETE ON collection_instructions
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---- Collection sessions ---------------------------------------------------------------------
CREATE TABLE collection_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid NOT NULL REFERENCES registrations (id) ON DELETE RESTRICT,
  qr_token_id     uuid NOT NULL REFERENCES customer_qr_tokens (id) ON DELETE RESTRICT,
  staff_user_id   uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  branch_id       uuid NOT NULL REFERENCES collection_branches (id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  completed_at    timestamptz
);
CREATE INDEX collection_sessions_open_idx ON collection_sessions (registration_id, staff_user_id) WHERE completed_at IS NULL;

-- ---- Identity verification events (append-only; latest row per session is the current state) -
-- Methods: dev_simulated (local development/tests only; refused in production by the API),
-- and reserved names for future approved methods. Nothing here stores identity documents or
-- personal details; staff only ever see the resulting status.
CREATE TABLE identity_verifications (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  collection_session_id uuid NOT NULL REFERENCES collection_sessions (id) ON DELETE RESTRICT,
  registration_id       uuid NOT NULL REFERENCES registrations (id) ON DELETE RESTRICT,
  patient_id            uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  method                text NOT NULL CHECK (method IN ('dev_simulated', 'otp_customer_device', 'nafath', 'supervised_document_check')),
  status                text NOT NULL CHECK (status IN ('pending', 'verified', 'failed')),
  patient_version_at    timestamptz NOT NULL,   -- patients.updated_at when verified; a later correction invalidates it
  performed_by          uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX identity_verifications_session_idx ON identity_verifications (collection_session_id, id DESC);
CREATE TRIGGER identity_verifications_no_update BEFORE UPDATE OR DELETE ON identity_verifications
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER identity_verifications_no_truncate BEFORE TRUNCATE ON identity_verifications
  FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();

-- ---- Samples ---------------------------------------------------------------------------------
-- Created at collection. Phase 6 fills sample_code (physical label) and moves status through the
-- chain of custody; corrections will be new audited events, never silent edits.
CREATE TABLE samples (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id          uuid NOT NULL REFERENCES registrations (id) ON DELETE RESTRICT,
  sample_type              text NOT NULL DEFAULT 'hair' CHECK (sample_type = 'hair'),
  status                   text NOT NULL DEFAULT 'collected' CHECK (status IN (
                             'collected', 'packaged', 'ready_for_dispatch', 'dispatched', 'in_transit',
                             'received_by_laboratory', 'analysis_in_progress', 'analysis_completed', 'report_available', 'rejected')),
  sample_code              text UNIQUE CHECK (sample_code IS NULL OR sample_code ~ '^[A-Z0-9-]{6,40}$'),
  branch_id                uuid NOT NULL REFERENCES collection_branches (id) ON DELETE RESTRICT,
  collected_by             uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  collected_at             timestamptz NOT NULL DEFAULT now(),
  collection_session_id    uuid NOT NULL UNIQUE REFERENCES collection_sessions (id) ON DELETE RESTRICT,
  identity_verification_id bigint NOT NULL REFERENCES identity_verifications (id) ON DELETE RESTRICT,
  instructions_id          uuid NOT NULL REFERENCES collection_instructions (id) ON DELETE RESTRICT,
  checklist                jsonb NOT NULL CHECK (jsonb_typeof(checklist) = 'array'),
  created_at               timestamptz NOT NULL DEFAULT now()
);
-- The database itself forbids a second live sample for a registration.
CREATE UNIQUE INDEX samples_one_live_per_registration ON samples (registration_id) WHERE status <> 'rejected';
CREATE INDEX samples_branch_collected_idx ON samples (branch_id, collected_at DESC);
CREATE INDEX samples_collector_idx ON samples (collected_by, collected_at DESC);
CREATE TRIGGER samples_no_delete BEFORE DELETE ON samples
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
