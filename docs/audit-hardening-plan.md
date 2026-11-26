# Audit Log Hardening Plan

Status: **plan only**. Implementation and production-level verification are scheduled for Phase 7; nothing here is deployed.

## What the current hash chain does and does not guarantee

- **Guarantees:** normal application code (and any database user subject to triggers) cannot UPDATE, DELETE or TRUNCATE audit rows. Each row's SHA-256 covers its content and the previous row's hash, so `audit_verify_chain()` detects edited, deleted or reordered rows, including edits by a superuser who disables the triggers, *unless they recompute the chain*.
- **Does not guarantee:** someone with owner/superuser rights can rewrite the whole chain consistently, and nothing inside the same database can detect that. **The current chain is therefore tamper-evident against ordinary users and the application, but it is not tamper-proof.**

## Plan

### 1. Restricted application database role
- The API connects as `traced_app`, which is not the schema owner. Draft grants are in `server/sql/production-roles.sql`.
- `traced_app` has INSERT/SELECT only on `audit_logs`, `consent_records`, `registration_status_history` and `patient_revisions` (no UPDATE/DELETE/TRUNCATE), on top of the existing triggers.
- Migrations run as `traced_owner`, whose credentials are kept offline and used only during deployments.
- Superuser access is limited to named people and logged by the cloud provider.

### 2. Independent checkpoints, outside ordinary DB admin control
- A scheduled job (hourly, plus at every deploy) reads the latest `(chain_seq, hash, occurred_at)` and writes a **checkpoint** to storage the database administrators cannot alter:
  - **Primary:** object storage with WORM / Object Lock (compliance mode, retention ≥ the audit retention period), in a separate cloud account owned by compliance and in the approved Saudi region.
  - **Secondary:** a signed daily digest (HMAC with a KMS key the DB admins can't use), emailed to a compliance mailbox.
- Each checkpoint contains no personal data: sequence number, hash, timestamp, row count and the job's identity.

### 3. Detecting tampering
- **Continuous:** `audit_verify_chain()` runs nightly and must return NULL (no broken link).
- **Against checkpoints:** for every stored checkpoint, the row with that `chain_seq` must still have exactly that hash. A rewritten chain changes the hashes of every later row, so it fails against the first checkpoint after the edit, even if `audit_verify_chain()` passes.
- **Count check:** rows up to each checkpoint must still number `chain_seq` (no deletions).
- Any failure raises a security incident (alert to compliance and the DPO) and preserves evidence (DB snapshot plus checkpoint copies).

### 4. Optional: keyed hashing
Adding an HMAC (key in KMS, usable by the app but not by DB admins) to each row would stop a DB-only attacker from recomputing valid hashes. This is a migration plus a key-management decision, so it's deferred to Phase 7 and depends on the chosen cloud provider.

### 5. A second copy of events
Ship audit events to a separate log store (SIEM) with its own retention, so the database is not the only record.

### 6. Log hygiene (verified by tests now)
- Audit rows hold ids, action names, field *names* and non-personal metadata. Never values, QR tokens, passwords or one-time links (tests: `qr.test.ts` "secret hygiene", `registrations.test.ts`, `decisions.test.ts`, `auth.test.ts`).
- Email outbox one-time links are encrypted and erased after sending; QR images are rendered at send time and never stored in the outbox.
- Application logs record ids and error codes only. The local dev mailer prints addresses and links to the developer's console **in development only**; the production transport (Resend) never logs content.

## Verification to complete in Phase 7
1. Apply `production-roles.sql` in staging and prove `traced_app` cannot UPDATE/DELETE audit rows (also with triggers disabled by the owner).
2. Run the checkpoint job, then deliberately rewrite the chain as owner in staging and prove the checkpoint comparison detects it.
3. Confirm Object Lock retention cannot be shortened by the database team.
4. Document the runbook and incident response.
