# TRACED: production release readiness (Phase 8D)

**Prepared:** 28 Nov 2026 (Riyadh); **updated for Phase 8E** the same evening (`phase-8e-launch-blockers.md`) · **Target commercial launch:** 1 Dec 2026 · **Branch:** `feature/traced-portal` (nothing merged into `main`)

**Status:**
- **Not yet ready for real patients.**
- The software is complete for the approved scope and the restricted pilot passed UAT (`final-user-acceptance-report.md`).
- Real-patient launch still depends on approvals, one small missing release tool (§4.3), physical device tests and your release decision (§11).

**Nothing was switched:**
- The pilot gate is on.
- The API still runs in preview mode on `traced_preview`.
- The production database `traced` was only read (§3.1).
- No real registration or collection is possible.

## 0. Latest checkpoint

| Item | Value |
|---|---|
| Git | `55a17fa` (homepage header video) on `a9246d8` (final UAT); this report is committed on top. Pushed to `origin/feature/traced-portal` |
| Vercel production | `dpl_6X3UnK4K7FGhFG9CWBoAaHqmuJi9` (commit `55a17fa`) on www.tracedmena.life. Previous good deployment: `dpl_4i8NKsJdmxZMZU5Uc7A8WHFCKrze` (`fddcc9c`). Public-only checkpoint: `dpl_9WTxpjM6hhSyzXJjHX8RKw8vpF9n` |
| API (Oracle `traced-app-1`) | image `traced-api:15fb0fe` (the later commits only changed the website, middleware, tests and docs), `MODE=preview`, `DB=traced_preview`, `NODE_ENV=development`, `APP_ORIGIN=https://www.tracedmena.life` |
| Tests | unit/integration **314/314** (Phase 8E); deployed API journey **61/61**; real-browser UAT for all six roles passed |

## 1. Completed features (approved scope)

**Customer:**
- Sign-up, email verification, sign-in and password reset.
- Five-step registration for self, child or authorised dependent, with consent capture.
- Tracking ID, QR (PNG/SVG), QR resend and replace.
- Patient corrections before collection.
- Timeline up to "report available" (status only).
- English and Arabic, right-to-left layout and responsive design.

**Collection staff:**
- Invitation and setup.
- Camera, USB or manual QR scanning; age and gender only.
- Identity-verification framework (development simulation only).
- Versioned instructions and checklist; collection.
- Sample ID and label printing; packaging, ready for dispatch, dispatch.

**Laboratory:**
- Receipt, accept or reject with a reason, analysis statuses, report-available status.
- No patient data shown.

**Admin and super admin:**
- Dashboard, audited search and records.
- Transfers, corrections, cancellation, QR revoke and replace.
- Staff, branches, instruction drafts and publishing, email monitor.
- Audit log, audit integrity, recollection authorisation.
- Operational CSV.
- Personal-data export: super admin only, fresh MFA required.

**Security:**
- Sessions, CSRF protection and lockout.
- MFA with recovery codes and reset.
- Role permissions on every route (authorisation matrix).
- Append-only evidence tables; hash-chained audit log with signed daily checkpoints copied to a separate bucket.
- Least-privilege database roles.
- Trusted-proxy client IP, with the spoofing check passed.
- Pilot gate; nightly encrypted backups with a tested restore; 7 alarms.

**Not implemented (by design or not approved):**
- Medical report delivery (only the "report available" status).
- Customer status emails (wording not approved).
- Real identity verification.
- Point-in-time database recovery.
- Separately administered audit storage.

## 2. Scope freeze

No new features or redesigns are planned. The only development proposed (§4.3, §5) is release tooling and the identity-verification method. Both need your approval before any work starts.

## 3. Production database

### 3.1 Read-only inspection (28 Nov, `deploy/oci/vm/vm_20_prod_db_inspect.sh`, SELECT only)

