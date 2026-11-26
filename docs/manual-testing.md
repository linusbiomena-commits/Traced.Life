# TRACED: Local Manual Testing Guide

Local development only. All accounts are synthetic (`*.local@example.com`). Never use real patient data. No password, token, MFA secret or recovery code is stored in this repository.

## 1. Start the local stack
- Database: `npm run dev:db` (embedded PostgreSQL on 127.0.0.1:54329, data in `.dev-db/`).
- Portal + API: `npm run dev` → **http://localhost:8787**. Pending migrations are applied automatically on start.
- Emails are never sent: they're written to the `.dev-mail/` folder of the folder you run from, and the link is printed in the server terminal.
- (In the Claude desktop app the same two processes are available as the preview servers `traced-db` and `traced-portal`.)

## 2. Get test accounts (secure, local-only)
Run in a terminal in the project folder:
```
npm run dev:test-accounts
```
- It creates any missing synthetic accounts (below) through the normal account services and prints a **one-time link** for each account that still needs a password. The links are also saved to `.dev-mail/`.
- Open the link and choose your own password (at least 12 characters). **No password is generated or stored anywhere.**
- Set-up links last 72 hours, password-reset links 30 minutes, and each works once. Run the command again for fresh links.
- `npm run dev:test-accounts -- --reset` also issues password-reset links for accounts that are already set up.
- The command refuses to run in production, against a non-local database, or with a real mail provider.

## 3. Accounts, URLs and features

