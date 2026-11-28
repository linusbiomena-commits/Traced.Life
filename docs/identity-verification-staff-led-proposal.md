# Staff-led supervised identity verification: implementation proposal (for review)

**Phase 8E, 28 Nov 2026.** **Status: proposal only. Nothing is implemented until you approve the approach.**

- The development simulation (`dev_simulated`) stays refused in production; its config and transaction guards are unchanged.
- **A customer QR code proves possession, never identity.** Scanning never changes the verification state.
- This document supersedes the rough estimate in `production-release-readiness.md` §5.

## 1. Can the current staff view support reliable matching?

**No.** Staff currently see only age, gender, sample type, branch, QR validity and status. Many people share an age and gender, so this can't establish that the person at the counter is the registered patient or guardian.

**Minimal controlled change, recommended:** a **blind match**.
- The staff member types what is printed on the identity document (first name, last name and, for the patient, date of birth).
- The server compares it with the registration and answers only **match / no match** per field.
- The server never sends the registered name or date of birth to the staff screen, and **does not store what the staff member typed**: only the result.
- Staff never see more personal data than today; the person's own document shows them nothing new.

**Fallback, alternative variant B:** reveal the patient's first and last name and date of birth inside the verification panel only, for the active session, audited.
- Simpler (about 10 hours less) but it exposes more data.
- Recommended only if the blind match proves impractical in branch testing.

## 2. Workflow (approved steps 1–12)

| # | Step | System behaviour |
|---|---|---|
| 1–3 | Customer arrives at the branch and shows the QR; staff scans it | **Existing:** QR validated (active, not used, not revoked, registration awaiting collection, branch = staff member's assigned branch). Opens a **collection session** bound to the QR, the staff member and the branch (30-minute expiry). Shows age and gender only |
| 4 | Validate registration and branch | existing |
| 5 | Staff verifies identity with an approved document | **New identity panel.** Staff picks the document type (approved list) and ticks **document is genuine-looking and not expired** and **photo matches the person present**. Types first name, last name and (patient only) date of birth exactly as printed → **Check** → per-field match / no match |
| 6 | Child or dependent: verify the guardian or representative and the relationship | **Child:** the **guardian** is checked against the registration's contact name (the account holder's details; the guardian's date of birth isn't collected, so name + photo + document validity). The **child** is checked against the child's name and date of birth using the approved child document (family card, birth certificate or child ID) or the approved alternative, the guardian's attestation (see §3). **Dependent:** the representative is checked like a guardian, plus "proof of authority checked and valid" (document type only), plus the dependent person's name and date of birth |
| 7 | Staff records the result | **Verified** (only possible when every required check matched) or **Failed** with a reason: mismatch, expired document, invalid document, document not presented, guardian absent, other |
| 8 | Staff confirms the person being sampled matches the registration | explicit confirmation tick, recorded with the result |
| 9 | Record method, staff, branch, time, outcome | append-only verification row plus per-subject check rows; audit entry |
| 10 | Collection only after successful verification | **existing gate**, tightened: the latest verification for this session must be `verified` with an **approved production method** (`staff_document_check`), cover every required subject, and match the current patient version |
| 11 | Sample ID and QR label | existing |
| 12 | Chain of custody continues | existing |

## 3. Scenarios

| Scenario | Who is verified | Evidence (approved list: to be confirmed by you and the laboratory) | Data compared |
|---|---|---|---|
| **Adult (self)** | the patient | national ID, Iqama, passport, GCC ID | patient first + last name, date of birth; photo; validity |
| **Child** | guardian **and** child | guardian: as adult. Child: family card, birth certificate or child ID; or **guardian attestation** if the child has no document (approved alternative, recorded as such) | guardian: registration contact name; child: child's name + date of birth |
| **Authorised dependent** | representative **and** dependent | representative: as adult + **proof of authority** (e.g. a guardianship document; type recorded, not its number); dependent: ID | representative: contact name; dependent: name + date of birth |
| **Guardian authorisation** | guardian present, consent `guardian_authorization` accepted at registration (existing) | the guardian must attend; if a different adult brings the child, verification fails ("guardian absent") | n/a |
| **Identity mismatch** | n/a | any field "no match" → can't record Verified | collection blocked; staff may retry with the other script or the correct field (max 3 checks per session), then must fail or escalate |
| **Expired or invalid evidence** | n/a | "not expired / genuine" unticked → can't record Verified | Failed (expired / invalid) |
| **Verification failure** | n/a | Failed with reason | collection blocked; the customer is told to contact support; the QR stays valid for a later visit |
| **Escalation** | admin | staff presses **Ask an administrator** (reason) | an escalation appears on the admin registration record. The admin may contact the customer, correct patient details before collection (existing; this invalidates earlier verifications) or cancel. **An admin can't mark someone verified remotely**: verification needs the person present at a branch |
| **QR reuse** | n/a | existing: a QR is single-use; sessions are bound to the QR token; a replaced or revoked QR ends the session; a used QR is refused | unchanged |
| **Recollection** | as the original scenario | existing: recollection issues a **new** QR → a new session → **a new verification is required** (results never carry over) | unchanged |