| Check | Result |
|---|---|
| Database `traced` | exists, owner `traced_migrator`, 10 MB, data checksums **on** |
| Migrations | **0001–0011** applied 27 Nov 14:46 UTC; checksums recorded (re-verified by `vm_03` on 27 Nov) |
| Database roles | `traced_app`, `traced_migrator`, `traced_readonly` (can log in), `traced_owner` (cannot); **none** is superuser or has createrole, createdb or bypassrls. Tables are owned by `traced_migrator` |
| Runtime role on evidence tables | `audit_logs`, `custody_events`, `consent_records`, `registration_status_history`, `audit_checkpoints`: **INSERT, SELECT only** |
| Data | **0 rows** in all 29 data tables (users, sessions, registrations, patients, samples, custody, consents, instructions, branches, QR, outbox, audit and others) |
| Reference data | 6 roles, 21 permissions, 39 role-permission links (migration 0003) |
| Audit chain | intact (`audit_verify_chain()` is NULL) |
| Backups | nightly at 01:30 Riyadh, last run uploaded `db/traced-20261127T223238Z.dump.gpg`; 35-day lifecycle; restore tested 27 Nov (34/34 tables) |
| Timers | outbox and health every 5 min, checkpoint upload every 15 min, backup 01:30, audit checkpoint 02:30 Riyadh |

### 3.2 Activation checklist (do not start before approval)

| # | Item | How | Status |
|---|---|---|---|
| D1 | Migrations | `vm_03_verify.sh <vault>` immediately before the switch (checksums, triggers, role denials) | ready |
| D2 | Database roles | as above; the API connects as `traced_app` only | verified 28 Nov |
| D3 | Reference data | roles and permissions only. **No** `seed-dev`, no `[DEV]` branches, no provisional texts, no synthetic accounts | verified (empty) |
| D4 | Approved collection branches | an admin creates them in the admin portal (Branches) from the approved Wareed list (code, EN/AR name, city, address) | **awaiting branch list** |
| D5 | Laboratory locations | not modelled: custody records one "Laboratory". If several labs must be distinguished, that is new development (decision) | **decision** |
| D6 | Approved consent documents (4 types × EN/AR) | load with the release tool in §4.3, as `approved`, with an approval reference | **blocked: texts + tool** |
| D7 | Approved collection instructions | admin drafts → super admin publishes with a clinical approval reference (gives `approved`) | **awaiting clinical approval** |
| D8 | Production administrators | `vm_08_create_admin.sh` (sends a one-time setup link). Each privileged account enrols MFA at first sign-in (mandatory in production) | **awaiting names** (info@tracedmena.life plus a second super admin recommended) |
| D9 | Backups | already running for `traced`; after the switch, confirm the first post-switch backup and run `traced-restore-check` | ready |
| D10 | Audit integrity | the first checkpoint is written at 02:30 after the switch; verify in the admin portal and in the audit bucket | ready |
| D11 | Production environment | §10.2 (enforced by `loadConfig`: production refuses dev identity verification, mail capture, optional MFA, non-HTTPS origins, implicit proxy hops) | ready |

## 4. Clinical and consent documents

### 4.1 Provisional documents (none may be used in production; the API serves only `approved` versions when `NODE_ENV=production`)

| Document | Current version | Where it appears | Approval needed | Blocks |
|---|---|---|---|---|
| Privacy notice (EN, AR) | `0.1-provisional` (pilot DB only; production has none) | registration step 5 (Consent); customer and admin registration record | legal / DPO, including the Resend cross-border processing wording (§8.3) | **customer registration** |
| Consent to hair sample collection (EN, AR) | `0.1-provisional` | registration step 5 | clinical + legal | **customer registration** |
| Accuracy of information (EN, AR) | `0.1-provisional` | registration step 5 | legal | **customer registration** |
| Parent or guardian authorisation (EN, AR) | `0.1-provisional` | registration step 5, for child and authorised-dependent registrations | legal | **registration for a child or dependent** |
| Collection instructions and checklist (EN, AR) | `0.1-provisional` ("procedure not part of this version") | staff scan page before collection; recorded with each sample | laboratory + management sign-off | **sample collection** |
| Professional Arabic review of the portal texts | n/a | whole portal | Arabic reviewer | launch quality (not technical) |
| Customer status email wording | not written | off (`CUSTOMER_STATUS_EMAILS=false`) | marketing + legal | nothing (stays off) |

Claude does not write or approve clinical or legal wording.

### 4.2 Uploading approved versions

- **Collection instructions:** already supported. Admin portal → Instructions → New draft (EN + AR, steps, checklist) → submit → a super admin publishes with the **clinical approval reference** (for example a signed document number). Without a reference the version stays provisional and production will not use it. Versions are immutable.
- **Consent documents:** **no upload path exists yet.** The table and the service function (`publishConsentDocument`, immutable, SHA-256 of the text, `approved_by`/`approved_at`) exist, but only the development seed calls them. See §4.3.

