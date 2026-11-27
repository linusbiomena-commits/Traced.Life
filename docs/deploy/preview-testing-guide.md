# TRACED restricted preview: manual testing guide

**28 Nov 2026.** The restricted pilot is the complete TRACED platform at **www.tracedmena.life**: Vercel → `api.tracedmena.life` on the Oracle server in Riyadh → the **synthetic** database `traced_preview`.

**Use synthetic people and data only. Never enter a real patient.** The production database `traced` is separate and untouched.

## 1. Access
- Base address: **https://www.tracedmena.life**. The pilot gate asks for username `traced` and the pilot password, which the owner shares separately; **no Vercel account is needed**.

| Portal | English | Arabic |
|---|---|---|
| Public site (preview copy) | `/traced/` | `/ar/traced/` |
| Customer: create account | `/traced/account/sign-up/` | `/ar/traced/account/sign-up/` |
| Customer: sign in | `/traced/account/sign-in/` | `/ar/traced/account/sign-in/` |
| Customer: my registrations | `/traced/account/registrations/` | `/ar/traced/account/registrations/` |
| Collection staff | `/traced/staff/sign-in/` → `/traced/staff/scan/` | `/ar/traced/staff/sign-in/` |
| Laboratory | `/traced/lab/sign-in/` → `/traced/lab/scan/` | `/ar/traced/lab/sign-in/` |
| Admin, super admin, auditor | `/traced/admin/sign-in/` | `/ar/traced/admin/sign-in/` |

## 2. Test accounts (real inbox, synthetic people)
- Use **plus-addresses** on the company mailbox. Google Workspace delivers them to **info@tracedmena.life**: for example `info+cust1@tracedmena.life`, `info+staff1@…`, `info+lab1@…`, `info+admin1@…`.
- **Customers** sign up themselves on the sign-up page.
- **First preview admin:** tell me an address (e.g. `info+admin1@tracedmena.life`). I create it with `vm_08_create_admin.sh` (it receives a one-time setup link). That admin then invites collection staff (choose branch **[DEV] Riyadh sample branch**), laboratory operators and auditors from **Admin → Staff**.
- **Two-step verification:** admins, laboratory operators and auditors must enrol an authenticator app (Google Authenticator, Microsoft Authenticator) at first sign-in. Keep the recovery codes until testing ends.
- Emails come from **TRACED <info@tracedmena.life>**. Check the sender, the reply-to, and the links.

## 3. What to test (synthetic journey)
1. **Customer:** sign up → verification email → verify → sign in → **New registration** (use a made-up child or adult, branch [DEV] Riyadh) → confirmation + QR (on screen and by email) → registrations list and details. Repeat in Arabic.
2. **Collection staff** (phone or tablet with a camera):
   1. sign in → **Scan** → scan the customer's QR; only age and gender are shown;
   2. **identity check (preview only)**: the preview uses the *development* identity verification. It is not a real method and is **refused in production**;
   3. checklist → confirm collection → **print the sample label** (50×30, 50×25 or 62×29 mm) → package → ready for dispatch → dispatch (courier + tracking number).
3. **Laboratory:** sign in + two-step code → **Scan** the sample label → receive (condition) → start analysis → complete → **report available** (status only; no report file exists). Also test **reject** with a reason.
4. **Admin:**
   - after a rejection, **authorise recollection** → the customer gets a new QR → collect again (sample code ends `-S02`);
   - registrations search, transfer and patient correction; staff management; branches; collection instructions (draft → submit → publish);
   - **Audit integrity** → sign a checkpoint → verify;
   - **Personal-data export** (fresh code + reason);
   - email monitor;
   - MFA reset for a staff member.
5. **Auditor:** audit log and audit integrity are read-only; no management actions.
6. **Arabic and mobile:** every portal in Arabic is right-to-left; check on a phone at 375 px width, with no sideways scrolling.

## 4. What the preview deliberately does not do
- Real identity verification. A method still has to be approved (D-I); production refuses the development check.
- Medical report delivery (status tracking only).
- Customer status emails (off until the wording is approved).
- Approved consent texts: the preview shows the provisional texts marked "PROVISIONAL – NOT LEGALLY APPROVED".

## 5. Reporting problems
Send the page address, the role, what you did, and a screenshot **without real personal data**. I reproduce it, fix it with a test, and redeploy the preview.

## 6. Automated deployed test (for reference)
`deploy/oci/vm/vm_13_e2e.sh` (`deploy/oci/e2e/preview-journey.mjs`) runs **61 checks** against the deployed API with synthetic `@preview.tracedmena.test` accounts. Their emails are captured on the server, never sent, and deleted after the run. It covers every role above, MFA, recollection (-S02), audit integrity, export, access denials, password reset and Arabic email. Last result: **61/61 pass** (27 Nov 2026).
