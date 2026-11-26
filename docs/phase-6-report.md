# TRACED Platform: Phase 6 Report (Physical Sample Identification and Chain of Custody)

26 November 2026 · branch `feature/traced-portal` · developed and tested locally; **not deployed, nothing provisioned**. Approved scope: the owner's Stage A + Phase 6 authorisation of 26 November 2026 (decisions A21, A22 in `docs/DECISIONS.md`).

## 1. Summary
- **Stage A** prepared the portals for manual testing:
  - Staff Login | Admin Login links on the customer sign-in page;
  - one shared role-routing function;
  - local-only synthetic test accounts created via one-time links (`npm run dev:test-accounts`, no stored passwords);
  - a manual-testing guide;
  - a frozen manual-testing portal, so Phase 6 development never disturbed the owner's testing.
- **Phase 6** extends collection into a full chain of custody:
  1. Every collection creates a physical sample `TRC-SA-MM/YY-XXXXX-SXX` with its own secure sample QR and a printable label.
  2. Branch staff package, mark ready and dispatch.
  3. A new **laboratory portal** (lab operators, MFA, no patient data) receives samples, records their condition, accepts or rejects them, and records analysis and report availability.
  4. Admins see the full custody history, correct by appending events, and authorise recollection. Recollection issues a new customer QR, and a fresh collection creates `-S02`.
  5. Customers see a simplified, dates-only timeline.
- The age-and-gender-only rule for collection staff is unchanged. The lab sees no patient identity at all.
- Defects found and fixed: 1 server concurrency bug, 2 UI bugs and 1 latent tooling bug (§14).

## 2. Stage A: login improvements and manual testing
- **Links:** the customer sign-in page has discreet links (Arabic: دخول الموظفين | دخول الإدارة) to `/traced/staff/sign-in/` and `/traced/admin/sign-in/`, in EN/AR, RTL and mobile. There's no staff or admin registration.
- **`homeFor()`** in `dist/portal/js/core/app.js` routes every role from any sign-in page:
  - customers → `/traced/account/`;
  - collection staff → `/traced/staff/`;
  - admins, super admins and auditors → two-step verification → `/traced/admin/` (permitted views only);
  - lab operators → two-step verification → `/traced/lab/` (Phase 6).
- **`next` links** are honoured only inside the account's own area, which prevents open redirects and cross-area redirects. Customer-only pages redirect staff and admins.
- **Server unchanged:** suspended and deactivated accounts and MFA rules are still enforced by the server.
- **Accounts:** `npm run dev:test-accounts` creates or reuses `customer.local`, `staff.local` (DEV-RUH-01), `admin.local`, `superadmin.local`, `auditor.local` and `lab.local` `@example.com` accounts. Its tests (§11) show it refuses production, non-local databases and real mail.
- **Guide:** `docs/manual-testing.md`. Stage A checkpoint: `26d4eec`.

## 3. Exact local URLs (http://localhost:8787; add `/ar` for Arabic)
| Portal | Sign-in | Home |
|---|---|---|
| Customer | `/traced/account/sign-in/` (sign-up `/traced/account/sign-up/`) | `/traced/account/`, registration `/traced/account/register/` |
| Collection staff | `/traced/staff/sign-in/` | `/traced/staff/`; scanner `/traced/staff/scan/`; **samples `/traced/staff/samples/`**; label `/traced/staff/label/?id=` |
| Admin, super admin, auditor | `/traced/admin/sign-in/` (shared) | `/traced/admin/`; **samples `/traced/admin/samples/`**, sample `/traced/admin/sample/?id=` |
| **Laboratory** | **`/traced/lab/sign-in/`** | **`/traced/lab/`**, scan `/traced/lab/scan/`, history `/traced/lab/history/` |
| Two-step verification (all privileged roles) | `/traced/admin/two-step/` | – |
| Public sample-label landing | `/traced/s/` (shows nothing; token dropped from the URL) | – |