### 4.3 Consent release tool: **built in Phase 8E** (`docs/deploy/consent-publishing.md`; 12 tests; not yet on the server)

Original proposal, kept for the record:

The proposal:
- a CLI `publish-consent` that reads the approved EN/AR text files, the version and the approval reference, and inserts them as `approved` through the existing service;
- a `vm_21` wrapper that runs it on the server against `traced`, with tests.

The tool adds no UI and changes no customer-facing behaviour. Alternative: a super-admin page (about 8–10 hours).

## 5. Identity verification

**What the development simulation does:**
- At collection the staff member presses "Verified", "Pending" or "Failed" under "Development only: simulate a verification outcome".
- The outcome is recorded as method `dev_simulated`, bound to the patient, registration and collection session.
- Nothing proves who the person at the counter is.

**Why it can't be used in production (and won't run there):**
- It proves nothing about the person.
- `loadConfig` refuses `DEV_IDENTITY_VERIFICATION` in production, and the collection transaction rejects `dev_simulated` when `NODE_ENV=production`.
- **Real sample collection is therefore impossible in production until an approved method is implemented.** This is intentional.

| Option | What it needs | Effort (development + tests) | External lead time |
|---|---|---|---|
| **A. Staff-led supervised check** (method C in `docs/identity-verification.md`) | Approved procedure, plus a supervisor role or permission that may see the patient's name and date of birth. The supervisor compares the identity document with the registration and records match or no match. Guardian attestation for children. Audit. Instructions updated | **16–24 h** | procedure approval only |
| **B. Customer-device confirmation (no SMS)** | Staff starts the session; the signed-in customer taps "Confirm I am here" on their own phone. Proves account control, not physical identity, so best combined with A | **12–16 h** | none |
| **C. SMS one-time code to the verified mobile** | KSA SMS provider (for example Unifonic or Taqnyat), registered sender ID, provider contract and privacy review, code delivery, retry and expiry | **20–30 h** | sender-ID registration, typically days to weeks |
| **D. Nafath** | National ID collection (currently deliberately not collected: new approval), government onboarding, integration | **40–60 h** | weeks to months |

**Phase 8E:** the detailed staff-led proposal is in `docs/identity-verification-staff-led-proposal.md` (blind-match variant A, 33–41 h, or controlled-reveal variant B, 25–31 h); it supersedes the estimates above.

**Recommendation:** A (with B for adults) as the first production method. Do not start without your written choice per scenario (adult, child with guardian, authorised dependent).

## 6. Authentication and MFA

| Control | Pilot (now) | Production |
|---|---|---|
| Customer, staff, lab and admin sign-in | unchanged | unchanged |
| MFA for privileged roles (lab operator, admin, super admin, auditor) | optional (`PILOT_MFA_OPTIONAL=true`, owner approval 28 Nov) | **mandatory**; `loadConfig` refuses `PILOT_MFA_OPTIONAL` in production |
| Fresh MFA for personal-data export | **required** (unchanged) | required |
| Role permissions, CSRF, session invalidation | unchanged; verified in UAT | unchanged |

- **Recorded:** the MFA-protected super admin export was **not** included in the 28 Nov browser UAT (skipped at your request). It's covered by automated tests (`pii-export.test`, `security.spec`).
- **Recommendation (15 minutes):** enrol MFA on the synthetic MFA super admin in the pilot and run one export before the switch, so the mandatory production enrolment flow has been seen on www.

## 7. Physical hardware checklist (you perform; nothing has been tested on hardware)

Record device model, OS, browser, date and result for each step. Use the pilot (synthetic data) on https://www.tracedmena.life. The detailed scanning and printer matrix is in `docs/device-checklist.md`.

**7.1 Android phone (Chrome) and 7.2 iPhone (Safari, iOS 15 or later)**, each as **customer** and as **staff**:
1. Open www.tracedmena.life → pilot page → sign in. Check the layout in English and Arabic: no sideways scrolling, buttons reachable.
2. Customer: open a registration and show the QR on screen at full brightness.
3. Staff: Scan → allow the camera → scan the customer QR from a second phone. Expected: decoded in about 2 s, then age and gender only; the camera light goes off.
4. Deny the camera permission once: expect a clear message, and manual entry still works.
5. Lock the screen while scanning, then unlock: the camera has stopped.
6. Switch to airplane mode while confirming an action, then retry: a clear error and no duplicate record.

