-- Phase 5: authorized admin portal. Additive only; migrations 0001-0007 are untouched.

-- ---- Permission: prepare collection-instruction drafts ------------------------------------
-- Admins prepare drafts; publishing/approval stays with `form.approve` (super admin only).
-- Must match server/src/modules/rbac/catalogue.ts (a test enforces this).
INSERT INTO permissions (key, description) VALUES
  ('instructions.draft', 'Prepare and submit collection instruction drafts (publishing needs form.approve)');
INSERT INTO role_permissions (role_key, permission_key) VALUES
  ('admin', 'instructions.draft'),
  ('super_admin', 'instructions.draft');

-- ---- Account status changes (lock/unlock, suspend/activate/deactivate) --------------------
ALTER TABLE users
  ADD COLUMN status_reason     text CHECK (status_reason IS NULL OR length(status_reason) <= 200),
  ADD COLUMN status_changed_at timestamptz,
  ADD COLUMN status_changed_by uuid REFERENCES users (id) ON DELETE RESTRICT;

-- ---- Branch transfers before collection (append-only) -------------------------------------
CREATE TABLE registration_branch_transfers (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  registration_id uuid NOT NULL REFERENCES registrations (id) ON DELETE RESTRICT,
  from_branch_id  uuid NOT NULL REFERENCES collection_branches (id) ON DELETE RESTRICT,
  to_branch_id    uuid NOT NULL REFERENCES collection_branches (id) ON DELETE RESTRICT,
  reason          text NOT NULL CHECK (length(reason) BETWEEN 5 AND 500),
  transferred_by  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  actor_role      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (from_branch_id <> to_branch_id)
);
CREATE INDEX registration_branch_transfers_reg_idx ON registration_branch_transfers (registration_id, id);
CREATE TRIGGER registration_branch_transfers_no_update BEFORE UPDATE OR DELETE ON registration_branch_transfers
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER registration_branch_transfers_no_truncate BEFORE TRUNCATE ON registration_branch_transfers
  FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();

-- ---- Collection instruction drafts and publication metadata -------------------------------
-- Drafts are editable working copies (EN + AR together). Publishing copies a draft into the
-- immutable collection_instructions table (one row per locale). Publishing in the application is
-- NOT clinical approval: status 'approved' additionally records the reference of the
-- laboratory/management approval obtained outside the system.
CREATE TABLE collection_instruction_drafts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version        text NOT NULL CHECK (version ~ '^[0-9A-Za-z.\-]{1,32}$'),
  title_en       text NOT NULL CHECK (length(title_en) BETWEEN 1 AND 200),
  title_ar       text NOT NULL CHECK (length(title_ar) BETWEEN 1 AND 200),
  steps_en       jsonb NOT NULL CHECK (jsonb_typeof(steps_en) = 'array' AND jsonb_array_length(steps_en) BETWEEN 1 AND 30),
  steps_ar       jsonb NOT NULL CHECK (jsonb_typeof(steps_ar) = 'array' AND jsonb_array_length(steps_ar) BETWEEN 1 AND 30),
  checklist      jsonb NOT NULL CHECK (jsonb_typeof(checklist) = 'array' AND jsonb_array_length(checklist) BETWEEN 1 AND 20),
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'published', 'withdrawn')),
  notes          text CHECK (notes IS NULL OR length(notes) <= 1000),
  created_by     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  updated_by     uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  submitted_by   uuid REFERENCES users (id) ON DELETE RESTRICT,
  submitted_at   timestamptz,
  published_by   uuid REFERENCES users (id) ON DELETE RESTRICT,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX collection_instruction_drafts_status_idx ON collection_instruction_drafts (status, updated_at DESC);
CREATE TRIGGER collection_instruction_drafts_set_updated_at BEFORE UPDATE ON collection_instruction_drafts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER collection_instruction_drafts_no_delete BEFORE DELETE ON collection_instruction_drafts
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- A published draft is frozen like the version it produced.
CREATE FUNCTION collection_instruction_drafts_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('published', 'withdrawn') THEN
    RAISE EXCEPTION 'a % instruction draft cannot be changed', OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER collection_instruction_drafts_freeze BEFORE UPDATE ON collection_instruction_drafts
  FOR EACH ROW EXECUTE FUNCTION collection_instruction_drafts_freeze();

ALTER TABLE collection_instructions
  ADD COLUMN draft_id           uuid REFERENCES collection_instruction_drafts (id) ON DELETE RESTRICT,
  ADD COLUMN published_by       uuid REFERENCES users (id) ON DELETE RESTRICT,
  ADD COLUMN approval_reference text CHECK (approval_reference IS NULL OR length(approval_reference) BETWEEN 3 AND 200);

-- ---- Email: customer notice when the collection branch changes ----------------------------
ALTER TABLE email_outbox DROP CONSTRAINT email_outbox_kind_check;
ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_kind_check CHECK (kind IN (
  'verify_email', 'account_exists', 'reset_password', 'password_changed', 'account_setup',
  'registration_confirmation', 'registration_qr_resend', 'registration_branch_changed'));

-- ---- Indexes for admin search, filters and pagination -------------------------------------
CREATE INDEX registrations_created_idx ON registrations (created_at DESC, id DESC);
CREATE INDEX registrations_branch_status_idx ON registrations (branch_id, status);
CREATE INDEX registrations_contact_phone_idx ON registrations (contact_phone);
CREATE INDEX registrations_contact_email_idx ON registrations (contact_email);
CREATE INDEX email_outbox_status_created_idx ON email_outbox (status, created_at DESC);
CREATE INDEX email_outbox_created_idx ON email_outbox (created_at DESC, id DESC);
CREATE INDEX audit_logs_occurred_idx ON audit_logs (occurred_at DESC);
CREATE INDEX staff_branch_assignments_branch_idx ON staff_branch_assignments (branch_id) WHERE revoked_at IS NULL;