## 4. Physical sample identification
- **ID:** `TRC-SA-MM/YY-XXXXX-SXX`, the unchanged registration tracking ID plus a 2-digit sequence.
- **Storage:** it reuses `samples.sample_code`. Migration 0009 replaces the Phase 4 format check (which disallowed "/") and adds `sample_seq` with `UNIQUE (registration_id, sample_seq)`, plus a format check and a unique sample code.
- **Allocation:** inside the collection transaction while the registration row is locked (atomic), with the unique constraints as a backstop. Exhaustion after S99 is refused safely (`SAMPLE_SEQUENCE_EXHAUSTED`).
- **No reuse:** a rejected or cancelled sample ID is never reused. Recollection always takes the next number.
- **Internal UUID:** separate (`samples.id`).
- **One active sample:** the Phase 4 unique index `samples_one_live_per_registration` (status ≠ rejected) still allows only one active sample. A second one exists only after rejection plus admin-authorised recollection.
- **Immutable identity:** a trigger blocks changes to the ID, sequence, registration, branch, collector, collection time, session, identity-verification reference, instructions version and checklist. Deletion was already blocked.
- **Collection integration:** confirmation now allocates the ID, issues the sample QR and writes the initial custody event (`collected`, collection session) in the same transaction. Identity checks are unchanged (the development simulation is still refused in production), and the customer QR is still marked used.

## 5. Physical sample QR
- **Token:** 256-bit random, prefix `s1_`, in its own table `sample_qr_tokens` (HMAC lookup key, AES-GCM-encrypted value for rendering, one active per sample, immutable, never deleted).
- **QR content:** `https://<origin>/traced/s/#s1_…`. No personal, medical or tracking data; the token sits in the URL fragment.
- **Separate from customer QRs:** each scanner refuses the other kind of code, and unknown or revoked codes look the same.
- **Scanning never changes status.** Every action needs an explicit request with the operator's expected current status and a confirmation.
- **Never exposed:** raw tokens never appear in logs, the audit log, emails or API text. The label SVG draws the QR and doesn't contain the token as text (tested).
- **Typed fallback:** the sample ID can be typed when a label can't be scanned. Each custody event records how the sample was identified (`sample_qr`, `sample_id_entry`, …).

## 6. Labels
- **Content:** "TRACED", the physical sample ID, the tracking ID, "Hair · شعر" and the collection date (Riyadh), with the sample QR. **No** name, DOB, phone, email, national ID, guardian or other personal data (tested).
- **Sizes:** 50×30 mm (default), 50×25 and 62×29. Printing uses CSS named pages (`@page`), so the browser prints exactly the label size. Thermal printers work through their normal driver, and "Save as PDF" in the print dialog gives a PDF.
- **Downloads:** the QR as PNG or SVG, for authorised staff (their branches) and admins.
- **Print logging:** every print is recorded (`sample_label_prints`, append-only). The first print needs no reason; **every reprint needs one**, and both are audited.
- **No compatibility claim:** **physical printer compatibility is not claimed**, because no real printer or label stock was tested. The ~19 mm QR (≈0.5 mm per module) needs validation on the actual printer.

## 7. Chain of custody
- **Two levels of status:**
  - *Sample status* (physical): collected → packaged → ready_for_dispatch → dispatched → (in_transit) → received_by_laboratory → analysis_in_progress → analysis_completed → report_available; or rejected.
  - *Registration status* (customer journey) mirrors the current sample (`collected` → `sample_collected`, `packaged` → `sample_packaged`) and keeps `cancelled` for itself.
- **`custody_events`** is append-only (triggers block update, delete and truncate). Each event records:
  - sample, registration, from/to status;
  - server time (shown in Asia/Riyadh);
  - account and role;
  - location type (branch, laboratory, administration) and branch;
  - how the sample was identified;
  - handover JSON (courier, shipment tracking number, verification level);
  - condition, rejection reason category, remarks;
  - a reference to the corrected event (corrections);
  - an idempotency key and request id;
  - plus an audit entry in the same transaction.
- **Transactions:** every transition locks registration → sample, re-checks the matrix, branch assignment and permission, and rejects a stale expected status (`STATUS_CHANGED`). It is idempotent per request key, re-checked after the locks (§14.1).

**Transition matrix (server-enforced; everything else refused):**