**7.3 Staff camera scanning (counter PC + webcam, or tablet):** cases 1–11 of `device-checklist.md` §2: phone screen, low light, printed A4 QR, non-TRACED QR, tracking ID typed.

**7.4 Laboratory camera scanning:**
1. Lab → Scan sample → camera.
2. Scan a printed sample label on a curved bag: decodes, and nothing changes until you confirm.
3. Scan a creased or wet label: decodes, or the sample ID can be typed.

**7.5 USB QR scanner (keyboard wedge):**
1. Click the manual field on staff Scan.
2. Scan the customer QR: same result as the camera; the scanner must send Enter.
3. Repeat in the lab Scan field with a sample label.
4. Check Arabic keyboard layout: the scanner must still type Latin characters.

**7.6 Thermal label printer:**
1. Staff → Samples → Print sample label.
2. In the browser print dialog: the label printer, paper 50 × 30 mm (or 50 × 25 / 62 × 29 as selected), margins none, scale 100%, headers and footers off.
3. Expect one label with no blank second page and no scaling.
4. Check 203 dpi and 300 dpi if available.

**7.7 Sample QR readability:** scan the printed label QR with every approved phone and scanner at arm's length, after handling (crease, fridge or freezer, alcohol wipe). Record failures.

**7.8 Label dimensions:**
1. Measure the printed label with a ruler (target 50 × 30 mm ± 1 mm).
2. QR quiet zone visible.
3. The sample ID `TRC-SA-MM/YY-XXXXX-SXX` is fully legible.
4. No personal data on the label.

**7.9 Packaging and dispatch:**
1. Collect a synthetic sample, print and attach the label.
2. Staff → Samples: scan the label → packaging → ready for dispatch → dispatch with the courier and tracking number.
3. Lab: receive (intact) → accept → analysis statuses.
4. Customer timeline shows each step.
5. Also run one rejection → admin recollection → new collection (`-S02`).

**Sign-off:** approved device list, printer and media, lab setup (`device-checklist.md` §5).

## 8. Transactional email

### 8.1 DNS (checked 28 Nov via public DNS)

| Record | Value | Assessment |
|---|---|---|
| DKIM `resend._domainkey.tracedmena.life` | present (RSA key) | OK: messages sent through Resend are signed for `tracedmena.life`, so DMARC can pass by DKIM alignment |
| Return path `send.tracedmena.life` | Resend "Forge" MX + SPF (`v=spf1 ip4:… ~all`) | OK for Resend bounces |
| DMARC `_dmarc.tracedmena.life` | `v=DMARC1; p=none;` | **monitor only, no reports.** Recommend adding `rua=mailto:<reports address>`, watching for 1–2 weeks, then `p=quarantine` |
| SPF on `tracedmena.life` (root) | **missing** | Mail people send from info@ through Google Workspace has no SPF. Recommend `v=spf1 include:_spf.google.com ~all` |
| Google Workspace DKIM | **not found** at `google._domainkey` | Recommend enabling DKIM in the Google Admin console and publishing its record |
| MX `tracedmena.life` | Google Workspace | OK (replies to info@ reach the mailbox) |

These are DNS changes **you** make at Squarespace. Claude does not edit DNS.

### 8.2 Final delivery checks (authorised recipients only: your own plus-addresses on info@tracedmena.life)

For each message:
1. It arrives in the inbox, not spam.
2. "Show original" shows SPF and DKIM **pass**, DMARC **pass**.
3. The From line is `TRACED <info@tracedmena.life>`, and reply-to is info@.
4. Every link points to `https://www.tracedmena.life/…`, and the link works once only.
5. English and Arabic versions both look right.

| # | Email | How to trigger (pilot) |
|---|---|---|
| E1 | Customer account verification | sign up on www with `info+cust1@tracedmena.life` |
| E2 | Password reset | "Forgot your password?" for that address |
| E3 | Staff invitation | admin → Staff → invite `info+staff1@…` as collection staff |
| E4 | Laboratory invitation | admin → Staff → invite `info+lab1@…` as lab operator |
| E5 | Administrator invitation | `vm_08_create_admin.sh` for `info+admin1@…` (role admin) |

Customer status notifications stay **off**.

### 8.3 Approvals still open (from `docs/security/resend-privacy-review.md`)

