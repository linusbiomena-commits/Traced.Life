# Patient Identity Verification: Framework and Proposed Procedures

Status: **framework implemented (Phase 4); the physical procedure needs management approval before production.** Nafath and real SMS OTP are not implemented.

## Principles (enforced in code)
- **A QR code proves possession, not identity.** Scanning never changes the verification state.
- **Email verification proves inbox control, not the physical patient's identity.**
- **A checkbox alone is not verification.** The collection checklist only confirms the steps were done; verification is a separate recorded event with a method.
- **Staff never see personal identity data.** They see only a status: *Not verified*, *Verification pending*, *Verified*, *Verification failed*.
- **Production collection requires an approved method.** Only `dev_simulated` exists today, and it is unavailable in production: the configuration refuses `DEV_IDENTITY_VERIFICATION` and the confirmation transaction rejects `dev_simulated` in production. **Production collection is therefore impossible until an approved method is implemented.** This is intentional.

## Data model (migration 0007)
`identity_verifications` (append-only): `collection_session_id`, `registration_id`, `patient_id`, `method` (`dev_simulated` | `otp_customer_device` | `nafath` | `supervised_document_check`), `status` (`pending` | `verified` | `failed`), `patient_version_at`, `performed_by`, `created_at`.
- **Bound to:** the patient, the registration and the collection session (one staff member, one branch, one QR token, 30-minute expiry).
- **Invalidation:** if the patient's details are corrected after verification (`patients.updated_at` changes), the verification no longer counts and must be repeated. Replacing the QR invalidates the session itself. Confirmation records the exact verification row used (`samples.identity_verification_id`).

## Proposed verification methods (for approval)

| Method | How it works | What staff see | Notes |
|---|---|---|---|
| **A. Customer-device confirmation / OTP** (recommended first) | At the counter, the staff scan opens a session; the customer receives a one-time code by SMS to the verified mobile (or confirms in their signed-in account) and reads it out or taps "Confirm". | Status only | Proves the person present controls the registered account/phone. It does **not** prove the patient's identity by itself (e.g. a child). Needs an SMS provider with a registered sender ID. |
| **B. Nafath** | Backend starts a Nafath request for the account holder's (or adult patient's) national ID; they approve in the Nafath app. | Status only | Strongest proof for adults. Requires collecting National ID (currently **not** collected; a new approval), government onboarding and integration. |
| **C. Supervised document check** | A designated supervisor (not ordinary collection staff) compares an ID document with the registration on a separate screen and records the outcome. | Status only | Gives a physical match, but someone sees personal data, so it needs a separate role with its own permissions and audit. |

## Establishing that the person giving the sample is the registered patient
1. **Adult registering themself:** method B (Nafath) where approved; otherwise method A plus a supervised document check (C) for a physical match.
2. **Child registered by a parent/guardian:** the **guardian** is verified (A or B), and must attend with the child. The child's identity is confirmed by the guardian's attestation, recorded as part of the verification, with an optional supervised check of the child's ID/family card (C).
3. **Authorised dependent adult:** the guardian/representative is verified (A or B); proof of authority (e.g. guardianship document) is checked under method C by a supervisor.
4. **Mismatch or doubt:** record **Verification failed**; no collection is possible; the customer is directed to support.

## Implementation steps after approval
1. Choose the method(s) per scenario above.
2. Add the provider integration (SMS/Nafath) as a new method, plus any supervisor role and permissions (Phase 5 admin portal).
3. Production configuration enables only approved methods; tests prove `dev_simulated` stays unavailable.
4. Update the provisional collection instructions with the approved procedure (laboratory and management sign-off).