| From → to | Who | Required |
|---|---|---|
| (collection) → collected | collection staff (Phase 4 flow) | full collection checks |
| collected → packaged | collection staff, own branch (`custody.record_branch`) | label confirmation |
| packaged → ready_for_dispatch | collection staff, own branch | label confirmation |
| ready_for_dispatch → dispatched | collection staff, own branch | courier company + shipment tracking number |
| dispatched / in_transit → received_by_laboratory | lab operator (`custody.record_lab`) | condition (intact/damaged), physical confirmation |
| dispatched / in_transit / received / analysis_in_progress → rejected | lab operator | reason category (+ remarks for "other") |
| received → analysis_in_progress → analysis_completed | lab operator | confirmation |
| analysis_completed → report_available | lab operator | explicit confirmation that the report is available through the approved process |
| any → (correction) | admin, super admin (`custody.correct`) | reason; appended event referencing the original |
| rejected → (recollection) | admin, super admin (`registration.manage`) | reason; once per rejected sample |

- **No fabricated transport events:** `in_transit` is **reserved**. Phase 6 has no transport accounts, so nobody records intermediate transport custody. Dispatch is marked "dispatch record only (transport not independently verified)" until the laboratory independently confirms receipt. The structure (location types, handover JSON) supports transport accounts later without a rewrite.

