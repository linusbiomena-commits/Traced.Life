-- Phase 2: customer profile, collection branches, patients, registrations, status history,
-- versioned consent documents and consent records. Additive only (backward-compatible).

-- Account-holder profile (prefills the registration contact step). Nullable: existing rows unaffected.
ALTER TABLE users
  ADD COLUMN full_name text CHECK (full_name IS NULL OR length(full_name) BETWEEN 1 AND 200),
  ADD COLUMN phone     text CHECK (phone IS NULL OR phone ~ '^\+9665[0-9]{8}$');

-- Collection branches are data, managed in the admin portal (Phase 5). No production values here.
CREATE TABLE collection_branches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,32}$'),
  name_en     text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 200),
  name_ar     text NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 200),
  city_en     text NOT NULL CHECK (length(city_en) BETWEEN 1 AND 100),
  city_ar     text NOT NULL CHECK (length(city_ar) BETWEEN 1 AND 100),
  address_en  text NOT NULL DEFAULT '' CHECK (length(address_en) <= 500),
  address_ar  text NOT NULL DEFAULT '' CHECK (length(address_ar) <= 500),
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER collection_branches_set_updated_at BEFORE UPDATE ON collection_branches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The person being tested. Belongs to one account holder; `relationship` is how the account
-- holder relates to the patient. National ID / Iqama / nationality are deliberately absent.
CREATE TABLE patients (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  relationship    text NOT NULL CHECK (relationship IN ('self', 'child', 'authorized_dependent')),
  first_name      text NOT NULL CHECK (length(first_name) BETWEEN 1 AND 100),
  last_name       text NOT NULL CHECK (length(last_name) BETWEEN 1 AND 100),
  date_of_birth   date NOT NULL CHECK (date_of_birth >= DATE '1900-01-01'),
  gender          text NOT NULL CHECK (gender IN ('male', 'female')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patients_account_idx ON patients (account_user_id);
-- An account has at most one "myself" patient.
CREATE UNIQUE INDEX patients_one_self_per_account ON patients (account_user_id) WHERE relationship = 'self';
CREATE TRIGGER patients_set_updated_at BEFORE UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Sample statuses for the whole lifecycle (Phase 0 §6), defined once so later phases need no
-- enum migration. Phase 2 only ever creates 'registration_completed' (and customer cancellation
-- is not exposed yet).
CREATE TABLE registrations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_user_id      uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  patient_id           uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  branch_id            uuid NOT NULL REFERENCES collection_branches (id) ON DELETE RESTRICT,
  product              text NOT NULL DEFAULT 'traced' CHECK (product = 'traced'),
  sample_type          text NOT NULL DEFAULT 'hair' CHECK (sample_type = 'hair'),
  collection_country   text NOT NULL DEFAULT 'SA' CHECK (collection_country = 'SA'),
  status               text NOT NULL DEFAULT 'registration_completed' CHECK (status IN (
                         'registration_completed', 'awaiting_sample_collection', 'sample_collected',
                         'sample_packaged', 'ready_for_dispatch', 'dispatched', 'in_transit',
                         'received_by_laboratory', 'analysis_in_progress', 'analysis_completed',
                         'report_available', 'rejected', 'cancelled')),
  -- Tracking ID in its final format, issued by the Phase 3 engine. NULL until then; no
  -- temporary format is ever stored. (period, seq) are what Phase 3 allocates atomically.
  tracking_id          text UNIQUE CHECK (tracking_id ~ '^TRC-SA-(0[1-9]|1[0-2])/[0-9]{2}-[0-9]{5}$'),
  tracking_period      char(4) CHECK (tracking_period ~ '^[0-9]{2}(0[1-9]|1[0-2])$'),   -- YYMM (Asia/Riyadh)
  tracking_seq         integer CHECK (tracking_seq BETWEEN 1 AND 99999),
  -- Contact snapshot at submission (the account holder; the guardian when the patient is a dependent).
  contact_full_name    text NOT NULL CHECK (length(contact_full_name) BETWEEN 1 AND 200),
  contact_email        text NOT NULL CHECK (contact_email = lower(contact_email) AND length(contact_email) BETWEEN 3 AND 254),
  contact_phone        text NOT NULL CHECK (contact_phone ~ '^\+9665[0-9]{8}$'),
  patient_age_months_at_registration integer NOT NULL CHECK (patient_age_months_at_registration BETWEEN 0 AND 1800),
  -- Duplicate-submission protection (double clicks, network retries).
  idempotency_key      uuid NOT NULL,
  request_fingerprint  bytea NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  cancelled_at         timestamptz,
  UNIQUE (account_user_id, idempotency_key),
  UNIQUE (tracking_period, tracking_seq),
  CHECK ((tracking_id IS NULL) = (tracking_period IS NULL) AND (tracking_period IS NULL) = (tracking_seq IS NULL))
);
CREATE INDEX registrations_account_idx ON registrations (account_user_id, created_at DESC);
CREATE INDEX registrations_patient_idx ON registrations (patient_id);
CREATE INDEX registrations_status_idx ON registrations (status);
CREATE TRIGGER registrations_set_updated_at BEFORE UPDATE ON registrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only status history (the full custody chain with handovers arrives in Phase 6).
CREATE TABLE registration_status_history (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registration_id uuid NOT NULL REFERENCES registrations (id) ON DELETE RESTRICT,
  from_status     text,
  to_status       text NOT NULL,
  changed_by      uuid REFERENCES users (id) ON DELETE RESTRICT,
  actor_role      text,
  reason          text CHECK (reason IS NULL OR length(reason) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX registration_status_history_reg_idx ON registration_status_history (registration_id, id);
CREATE TRIGGER registration_status_history_no_update BEFORE UPDATE OR DELETE ON registration_status_history
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER registration_status_history_no_truncate BEFORE TRUNCATE ON registration_status_history
  FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();

-- Versioned, configurable consent texts. Only 'approved' documents may be used in production
-- (enforced in code); 'provisional' is for local development and testing.
CREATE TABLE consent_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type       text NOT NULL CHECK (doc_type IN ('privacy_policy', 'sample_collection_consent', 'accuracy_declaration', 'guardian_authorization')),
  version        text NOT NULL CHECK (version ~ '^[0-9A-Za-z.\-]{1,32}$'),
  locale         text NOT NULL CHECK (locale IN ('en', 'ar')),
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body           text NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  content_sha256 bytea NOT NULL,
  status         text NOT NULL CHECK (status IN ('provisional', 'approved', 'retired')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  approved_by    uuid REFERENCES users (id) ON DELETE RESTRICT,
  approved_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_type, version, locale),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL) OR status = 'retired')
);
-- Published text never changes: a new wording is a new version.
CREATE FUNCTION consent_documents_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.doc_type IS DISTINCT FROM OLD.doc_type
     OR NEW.locale IS DISTINCT FROM OLD.locale OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 THEN
    RAISE EXCEPTION 'consent document text is immutable; publish a new version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER consent_documents_freeze BEFORE UPDATE ON consent_documents
  FOR EACH ROW EXECUTE FUNCTION consent_documents_freeze();
CREATE TRIGGER consent_documents_no_delete BEFORE DELETE ON consent_documents
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- Proof of what was accepted, by whom, when, for which patient and registration. Append-only.
CREATE TABLE consent_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id     uuid NOT NULL REFERENCES registrations (id) ON DELETE RESTRICT,
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  patient_id          uuid NOT NULL REFERENCES patients (id) ON DELETE RESTRICT,
  consent_document_id uuid NOT NULL REFERENCES consent_documents (id) ON DELETE RESTRICT,
  accepted_at         timestamptz NOT NULL DEFAULT now(),
  ip                  inet,
  user_agent          text CHECK (length(user_agent) <= 512),
  UNIQUE (registration_id, consent_document_id)
);
CREATE INDEX consent_records_user_idx ON consent_records (user_id);
CREATE TRIGGER consent_records_no_update BEFORE UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER consent_records_no_truncate BEFORE TRUNCATE ON consent_records
  FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();