- PDPL cross-border transfer approval (DPO or legal).
- Resend DPA accepted, sub-processor list reviewed, retention confirmed.
- Privacy notice wording mentions email processing by Resend outside KSA (sending region Tokyo; account data in the US).
- Record of processing.

## 9. Independent audit protection

**Current state (read 28 Nov):**
- Bucket `traced-audit-checkpoints` in compartment **TRACED**:
  - Standard tier, no public access, encrypted with Vault key `traced-master-key`;
  - 5 checkpoint objects (2.2 KB);
  - retention rule **keep-400-days, unlocked**; versioning off.
- The server (dynamic group `TRACED-Instances`) may only **create** and **read** objects there. Correct.
- **Gap:** the group `TRACED-Operators` has `manage all-resources in compartment TRACED`, and tenancy Administrators have everything. Either could remove the unlocked rule and then delete checkpoints, and the bucket's encryption key sits in the same compartment. So the audit copy is not yet administratively independent.

**Proposed configuration (nothing created yet):**

| Item | Proposal |
|---|---|
| Separate control | New compartment **TRACED-Audit** (sibling of TRACED) and group **TRACED-Audit-Admins** with a different person (for example compliance or DPO), not the day-to-day operator |
| Move | Move `traced-audit-checkpoints` into TRACED-Audit (OCI supports moving buckets; objects and the rule move with it) |
| Encryption | Switch the audit bucket to an Oracle-managed key (or a key in TRACED-Audit), so that deleting or disabling the TRACED key cannot make the evidence unreadable |
| IAM changes | (1) `Allow group TRACED-Audit-Admins to manage buckets, objects in compartment TRACED-Audit`. (2) `Allow group TRACED-Operators to read buckets, objects in compartment TRACED-Audit` (read only). (3) Update the workload policy so the instance may `OBJECT_CREATE` and read only in TRACED-Audit `traced-audit-checkpoints`. (4) Keep the server unable to delete or overwrite. Note: tenancy Administrators can still manage everything; only a **locked** retention rule stops even them from deleting objects early |
| Retention | 400 days (covers 1 year plus margin). Your decision; legal may require longer |
| Locking | A locked rule can't be removed or shortened by anyone, and the bucket can't be deleted until every object has expired. **Irreversible.** OCI applies the lock at a time at least 14 days in the future, so there is a window to cancel. Recommend locking only after 2–4 weeks of stable production checkpoints |
| Backup and recovery | Checkpoints are also in the database (`audit_checkpoints`) and in the nightly database backups. Cross-region copy isn't possible (only me-riyadh-1 is subscribed). Verification runs daily and on demand in the admin portal |
| Cost | Effectively **EUR 0**: KB-sized objects, within the free Object Storage allowance; compartments, groups and policies are free |

## 10. Production release configuration

### 10.1 Procedure (execute only after your final approval; about 2–3 hours with checks)

