# TRACED: Privacy review and key management (Phase 7)

Not legal advice and not a compliance certificate. It records what the system does with personal data so LinusBio MENA's privacy/legal reviewers can approve or change it (Saudi PDPL).

## 1. Data inventory

| Data | Who provides | Stored where | Who can see it | Notes |
|---|---|---|---|---|
| Account email, password hash, locale | customer / staff | `users` | the person; admins (email) | argon2id |
| Patient first/last name, date of birth, gender, relationship | customer | `patients` | customer; admins with `registration.read_full`; super-admin export | staff see **age + gender only**; laboratory sees **nothing** |
| Guardian/contact name, email, mobile | customer | `registrations` (snapshot) | customer; admins | not shown to staff or lab |
| Age in months at registration | derived | `registrations` | as above | |
| QR tokens | system | `customer_qr_tokens`, `sample_qr_tokens` (HMAC + encrypted) | holder | never logged |
| Collection: identity check result, checklist, staff, branch, time | staff | `collection_sessions`, `identity_verifications`, `samples` | admins | no identity documents stored |
| Custody events, label prints, recollections | staff/lab/admin | append-only tables | admins; lab sees operational data | |
| Previous patient values after a correction | system | `patient_revisions` (encrypted) | admins via audit | |
| Audit log | system | `audit_logs` | admins; auditors redacted (no IP, email, free text) | no names/emails in metadata by design |
| Emails (tracking ID, QR, branch) | system | outbox (payload encrypted, erased after send); Resend (US) | recipient | no patient name, DOB or phone in emails |
| IP address, user agent | request | sessions, audit | admins with full access | |

**Not collected:** National ID, Iqama, nationality, identity document images, health results (the report itself is not stored; "report available" is a status only).

## 2. Minimisation checks done in Phase 7

- Staff and lab response allowlists re-verified (authorization sweep + privacy tests).
- Personal-data export: super admin only, columns opt-in (tracking ID, date, status, branch, sample ID always; personal fields only when ticked), 31-day / 2,000-row default limits, refuses instead of truncating, reason + step-up TOTP, audit records columns, row count and file SHA-256 — never the content. No server copy. Arabic preserved (UTF-8 BOM).
- Auditors see redacted audit metadata; email filter needs full-access permission.
- Checkpoints and integrity pages contain only hashes, counts and sequence numbers.

## 3. Cross-border and processors (decisions for legal)

| Processor | Data | Location | Status |
|---|---|---|---|
| Google Cloud (Cloud Run, Cloud SQL, Secret Manager, GCS) | everything | me-central2 planned | to approve (D1) |
| Vercel | static pages; API traffic in transit if the rewrite design is kept | global edge | to approve (D2) |
| Resend | recipient email, tracking ID, QR image, branch | United States | to approve (D3) |

## 4. Retention (proposal — needs approval)

| Data | Proposal |
|---|---|
| Registrations, patients, custody, consent | duration required by the LinusBio/laboratory contract and health-records rules (to be specified); never shorter than the audit retention |
| Audit log, checkpoints, verifications | ≥ 400 days online (bucket retention 400 days); longer if legal requires |
| Sessions, auth tokens, rate-limit rows | expire automatically; housekeeping job to purge expired rows (Phase 8) |
| Email outbox | payload erased at send; rows kept 90 days then purge job (Phase 8) |
| Exports | none on the server; the recipient deletes after the task (shown on the export page) |

Deletion/anonymisation requests: append-only evidence cannot be erased in place; the proposed approach is account deactivation plus documented legal basis for keeping evidence. Needs legal sign-off.

## 5. Key management (Secret Manager)

| Key | Protects | If lost | If leaked | Rotation |
|---|---|---|---|---|
| `DATA_ENCRYPTION_KEY` | MFA secrets, QR redisplay, outbox payloads, patient revisions | encrypted values unreadable (users re-enrol MFA; QR codes reissued) — backups useless without it | attacker with a DB copy can decrypt those fields | new version for new data requires a re-encryption job (not built); **keep old versions while any backup uses them** |
| `TOKEN_HMAC_KEY` | session tokens, one-time links, QR lookup, recovery codes, email rate-limit keys | all sessions/links/QR codes invalid | forge-resistance of lookups lost | rotating = everyone signs in again and QR codes are reissued; plan as an event |
| `AUDIT_CHECKPOINT_KEY` | checkpoint signatures | new checkpoints only; old ones `unknown_key` | attacker could forge checkpoints | keep all versions |
| DB passwords | database | reset via owner | rotate immediately | yearly |
| Resend key | sending | new key | spam from our domain | send-only scope, yearly |
| Proxy secret | client-IP trust | regenerate both sides | IP spoofing for rate limits | yearly |

Rules: generated offline, entered once into Secret Manager, accessible only to the `traced-api` service account (per-secret IAM), access logged, never in chat, tickets, repository or screenshots. The backup drill proved that a restore is only usable with the matching key versions.