| Role | Email | Sign-in URL | Lands on | MFA | Branch | Can use |
|---|---|---|---|---|---|---|
| Customer | `customer.local@example.com` (or create your own via sign-up) | http://localhost:8787/traced/account/sign-in/ | http://localhost:8787/traced/account/ | No | – | Register patients, QR codes, registration details and tracking, settings |
| Customer registration (new account) | any address | http://localhost:8787/traced/account/sign-up/ (patient registration: http://localhost:8787/traced/account/register/) | verification email in `.dev-mail/` | No | – | Account sign-up, email verification, 5-step registration |
| Collection staff (Phase 6 additions: **Samples** http://localhost:8787/traced/staff/samples/ and printable labels) | `staff.local@example.com` | http://localhost:8787/traced/staff/sign-in/ | http://localhost:8787/traced/staff/ | No (not required for this role) | `DEV-RUH-01` ([DEV] Riyadh sample branch) | Dashboard, QR scanner http://localhost:8787/traced/staff/scan/ (camera, USB or manual entry), identity check (development simulation), checklist, confirm collection, history. Sees patient **age and gender only** |
| Admin | `admin.local@example.com` | http://localhost:8787/traced/admin/sign-in/ | http://localhost:8787/traced/admin/ (after two-step verification) | **Yes** (mandatory) | – | Dashboard, registrations (search, full record, transfer, correction, QR, cancellation), customer lock/unlock, staff (collection staff and lab operators only), branches, instruction drafts, email monitor, audit log, operational CSV |
| Super admin | `superadmin.local@example.com` | **Same page as admins:** http://localhost:8787/traced/admin/sign-in/ | http://localhost:8787/traced/admin/ | **Yes** | – | Everything admins can, plus granting admin/auditor/super-admin roles and publishing collection instructions |
| Laboratory operator | `lab.local@example.com` | http://localhost:8787/traced/lab/sign-in/ | http://localhost:8787/traced/lab/ (after two-step verification) | **Yes** | – | Expected incoming samples, scan sample label (camera/USB/typed sample ID) http://localhost:8787/traced/lab/scan/, receipt with condition, accept/reject, analysis steps, report available, history. Sees **no patient personal data** |
| Auditor | `auditor.local@example.com` | Same admin sign-in page | http://localhost:8787/traced/admin/ | **Yes** | – | Dashboard (aggregates), audit log (IPs, emails and free-text reasons hidden), operational CSV. All other admin pages show "No access" |

- Admins, super admins and auditors share one sign-in page; what they see depends on their permissions.
- Arabic: add `/ar` in front of any path, e.g. http://localhost:8787/ar/traced/account/sign-in/.
- The customer sign-in page has discreet **Staff Login | Admin Login** links (Arabic: دخول الموظفين | دخول الإدارة).
- Whichever sign-in page you use, each role is sent to its own portal. Customers can't open staff or admin pages, collection staff can't open admin pages, and suspended or deactivated accounts can't sign in.

## 4. Two-step verification (admin, super admin, auditor, laboratory operator)
1. Open the account's one-time link from `npm run dev:test-accounts`, choose a password and click **Activate account**, then **Go to sign in**.
2. On http://localhost:8787/traced/admin/sign-in/ (laboratory: http://localhost:8787/traced/lab/sign-in/) enter the email and password and click **Sign in**.
3. You're taken to **Set up two-step verification**. Click **Start setup**.
4. On your phone, open **Microsoft Authenticator** or **Google Authenticator** → **+** / **Add account** → **Scan a QR code** (Microsoft: "Other account"). Scan the code on screen. (Can't scan? Choose "Enter a setup key" and type the key shown under the QR.)
5. Type the 6-digit code the app shows into **6-digit code** and click **Turn on two-step verification**. Codes change every 30 seconds.
6. You'll see **10 recovery codes**. Store them somewhere safe, such as a password manager. Don't screenshot them into shared folders or commit them. Each works once if you lose your phone. Click **I have saved my codes**.
7. **Next sign-ins:** email and password, then the current 6-digit code from the app (or **Use a recovery code instead**).
8. Lost the authenticator for a test account? Since Phase 7 a **super admin** can reset another person's two-step verification (staff account page, §7). Nobody can reset their own. A lost password is reset with `npm run dev:test-accounts -- --reset`.

## 5. Suggested manual test run (existing portals)
1. Customer: sign in (or sign up and verify via `.dev-mail/`), register a child, open the registration, view and download the QR.
2. Staff: sign in and open **Scan**. Either click the start button and hold the customer's QR (on your phone, or the downloaded PNG on another screen) in front of the webcam, or use **Enter the code manually or use a USB scanner**: read the QR with your phone camera, copy the link it shows, and paste it into **QR code content**, then **Check code**. You'll see age and gender only. Record the development identity simulation **Verified**, tick the checklist and confirm collection. The customer's page then shows "Sample collected".
3. Admin: sign in with two-step verification, search the tracking ID, open the full record, try a branch transfer or correction on a new registration, look at the audit log and email monitor.
4. Super admin: publish an instruction draft prepared by the admin; grant a role.
5. Auditor: confirm only the dashboard, audit log and CSV are available, with redacted details.

## 6. One complete synthetic journey (Phase 6)
1. **Customer:** sign in as `customer.local@example.com` (or sign up), click **New TRACED registration**, register a child at **[DEV] Riyadh sample branch**. Open the registration and keep its QR on screen (or download the PNG).
2. **Staff (collection):** sign in as `staff.local@example.com` → **Scan** → start the camera and show the customer QR, or paste its link under **Enter the code manually**. You'll see the patient's age and gender only. Under the development identity simulation click **Verified**, tick the checklist and click **Confirm sample collected**. The confirmation shows the physical sample ID `TRC-SA-MM/YY-XXXXX-S01`.
3. **Label:** click **Print sample label**, choose the size (50 × 30 mm default) and click **Print label** (browser print dialog; "Save as PDF" works). A reprint asks for a reason.
4. **Packaging and dispatch:** **Samples** → **Open** the sample (or scan its label / type its ID) → **Confirm packaging** → **Mark ready for dispatch** → **Record dispatch** with a courier name and a (test) shipment tracking number. Each step needs the "I checked the physical sample" box.
5. **Laboratory:** sign in as `lab.local@example.com` (two-step verification) → the sample appears under **Expected incoming samples** → open it (or **Scan a sample** and show the label QR to the camera) → choose the condition, **Accept sample**, tick the confirmation, **Confirm** → **Start analysis** → **Complete analysis** → **Mark report available** (confirm the approved delivery process).
6. **Customer:** reload the registration: the timeline shows every step with dates and **Report available**. No staff names, courier details or remarks.
7. **Admin:** sign in as `admin.local@example.com` → **Samples** → search the sample ID → the custody timeline, dispatch and receipt details and label prints.
8. **Rejection and recollection (optional):** with a second registration, have the laboratory **Reject sample** on receipt (reason + remarks). The customer sees "Issue with the sample". The admin opens the sample → **Authorise recollection** (reason). The customer gets a new QR ("New sample required"), and a fresh collection with identity verification creates `…-S02`. The rejected sample stays in the history.

Customer status emails (sample received, report available, new sample required) are off unless `CUSTOMER_STATUS_EMAILS=true` is set in `.env`. The new-QR email for recollection is always sent, to `.dev-mail/` locally.

## 7. Phase 7 features (local, after the Phase 7 upgrade)

The manual-testing worktree runs commit `dee1101` (dev DB at migration 0011) since 27 Nov 2026. Existing accounts, links and records were kept (backup verified before the upgrade, see §8). Use the same synthetic accounts as in §3.

| Feature | Who | URL |
|---|---|---|
| Audit integrity (status, history, run verification) | admin, super admin, auditor | http://localhost:8787/traced/admin/audit-integrity/ (Arabic: http://localhost:8787/ar/traced/admin/audit-integrity/) |
| Sign a checkpoint by hand | super admin | same page → **Sign a checkpoint now** |
| Personal-data export | super admin only | http://localhost:8787/traced/admin/exports/ |
| Create new recovery codes | anyone with two-step verification | http://localhost:8787/traced/admin/settings/ → **Recovery codes** |
| Reset another person's two-step verification | super admin only | Staff → open the person → http://localhost:8787/traced/admin/staff-member/?id=… → **Reset two-step verification** |
| Physical samples (branch) | collection staff | http://localhost:8787/traced/staff/samples/ |
| Samples and chain-of-custody history (admin) | admin, super admin | http://localhost:8787/traced/admin/samples/ → open a sample (http://localhost:8787/traced/admin/sample/?id=…) for its custody events |
| Laboratory | lab operator | http://localhost:8787/traced/lab/ and http://localhost:8787/traced/lab/history/ |
| Customer custody timeline | customer | http://localhost:8787/traced/account/registration/?id=… |

**Suggested Phase 7 test run**
1. **Audit integrity:** sign in as super admin → **Audit integrity**. Click **Sign a checkpoint now**, then **Run verification now**: expect "Verification passed". A JSON copy appears in the worktree's `.dev-audit-checkpoints/` folder (hashes and counts only). Sign in as auditor: the page works, but there's no checkpoint button and no export menu item.
2. **Export:** as super admin → **Personal-data export**. Choose today's date, tick one or two items (e.g. *Patient gender*), write a reason, enter the **current** 6-digit code and click **Download CSV**. Submitting again with the same code is refused (each code works once). Check the audit log for `report.exported_pii` with your reason and the file fingerprint, not the content. Admins and auditors don't see the menu item, and the server refuses them.
3. **Recovery codes:** in **Settings** → **Recovery codes**, enter the current code → 10 new codes appear once; the old ones stop working.
4. **MFA reset:** as super admin, open the laboratory operator's staff page → **Reset two-step verification** with a reason. The lab operator is signed out, and at the next sign-in sets up a new authenticator. On your own staff page the action isn't offered.
5. **Custody:** run the §6 journey, then open the sample under admin **Samples** to see each custody event.

**Development-only identity check:** the "Verified/Failed" simulation at collection exists only because `DEV_IDENTITY_VERIFICATION=true` in the local `.env`. Production configuration refuses to start with it (tested), and production collection stays blocked until a real verification method is approved.

## 8. Local database backup (before upgrades)
`npm run dev:db-backup` (run in the main `Traced Website` folder, where `.dev-db/` lives) takes an **online** backup of the running dev database (no downtime), restores the copy on a free port, and checks every table and the audit chain before reporting PASS. Backups go to `.dev-db-backups/<timestamp>/` (gitignored; they contain test personal data, so delete them when you no longer need them). To roll back an upgrade: stop the dev DB and the portal, move `.dev-db/data` aside, copy the backup's `data` folder in its place, start the dev DB, and move the worktree back to the previous commit.