**Name matching (blind):**
- Comparison is accent- and case-insensitive; spaces and hyphens are normalised.
- Arabic is normalised: diacritics removed; alef forms unified; taa marbuta / haa, alef maqsura / yaa.
- The panel tells staff **which script** to type (Arabic or Latin, matching how the registration was entered) without showing the name. Saudi IDs and Iqamas carry both scripts.
- Only the registered first and last name are compared (middle names on the document are ignored).
- Date of birth must match exactly.

## 4. Privacy

- **Not stored:** document images, document numbers, scans, or the text staff type. Only document **type**, booleans (name match, date-of-birth match, photo match, valid / not expired, authority checked), the outcome, the reason, staff, branch, session and time.
- **Staff see no new personal data** (variant A). Lab operators and auditors see nothing of this. Admins see the results (types and booleans), not the typed values.
- **Anti-probing:** at most **3 checks per session** and 15 per staff member per hour. Each check is audited (result only). After 3 failed checks the session locks and must be escalated or failed. This stops staff from using the check to guess names or dates of birth.
- **Customer information:** the privacy notice and the collection instructions must say that an identity document is checked at the branch and not copied. That is **wording for legal/clinical approval**; Claude doesn't write it.
- **Records:** the DPIA / record of processing gets the new processing step.

## 5. Audit

New events (metadata never contains names, dates of birth, typed values or document numbers):
- `identity.check_performed`: subject, document type, per-field results, attempt number, session, branch.
- `identity.verification_recorded`: method `staff_document_check`, outcome, reason, subjects covered, session, branch.
- `identity.session_locked`
- `identity.escalated` / `identity.escalation_resolved`

Existing: `collection.confirmed` records the verification row used.

## 6. Staff access restrictions

- Only `collection_staff` **assigned to the registration's branch**, with an **open session they own**, can perform checks.
- `custody.record_lab`, auditor and customer roles are refused (authorisation matrix extended).
- Admins: read results and handle escalations; they can't perform branch checks remotely.

## 7. Changes required

**Database (migration 0013, additive):**
- `identity_verifications.method` allows `staff_document_check`. New columns: `failure_reason`, `confirmed_person_matches` (boolean).
- New append-only `identity_verification_checks`: verification or session, `subject` (`patient`, `guardian`, `representative`), `document_type`, `name_match`, `dob_match` (nullable), `photo_match`, `document_valid`, `authority_checked` (nullable), attempt number, staff, created_at.
- New append-only `identity_escalations` plus resolution rows (raised by, reason code + short text without personal data, resolved by, resolution).
- Grants: INSERT and SELECT for `traced_app` only. Triggers reject update and delete.

**API:**
- `GET /staff/sessions/:id`: adds the required subjects, the script hint per subject and the remaining attempts (no names).
- `POST /staff/sessions/:id/identity/checks`: blind comparison; rate-limited; idempotency key.
- `POST /staff/sessions/:id/identity/verification`: Verified (requires all subjects matched in this session for the current patient version) or Failed with a reason.
- `POST /staff/sessions/:id/identity/escalations`
- **Admin:** the registration record includes checks and escalations; `POST /admin/registrations/:id/escalations/:eid/resolve`.
- **Collection confirmation:** production accepts only `staff_document_check` (configurable allowlist `IDENTITY_METHODS`, refusing `dev_simulated`).

**Staff interface (EN/AR, phone-first):**
- The "Development only" block is replaced (in production) by the identity panel: subjects as steps, document type, two ticks, name/DOB fields with the script hint, Check, per-field ✓/✗, then Record verified / Record failed (reason), plus Ask an administrator.
- "Confirm sample collected" stays disabled until verified (existing behaviour).

**Admin interface:** verification events show the method, subjects, document types and results; an escalation list with a Resolve form.

**Configuration:** `IDENTITY_METHODS=staff_document_check` in production. `DEV_IDENTITY_VERIFICATION` stays refused.

## 8. Tests

- **Unit:** name normalisation (Arabic and Latin), DOB comparison, required-subject computation per relationship.
- **Integration:**
  - adult happy path; child (guardian + child); child with attestation; dependent with authority;
  - mismatch, expired, invalid, guardian absent → collection refused;
  - 3-attempt lock; rate limits;
  - wrong-branch staff, other roles and expired session refused;
  - used, replaced and revoked QR refused;
  - recollection needs a new verification; a patient correction invalidates it;
  - production config rejects `dev_simulated` and accepts `staff_document_check`;
  - privacy canary: no names, DOB or typed values in responses, logs or audit;
  - authorisation matrix.
- **Browser e2e:** staff flow EN/AR on phone width; admin escalation.
- **Pilot UAT:** each scenario with synthetic data.

## 9. Effort

| Work | Variant A (blind match) | Variant B (controlled reveal) |
|---|---|---|
| Migration, service, API | 10–12 h | 8–9 h |
| Name normalisation and matching | 3–4 h | — |
| Staff panel EN/AR | 5–6 h | 4–5 h |
| Admin escalation view | 3–4 h | 3–4 h |
| Tests (unit, integration, e2e, matrix) | 8–10 h | 6–8 h |
| Docs, instructions draft for approval, pilot deploy + UAT | 4–5 h | 4–5 h |
| **Total** | **33–41 h** (about 4–5 working days) | **25–31 h** |

Also needed from you and the laboratory:
- the approved document list per scenario;
- the attestation rule for children without documents;
- the escalation contact;
- the updated privacy notice and collection instructions (approval).

**Decision requested:** variant A or B, the approved document lists, and the child-attestation rule. Implementation starts only after your written approval.