| Step | Action | Who |
|---|---|---|
| 0 | Freeze: no other changes. Note the current Vercel deployment and API image. Run `vm_03_verify.sh <vault>`. Run `traced-backup`, then `traced-restore-check` | Claude |
| 1 | **Switch the database:** `vm_07_api_install.sh <vault> <ns> 15fb0fe api.tracedmena.life https://www.tracedmena.life TRACED info@tracedmena.life info@tracedmena.life production`. This sets `DB=traced`, `NODE_ENV=production` and `DEV_IDENTITY_VERIFICATION=false`, adds no mail capture and no `PILOT_MFA_OPTIONAL`, and keeps `CUSTOMER_STATUS_EMAILS=false`. **The pilot (preview database) stops being served** | Claude |
| 2 | Development-only features off: enforced by `loadConfig` in production (dev identity verification, mail capture, static serving, optional MFA all refused). Check with `/etc/traced/api.conf` and the container environment names (no values) | Claude |
| 3–4 | MFA: `PILOT_MFA_OPTIONAL` absent, so privileged roles must enrol at first sign-in. Create the production super admins (`vm_08`); each completes setup and MFA on www | Claude + you |
| 5 | Load approved consents (§4.3), publish approved instructions (§4.2), create approved branches (D4) | you (approvals) + Claude (tool) |
| 6 | Official links: `APP_ORIGIN=https://www.tracedmena.life` (already); sender `TRACED <info@tracedmena.life>` | (already) |
| 7 | **Remove the pilot gate:** in Vercel Production set `TRACED_PILOT_GATE=off` **and** `TRACED_LAUNCH_APPROVED=yes` (you set them), then `vercel deploy --prod --scope linus-bio-mena` from `feature/traced-portal` | you + Claude |
| 8 | Verify all 86 portal routes are 200 without a pilot cookie (EN/AR); `/api/v1/health` is 200 through www; `api.tracedmena.life` direct is 403 | Claude |
| 9 | Public website: `/`, `/traced/`, `/ar/traced/`, FAQs and product pages are 200; header links "My Account" lead to sign-in | Claude |
| 10 | Backend: TLS certificate valid; ports 22 and 5432 closed; proxy-secret gate on; trusted proxy hops 2 | Claude |
| 11 | Smoke tests, with **your** real staff accounts and **one** of your own customer test addresses: sign-up and verify email (real Resend), sign-in, staff sign-in, admin sign-in with MFA, audit log entries. If consents are approved, one registration that is then **cancelled** with a reason (registrations can't be deleted; it stays as a clearly cancelled record) | you + Claude |
| 12 | Monitor for 24 h: alarms (after the subscription is confirmed), `traced-health`, Vercel logs, Resend dashboard, the first post-switch backup at 01:30 and checkpoint at 02:30 | Claude + you |

### 10.2 Final production environment (API; values only in Vault or Vercel, never in Git)

**API:**
- `NODE_ENV=production`, `DATABASE_URL` → `traced` as `traced_app`, `APP_ORIGIN=https://www.tracedmena.life`, `COOKIE_SECURE=true`.
- `TRUSTED_PROXY_HOPS=2`, `TRUSTED_PROXY_SECRET` (Vault).
- `MAIL_TRANSPORT=resend`, `MAIL_FROM='TRACED <info@tracedmena.life>'`, `MAIL_REPLY_TO=info@tracedmena.life`, `RESEND_API_KEY` (Vault).
- `TOKEN_HMAC_KEY`, `DATA_ENCRYPTION_KEY`, `AUDIT_CHECKPOINT_KEY`, `INTERNAL_CRON_SECRET` (Vault).
- `CUSTOMER_STATUS_EMAILS=false`, `DEV_IDENTITY_VERIFICATION=false`, `AUTO_MIGRATE=false`.
- Absent: `MAIL_CAPTURE_DOMAINS`, `PILOT_MFA_OPTIONAL`.

**Vercel Production:**
- `TRACED_BUILD_PORTAL=1`, `TRACED_API_ORIGIN=https://api.tracedmena.life`, `TRACED_PROXY_SECRET` (you).
- At launch: `TRACED_PILOT_GATE=off` + `TRACED_LAUNCH_APPROVED=yes` (you). `TRACED_PILOT_PASSWORD` can be removed afterwards.

## 11. Final release gate

| # | Requirement | Classification |
|---|---|---|
| 1 | Application features for the approved scope; UAT of all roles; tests 302/302; deployed journey 61/61 | **Completed** |
| 2 | Sign Out, CSRF, IP-spoofing fixes and checks | **Completed** |
| 3 | Oracle hosting in Riyadh, private database, backups and restore test, audit checkpoints, pilot gate | **Completed** |
| 4 | Production database clean and verified (read-only) | **Completed** |
| 5 | Approved consent texts (4 × EN/AR) | **Awaiting clinical/legal approval** · **Blocks real-patient launch** (registration) |
| 6 | Release tool to load approved consents (§4.3) | **Completed** (local, 28 Nov, tests 314/314); server image + migration 0012 need your authorisation |
| 7 | Approved collection instructions | **Awaiting clinical approval** · **Blocks real-patient launch** (collection) |
| 8 | Identity-verification method (§5) | Proposal ready (`identity-verification-staff-led-proposal.md`) · **Awaiting your decision** + **Requires additional development** · **Blocks real-patient launch** (collection) |
| 9 | Resend PDPL / cross-border approval, DPA, privacy notice wording | **Awaiting privacy approval** · **Blocks real-patient launch** |
| 10 | Approved Wareed branch list | **Awaiting your decision** (data) · **Blocks real-patient launch** |
| 11 | Laboratory locations | One designated laboratory is sufficient (no change); several labs = 16–24 h development (`phase-8e-launch-blockers.md` §7) · **Awaiting your confirmation** |
| 12 | Production super admins named; MFA enrolled at first sign-in | **Awaiting your decision** · **Blocks real-patient launch** |
| 13 | Android, iPhone, USB scanner, camera, thermal printer, label tests | **Requires physical testing** · **Blocks real-patient launch** (collection) |
| 14 | Alarm email subscription confirmation (PENDING; confirmation re-sent 28 Nov 18:28 Riyadh, no duplicate) | **Awaiting your action** (click the Oracle email at info@karamaitco.com), then a test message · blocks a safe launch |
| 15 | MFA super admin export seen in the browser | Test prepared (`phase-8e-launch-blockers.md` §8, about 20 min with you); can be deferred safely |
| 16 | Email delivery checks E1–E5 with header verification | **Requires testing** (you read the inbox) |
| 17 | DNS: root SPF, Google DKIM, DMARC reporting (enforcement later) | Exact records ready (`phase-8e-launch-blockers.md` §5) · **Awaiting your action** at Squarespace |
| 18 | Independent audit protection (compartment, IAM, lock) | Plan ready (`phase-8e-launch-blockers.md` §6) · **Awaiting your separate approval** · can be deferred safely (claim "independent audit evidence" only after it is done) |
| 19 | Professional Arabic review | **Awaiting approval** · can be deferred safely for a soft launch, recommended before marketing |
| 20 | Medical report delivery | **Not implemented**: only the report-availability status exists. Can be deferred (results delivered outside the system) |
| 21 | Customer status emails | Off; can be deferred safely |
| 22 | Point-in-time recovery (backups are nightly; up to 24 h of data at risk) | Can be deferred with accepted risk; your decision |
| 23 | Oracle company-account conversion (invoices) | Can be deferred safely |
| 24 | Final production release approval and merge to `main` | **Awaiting your decision** |

**Conclusion:** TRACED is **not market-ready for real patients** until rows 5–10, 12–14 are closed. A safe 1 December option is to keep the restricted pilot running, or to launch **registration only** once rows 5, 6, 9, 10 and 12 are done, with collection staying blocked by design until rows 7, 8 and 13 are done.

## 12. Release and rollback

### 12.1 Deployment commands

- **Website:** `vercel deploy --prod --scope linus-bio-mena --yes` from the reviewed `feature/traced-portal` checkout. Never chain it with a test run. Then `vercel inspect <url> --scope linus-bio-mena` must show `Ready` with the www alias.
- **API image:** `vm_02_migrate.sh <vault> <commit> traced` (builds `traced-api:<commit>`, runs migrations as `traced_migrator`), then `vm_07 … production` (§10.1).
- **Admins:** `vm_08_create_admin.sh`. **Checks:** `vm_03`, `vm_12_jobs_check.sh`, `vm_20`.

### 12.2 Rollback

| What | Command | Time | Limitations |
|---|---|---|---|
| Website | Vercel → Promote `dpl_4i8NKsJdmxZMZU5Uc7A8WHFCKrze` (or the last good one), or `vercel rollback --scope linus-bio-mena` | 1 min | none |
| Re-enable the pilot gate | remove `TRACED_PILOT_GATE` / `TRACED_LAUNCH_APPROVED` in Vercel, then redeploy | 3 min | users currently signed in keep their session until it expires, but every portal page needs the pilot cookie again |
| API code | set `REF=<previous tag>` in `/etc/traced/api.conf`, then `systemctl restart traced-api` | 2 min | migrations are forward-only (additive), so older code still runs |
| Database switch back to the pilot | `vm_07 … preview` | 3 min | data written to `traced` stays there (not lost, not visible in the pilot); production users can't sign in until switched back |
| Data restore | restore a nightly backup into a **new** database (`traced-restore-check` logic), verify the chain, then switch `DB` | 30–60 min | everything after the backup (up to 24 h) is lost and must be reconciled; never restore over the primary without an incident decision (`docs/deploy/rollback.md` §5) |

### 12.3 Backup verification (before and after the switch)

- `systemctl start traced-backup`, then `traced-restore-check`. Expect row counts to match and the audit chain to be NULL.
- The `traced-backup-stale` alarm fires if no backup is uploaded for more than 26 h.

### 12.4 Post-launch monitoring

- **Alarms** (after confirming the subscription): API unhealthy, containers down, health metrics missing, backup stale, CPU, memory, disk.
- **Daily:**
  - admin dashboard failed-email count;
  - audit integrity result (02:30);
  - Resend dashboard bounces and complaints;
  - Vercel function errors;
  - Oracle budget (EUR 23.25).

### 12.5 Incident response

1. **Detect:** alarm, user report, failed email or integrity finding.
2. **Contain:**
   - re-enable the pilot gate (3 min), or roll back the website or API;
   - for a suspected account compromise, suspend the account (admin portal), which revokes its sessions.
3. **Preserve:** never edit audit, custody or consent rows. For an integrity failure follow `docs/security/audit-integrity.md`.
4. **Decide:** a data restore needs the security owner and the LinusBio MENA operations lead (`rollback.md` §6).
5. **Notify:** PDPL breach notification duties apply (DPO); tell affected customers if data was lost.
6. **Record:** time, actions, who, what was verified; follow up with a fix that has a regression test.

## 13. Remaining effort, expenditure and execution order

### 13.1 Estimated remaining working hours

| Work | Claude | You / third parties |
|---|---|---|
| Consent release tool (§4.3) + loading | 4–5 h | provide approved texts |
| Identity verification option A (+B) | 16–24 h (+12–16 h) | procedure approval |
| Production switch, checks, smoke tests, 24 h monitoring | 3–4 h | 1–2 h |
| Audit protection setup (after decision) | 1–2 h | assign the audit admin; 15 min |
| Email checks E1–E5 + DNS advice | 1 h | 30 min inbox + DNS |
| Device tests support | 1–2 h | 4–6 h with hardware |
| MFA export check | 0.5 h | 15 min |
| **Total (without identity verification)** | **≈ 11–15 h** | **≈ 7–10 h** |

### 13.2 Current infrastructure expenditure

- **Oracle Cloud (November to date, usage API):** **EUR 0.00** across Compute, Block Storage, Object Storage, network, notifications and telemetry. Within Always Free; budget alert at EUR 23.25 (about SAR 110 incl. VAT). Worst case without free allowances is about SAR 64 a month incl. VAT.
- **Vercel:** plan as shown on the Vercel dashboard (not readable via the CLI).
- **Resend:** plan chosen by you; check the daily and monthly limits on the Resend dashboard.
- **Domain and Google Workspace:** existing.

### 13.3 Recommended execution order

1. You:
   - confirm the Oracle alarm subscription email;
   - DNS changes (§8.1);
   - name the production super admins and the audit admin.
2. You: run email checks E1–E5 in the pilot (Claude triggers them; you read the headers).
3. You: physical device and printer tests (§7) in the pilot.
4. You: obtain consent and instruction approvals and the Resend privacy approval. In parallel, approve the consent release tool (§4.3) → Claude builds and tests it.
5. You: choose the identity-verification method → Claude implements it (collection stays blocked until done).
6. Optional: MFA export check (15 min); audit compartment and IAM changes (lock later).
7. Final approval → §10.1 steps 0–12 → merge to `main` only with your approval.

## 14. Release checklist (tick on the day)

- [ ] Approvals present: consents (8 texts) with references, instructions with a clinical reference, Resend privacy, branch list, admins
- [ ] Alarm subscription confirmed; DNS changes done
- [ ] `vm_03` passed; backup + restore check passed right before the switch
- [ ] `vm_07 … production` done; the environment shows production, no capture, no optional MFA, no dev identity verification
- [ ] Super admins created; MFA enrolled; second super admin works
- [ ] Consents loaded (`approved`); instructions published (`approved`); branches created
- [ ] Vercel gate off (both variables) and redeployed; 86 routes 200; public site 200; API direct 403
- [ ] Smoke tests passed; real emails received with SPF/DKIM/DMARC pass
- [ ] First backup (01:30) and checkpoint (02:30) after the switch verified
- [ ] Your written release approval recorded; merge to `main` only if approved

## 15. Rollback checklist

- [ ] Decide what failed (website / gate / API / database / data)
- [ ] Website: promote the previous deployment; confirm www serves it
- [ ] Exposure concern: re-enable the gate and redeploy; confirm portal pages redirect to the pilot page
- [ ] API: previous `REF`, restart, health 200
- [ ] Database: `vm_07 … preview` to return to the pilot; note the time; production data stays in `traced`
- [ ] Data loss: restore into a new database only with an incident decision; reconcile the gap
- [ ] Record the incident and verify the audit chain afterwards