## 8. Laboratory operator workflow
1. Invitation, then sign-in at `/traced/lab/sign-in/` (or any sign-in page), then mandatory two-step verification.
2. **Dashboard:** expected incoming samples (with the branch's courier and tracking number), samples in the laboratory, and today's counts.
3. **Scan:** camera, USB or typed sample ID. The lab view contains **no patient name, contact, DOB, age, gender or guardian data**, only operational data.
4. **Receipt:** record the condition, then accept (received) or reject on receipt (reason, internal remarks), with physical confirmation. Simultaneous receipts record exactly one event (tested with 6 at once).
5. **Analysis:** start, complete, then report available (with explicit confirmation). No report upload, storage or LIS integration.
6. **History** of samples handled by the laboratory.

## 9. Rejection and recollection
- **Rejection categories** (provisional, pending lab approval): damaged packaging, missing sample, unreadable label, identification mismatch, insufficient sample, other (remarks required).
- **What rejection does:**
  - remarks stay internal;
  - the rejected sample and every earlier event are kept;
  - further analysis is refused;
  - the registration is **not** cancelled;
  - the customer sees "Issue with the sample" and admins see the rejection.
- **Recollection** (admin, mandatory reason): the registration returns to "awaiting sample collection", and the previous customer QR is revoked. A **new customer QR** is issued and emailed (a spent QR is never reactivated). The customer timeline shows "New sample required".
- **Fresh collection:** the next collection repeats the full Phase 4 flow with the new QR (fresh scan, **fresh identity verification**, current instructions) and creates `-S02` with its own sample QR.

## 10. Customer tracking, emails and admin custody management
- **Customer timeline** (`/me/registrations/:id` → `timeline`; own registrations only):
  - steps: registration completed, sample collected, sample sent to the laboratory, received by the laboratory, analysis in progress, analysis completed, report available, issue with the sample, new sample required;
  - dates only: no staff identities, courier details, remarks, audit records or internal codes;
  - EN/AR and mobile.
- **Status emails** (sample received, report available, new sample required): EN/AR templates with the tracking ID and a link only. Sending is controlled by `CUSTOMER_STATUS_EMAILS` (default **off** until the wording is approved). The new-QR email for recollection always goes out.
- **Admin custody management:**
  - sample list with counts, search by sample ID or tracking ID, and filters (status, branch, dates);
  - sample record with the full timeline (actor, role, location, identification method, handover, condition, reason, remarks, corrections), label prints and QR status;
  - links between registration and sample;
  - correction by appended event (reason required);
  - recollection authorisation.
  - Everything sensitive is audited.

## 11. Tests
| Suite | Result |
|---|---|
| Typecheck | clean |
| Unit + integration (Vitest, real PostgreSQL) | see §16 (final run). New in this stage/phase: 4 local-account CLI + 12 custody tests |
| Browser (Playwright, Edge, simulated camera) | see §16. New: 2 login/role-routing + 3 custody |

New coverage:
- **Accounts and routing:** CLI refusals; links-only accounts, idempotency and MFA still enforced; login links (EN/AR/mobile); role routing from every sign-in page, with `next` ignored across areas.
- **Identifiers:** sample ID format; uniqueness under 5 concurrent collections; immutability.
- **QR separation:** customer and sample QRs are kept apart; unknown codes are refused; raw tokens appear in no stored text or audit row; QR content is decoded from the actual PNG.
- **Labels:** no personal data; first print, reprint and reason; branch restriction.
- **Matrix:** invalid transitions; stale status; wrong side; dispatch details required; `in_transit` not recordable.
- **Branch scoping and idempotency:** other branches refused; idempotent double submits, including simultaneous ones.
- **Laboratory:** lab-only access with MFA; the lab view contains no patient data; receipt needs a condition; 6 concurrent receipts record exactly 1.
- **Analysis and reports:** analysis through to report available, with confirmation.
- **Rejection and recollection:** rejection rules; recollection authorisation (admin only, once); the spent QR stays spent; fresh identity verification; S02; rejected history kept.
- **Customer timeline:** ownership and no internals.
- **Admin:** list, search and detail; correction appends and never edits (DB rejects UPDATE and DELETE); admin endpoints refused to staff, lab, auditor and customer.
- **Privacy:** a canary sweep across every new staff and lab endpoint.
- **Browser journey:** registration → collection → label (print and reprint) → package → dispatch → lab receipt with the **simulated camera on the real sample QR** → analysis → report → customer timeline → admin record; the rejection → recollection → S02 path; Arabic lab portal; 375 px mobile staff and lab pages with no horizontal scrolling.
- **Evidence:** screenshot sanitisation now also redacts **sample QR tokens** (`/traced/s/`, `s1_`), and the evidence test checks every committed screenshot.

## 12. Privacy and security verification
- Collection staff: age and gender only (sample scan, list, history), with exact key-set tests.
- Laboratory: no patient data, with exact key-set tests and a canary sweep.
- Labels: no personal data.
- Customers: own registrations only; no internal remarks or staff identities.
- Admins: full custody detail only with `registration.read_full`; corrections need `custody.correct`; recollection needs `registration.manage`.
- Unchanged: MFA for lab and admin roles, branch restrictions, CSRF, rate limits on every new endpoint, no-store responses, the trusted-proxy fix, and customer QR lifecycle protections.
- Raw sample and customer QR tokens are never logged or returned as text; screenshots are redacted automatically.
- Audit chain: still tamper-evident only (hardening is Phase 7).
- `npm audit`: see §16.

## 13. Database: migration `0009_custody.sql` (additive; 0001–0008 untouched)
- **`samples`:** format check replaced; `sample_seq`, `status_changed_at`; unique (registration, seq); backfill of existing samples; identity-guard trigger.
- **New tables:**
  - `sample_qr_tokens`;
  - `custody_events` (append-only, plus an initial event for existing samples);
  - `sample_label_prints`;
  - `recollection_authorizations`.
- **`email_outbox`:** three new kinds (`sample_received`, `report_available`, `recollection_required`).
- **Indexes:** for the lab queue, sample status and idempotency.
- **Dev DB state:** the owner's dev database had 0001–0008 during development (the manual-testing portal ran the Stage A worktree). 0009 is applied when the main-folder server starts; see `docs/HANDOVER.md` for the current state.

## 14. Defects found and fixed
1. **Idempotent replay under concurrency:** two simultaneous requests with the same idempotency key could make the second return a status conflict. The replay check now runs after taking the locks.
2. **Label CSS class collision:** label classes named `.p-label…` would have restyled every form field label in the portal. Renamed to `.p-slabel…`.
3. **"Reprint label" button text** reverted to "Print label" after printing (`setBusy` restored the old saved label). Fixed.
4. **Screenshot redaction pattern** contained an invisible backspace character from an earlier edit, so one branch (bare `c1_` tokens) never matched. The URL branch still covered every customer QR in practice. Fixed, and extended to sample tokens.
5. **Super-admin race test:** the losing request may also be refused with 401, because the winner's role change ended its session. The test now accepts every valid refusal.

## 15. Known limitations and outstanding approvals (not treated as approved)
- **Technical:**
  - No physical-device, USB-scanner or **label-printer** testing.
  - Label size is provisional.
  - `in_transit` is unused until transport accounts exist.
  - Customer status emails are off by default.
  - Admin notification of rejections is via the dashboard and sample list (no email).
  - Report delivery is status-only.
  - Rejection categories and packaging instructions are provisional.
  - Arabic wording needs professional review.
  - The Windows E2E orphan-worker clean-up is still partial (Phase 7).
- **Approvals still needed:**
  - repository privacy;
  - real identity verification (including child and guardian);
  - eligibility criteria;
  - consent wording;
  - clinical collection, packaging and handling instructions, and rejection criteria;
  - Arabic review;
  - Resend and Vercel data transfer, and the sending domain;
  - real Wareed branch and laboratory details;
  - printer and packaging dimensions;
  - the report delivery process;
  - device testing;
  - final GCP costs;
  - audit-log hardening;
  - retention and deletion rules;
  - backup and recovery testing.

## 16. Final verification (26 Nov 2026)
| Check | Result |
|---|---|
| TypeScript typecheck | clean |
| Unit + integration (Vitest, real PostgreSQL) | **216 / 216** (200 Phase 0–5 + 4 local-account CLI + 12 custody) |
| Browser (Playwright, Edge, simulated camera) | **27 / 27** (9 customer + 7 staff + 6 admin + 2 login/role routing + 3 custody), about 3 min |
| Static portal checks | 82 portal shells up to date; all 56 TRACED pages patched exactly as before (no public page changed) |
| `npm audit` | 0 vulnerabilities |
| Secrets / sensitive-data scan | no keys, credential URLs, `#token=` links, `c1_`/`s1_` tokens, `.env`, local DBs or mail captures tracked; every committed screenshot passes the decodable-QR check |

**Browser-test stability work during this phase:** two harness issues on this Windows machine made camera tests fail intermittently in full runs only (each passed alone).
1. Several admin browser tests left extra browser contexts open. Their pages kept polling in the shared browser process and slowed later simulated-camera decodes. They are now closed after each test.
2. A sync or antivirus tool occasionally locked screenshot PNGs for a moment. Screenshots are now written from memory with retries (`saveScreenshot`).

The custody browser file sorts after the staff tests (`tracking-custody.spec.ts`), because Edge shares one fake camera device per browser process. No test was weakened; the camera tests still decode real QR codes.

## 17. Completion and remaining work
- **Engineering completion:** about **77%** (Phases 0–6 ≈ 275 of ≈ 330–400 h, by the Phase 0 estimate adjusted for the larger Phase 5 and 6 scope). Business, legal and clinical approvals are excluded.
- **Remaining:** Phase 7 (≈ 40–55 h) and Phase 8 (≈ 20–30 h, excluding waiting time for approvals and provisioning), so **≈ 60–85 hours** of development.

## 18. Phase 7 plan (security hardening and production readiness; requires approval)
1. **Audit-log hardening** (`docs/audit-hardening-plan.md`): separate migration and runtime database roles (the runtime cannot UPDATE or DELETE audit or custody tables); periodic chain checkpoints stored outside the database; a verification job; an investigation runbook.
2. **Authentication and authorisation review:** sessions, cookies, CSRF, lockout, MFA recovery flows, invitation and reset expiry, session revocation on role changes; IDOR and privilege-escalation test sweep across every endpoint.
3. **PII exports** (deferred from Phase 5): super admin only, fresh MFA, reason, date limits, minimisation, CSV safety, audit.
4. **Security testing:** dependency and static analysis, an OWASP ZAP scan of the local stack, secrets scanning in CI, a database permission audit, browser security headers.
5. **Performance and reliability:** synthetic load at 10× expected volume, connection pooling on a `db-f1-micro`-sized instance, concurrent registrations, collections and custody, outbox retries, query plans for dashboards.
6. **Backup and recovery:** a dump-and-restore drill, migration rollback strategy, data-retention jobs (once rules are approved).
7. **Test-harness reliability:** per-run ports and process-tree clean-up for embedded PostgreSQL on Windows.
8. **Physical validation plan and execution** when the hardware is available: Android, iPhone, tablet, webcam, USB scanner, label printer.
9. **Deployment readiness:** Cloud Run, Cloud SQL and Scheduler configuration, Secret Manager mapping, the Vercel `/api` rewrite and proxy-secret middleware, CORS and same-origin checks, caching headers, monitoring and alerts design.
