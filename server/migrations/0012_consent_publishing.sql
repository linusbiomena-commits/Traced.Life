-- Phase 8E: publishing approved consent documents (server-side `publish-consent` command).
-- Additive only. Adds the external approval reference and the authorised publisher, requires a reference on
-- every newly approved document, and freezes the approval fields once written. A provisional document can
-- never be turned into an approved one: approval is always a new, immutable version.

ALTER TABLE consent_documents
  ADD COLUMN approval_reference text
    CHECK (approval_reference IS NULL OR (length(btrim(approval_reference)) BETWEEN 3 AND 200 AND approval_reference !~ '[\r\n]')),
  ADD COLUMN published_by uuid REFERENCES users (id) ON DELETE RESTRICT;

-- NOT VALID: rows that existed before this migration are left as they were; every new row is checked.
ALTER TABLE consent_documents
  ADD CONSTRAINT consent_documents_approved_needs_reference
  CHECK (status <> 'approved' OR (approval_reference IS NOT NULL AND published_by IS NOT NULL)) NOT VALID;

CREATE OR REPLACE FUNCTION consent_documents_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.body IS DISTINCT FROM OLD.body OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.doc_type IS DISTINCT FROM OLD.doc_type
     OR NEW.locale IS DISTINCT FROM OLD.locale OR NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256 THEN
    RAISE EXCEPTION 'consent document text is immutable; publish a new version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.approval_reference IS DISTINCT FROM OLD.approval_reference OR NEW.published_by IS DISTINCT FROM OLD.published_by
     OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'consent document approval details are immutable; publish a new version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Only retirement is allowed (provisional -> retired, approved -> retired). Never provisional -> approved.
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (NEW.status = 'retired' AND OLD.status IN ('provisional', 'approved')) THEN
    RAISE EXCEPTION 'consent document status % -> % is not allowed; approval is a new version', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
