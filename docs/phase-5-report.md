# TRACED Platform: Phase 5 Report (Authorized Admin Portal)

26 November 2026 · branch `feature/traced-portal` · developed and tested locally; **not deployed, nothing provisioned or purchased**. Approved scope: the owner's Phase 5 authorisation of 26 November 2026 (decisions recorded in `docs/DECISIONS.md`).

## 1. Summary

Authorised administrators now have a bilingual (EN/AR, RTL) admin portal that reuses the existing authentication, MFA, sessions, permissions, audit log and frontend architecture. It covers:
- a live dashboard;
- audited registration search and full records;
- branch transfers, cancellations and patient corrections;
- customer lock, unlock and verification resend;
- QR management;
- staff invitations, roles, branches and status;
- branch management;
- versioned collection instructions (draft → submit → super-admin publish);
- an email delivery monitor;
- an audit-log viewer;
- a non-identifying operational CSV export.

The mandatory first task, the **trusted-proxy fix**, was completed and pushed before any admin endpoint was built.

Collection staff still receive **only patient age and gender**. A new regression test calls every admin endpoint as collection staff and checks that each refusal reveals nothing.

Two defects were found by the new tests and fixed before commit (§13).

## 2. Re-estimate (after inspecting reusable code)

Reuse covered auth, MFA, sessions, RBAC, audit, the QR lifecycle, patient corrections, the outbox, the page generator and the test harnesses. With the reduced scope (PII exports, audit-chain UI, admin-created registrations, deletion and consent management deferred), the planning estimate fell from about 60–80 h to **about 40–50 engineering hours**. The work was completed within this phase.

## 3. Milestones and commits

| # | Milestone | Commit |
|---|---|---|
| 1 | Trusted-proxy hardening + 12 tests | `898705e` |
| 2 | Migration 0008, admin API, 33 integration tests | `405a1f0` |
| 3 | Admin portal frontend, browser tests, screenshots, report, handover | see `docs/HANDOVER.md` / `git log` |

## 4. Trusted-proxy fix (milestone 1)

**Problem:** the old code trusted the leftmost (client-written) `X-Forwarded-For` entry when `TRUST_PROXY=true`. Behind Cloud Run or Vercel, a client could forge its IP to get around per-IP rate limits.

**Fix:** `server/src/lib/client-ip.ts` counts trusted hops **from the right** (`TRUSTED_PROXY_HOPS`).
- **Optional chain validation:** `TRUSTED_PROXY_CIDRS` requires the socket peer to be in a trusted range. `TRUSTED_PROXY_SECRET` requires the outermost proxy to send `x-traced-proxy-auth`; a request that bypassed that proxy (for example, one calling the Cloud Run URL directly) loses that hop.
- **Secure fallback:** if the chain is short or malformed, the nearest address written by a trusted proxy is used, never client input. Only the right-hand 2 KB of the header is parsed.
- **Production:** `TRUSTED_PROXY_HOPS` must be set explicitly, and the legacy `TRUST_PROXY` is refused.
- **Test harnesses:** the E2E and Vitest harnesses hard-code one hop in their own config objects.
- Rate limiting and account lockout are unchanged.

Deployment values and the Phase 8 verification procedure are in `docs/architecture.md` §2a.

**Tests:** spoofed leftmost entries, Vercel→Cloud Run chains, a bypassed outer proxy, untrusted peers, malformed and very long headers, config rules, and an end-to-end check that 11 sign-ups with forged addresses still hit the per-IP limit.

## 5. Completed functionality

**Admin access.** Dedicated sign-in (`/traced/admin/sign-in/`), invitation acceptance, two-step setup (QR rendered by our server plus a manual key, then 10 one-time recovery codes), two-step verification (app or recovery code), password reset through the existing flow, settings, and sign-out.
- **Navigation:** built from the account's permissions.
- **Page guards:** each admin page also checks its own permission ("No access" otherwise).
- **Routing:** privileged accounts opening customer pages are sent to the admin portal. Customers and collection staff get "No access", and the API returns 403.

**Dashboard** (`stats.read`).
- Customer accounts, registrations, awaiting collection, samples collected, active collection staff, active branches and failed emails.
- Today, this month and a chosen date range (Asia/Riyadh).
- Status distribution, per-branch figures, and recent staff/admin activity (event and role only).
- All figures are live database aggregates.

**Registrations** (`registration.read_full`; changes need `registration.manage`).
- **Search:** tracking ID, patient name, customer name, email or mobile, with status, QR, branch and date filters and keyset pagination. Rate-limited to 300/h.
- **Search auditing:** each search is audited with the search type, a keyed hash of the term and the result count, never the readable term.
- **Full record view** (audited as `registration.viewed_full` with the fields accessed):
  - patient, guardian, account holder and contact snapshot;
  - consents, status history, branch transfers;
  - QR lifecycle (no tokens);
  - collection and identity events;
  - decrypted correction history;
  - related emails.
- **Branch transfer** (before collection; reason required; active target branch only):
  - updates the branch and records an append-only transfer row (from, to, who, when, why);
  - closes open collection sessions, so staff must rescan and re-verify;
  - writes an audit event, emails the customer (new bilingual template without patient data) and shows a notice on the customer's registration page;
  - keeps the tracking ID.
- **Cancellation** (before collection; reason required): revokes the QR, closes sessions and records status history. The tracking ID is never reused.
- **Patient correction** (before collection; reason required): reuses the existing correction service, so previous values stay encrypted in `patient_revisions`, identity verification becomes stale and open sessions are closed. Corrections are refused after collection.

**Customer accounts.**
- Audited view.
- **Lock:** status set to suspended with a reason; all sessions revoked.
- **Unlock:** reason required; also clears a temporary failed-sign-in lockout.
- **Resend verification:** unverified accounts only.
- No deletion or deactivation.

**QR management** (`qr.revoke`: admin and super admin).
- Revoke with a mandatory reason, optionally issuing a replacement and emailing the customer (existing lock-safe lifecycle service).
- Resend the QR email (reason required).
- History view without tokens.
- A used QR can't be replaced or resent.

**Staff** (`staff.manage` / `admin.manage`).
- **Invitations:** email, name, roles, branches and language, sent as an atomic invite email through the outbox; pending invitations can be resent (the old link dies).
- **Changes:** roles, branches (multiple), and activate / suspend / deactivate (deactivation is permanent).
- **Visibility:** security status (MFA, temporary lock, failed sign-ins, password change, sessions) and recent activity.
- **Guards:**
  - Admins may grant only collection staff and lab operator roles; super admins may grant all staff roles.
  - Nobody can change their own roles or status, and customers can't be turned into staff.
  - The actor's authority is re-read inside the transaction.
  - The last active super administrator can't be suspended, deactivated or demoted, even by two super admins acting at the same moment (tested).
- Privilege and status changes revoke the person's sessions.

**Branches** (`branch.manage`).
- Create (the code is permanent), edit EN/AR names, cities, addresses and order, activate and deactivate (reason required).
- Deactivating a branch that still has registrations awaiting collection needs an explicit acknowledgement, then a transfer.
- Inactive branches don't appear in new registrations, and collection there is blocked.
- Branches are never deleted.
- Per-branch figures and assigned staff are shown.
- Synthetic `[DEV]` branches only.

**Collection instructions** (drafts: `instructions.draft` for admin and super admin; publishing: `form.approve`, super admin only).
- Bilingual drafts: steps and a checklist with matching IDs, optional notes, and a copy of the latest version as a starting point.
- **Workflow:** submit → super admin returns it or publishes it.
- **Publishing:** creates immutable EN and AR versions (optional future effective date). Earlier versions and the version stored on each sample never change.
- **Clinical approval:** publishing is explicitly **not** clinical approval. A version is "approved" only when the super admin records the reference of the laboratory and management approval obtained outside the system; otherwise it is provisional, and production keeps refusing provisional instructions.

**Email monitor** (`email.manage`).
- Queued, sent and failed counts with filters.
- Shown per email: type, masked recipient, attempts, last attempt or next retry, provider message ID, and the last error with email addresses scrubbed.
- Never shown: bodies, payloads or tokens.
- **Retry:** only for failed emails whose content is rebuilt from the database (registration confirmation, QR resend, password changed). Emails with one-time links can't be retried, because their links are erased; the admin uses resend invitation or resend verification instead. Retries are audited.

**Audit log** (`audit.read`).
- Filters: date range, area, exact event, outcome, responsible account (email filter only with personal-data permission), resource type and resource ID. Keyset pagination.
- Read-only: there are no edit or delete routes, and the database rejects changes.
- **Auditors** see entries without IP addresses, actor emails or free-text reasons (shown as "[redacted]").

**Operational export** (`report.export`).
- Daily registrations, collections and cancellations per branch.
- Contains no names, contacts, dates of birth or tracking IDs.
- Protected against formula injection, UTF-8 with BOM, range limited to one year, and audited.
- Personal-data exports are deferred to Phase 7 as approved.

## 6. Database: migration `0008_admin_portal.sql` (additive)
- **Permissions:** `instructions.draft` permission granted to admin and super admin.
- **`users`:** `status_reason`, `status_changed_at`, `status_changed_by`.
- **`registration_branch_transfers`:** append-only; triggers block update, delete and truncate.
- **`collection_instruction_drafts`:**
  - drafts are editable;
  - published or withdrawn drafts are frozen by a trigger;
  - drafts are never deleted.
- **`collection_instructions`:** adds `draft_id`, `published_by` and `approval_reference`. The existing immutability trigger is unchanged.
- **`email_outbox`:** new kind `registration_branch_changed`.
- **Indexes:** for admin search, filters and pagination.
- Migrations 0001–0007 are untouched. The local dev database applies 0008 on the next `npm run dev`.

## 7. API endpoints (all under `/api/v1/admin`, MFA required)

| Endpoint | Permission |
|---|---|
| `GET /stats` | `stats.read` |
| `GET /registrations`, `GET /registrations/:id` | `registration.read_full` |
| `POST /registrations/:id/transfer`, `/cancel`; `PATCH /registrations/:id/patient` | `registration.read_full` + `registration.manage` |
| `POST /registrations/:id/qr/revoke` (Phase 4), `/qr/resend-email` | `qr.revoke` |
| `GET /customers/:id` | `registration.read_full` |
| `POST /customers/:id/lock`, `/unlock`, `/resend-verification` | `registration.read_full` + `registration.manage` |
| `GET /staff`, `GET /staff/:id`, `POST /staff`, `POST /staff/:id/resend-invite`, `PUT /staff/:id/roles`, `PUT /staff/:id/branches`, `POST /staff/:id/status` | `staff.manage` or `admin.manage` (role limits as in §5) |
| `GET /branches`, `POST /branches`, `PATCH /branches/:id`, `POST /branches/:id/status` | `branch.manage` |
| `GET /instructions`, `POST /instructions/drafts`, `PUT /instructions/drafts/:id`, `POST …/submit`, `POST …/withdraw` | `instructions.draft` |
| `POST /instructions/drafts/:id/return`, `POST …/publish` | `form.approve` |
| `GET /emails`, `POST /emails/:id/retry` | `email.manage` |
| `GET /audit-logs` (extended filters, redaction) | `audit.read` |
| `GET /reports/operational.csv` | `report.export` |

Other changes:
- `POST /auth/mfa/setup` now also returns `qrImage` (a PNG data URL rendered on our server).
- `GET /me/registrations/:id` adds `branchChangedAt`.

## 8. Frontend routes (EN; Arabic under `/ar`)
`/traced/admin/` (dashboard) · `sign-in/` · `two-step/` · `registrations/` · `registration/?id=` · `customer/?id=` · `staff/` · `staff-member/?id=` · `branches/` · `instructions/` · `emails/` · `audit/` · `settings/` · `accept-invite/` (Phase 4, now links to admin sign-in).

That makes 26 new page shells. The total is now 62 portal shells, and every existing shell was regenerated for the asset version bump. **No existing public TRACED page was modified** (`check:portal`: all 56 TRACED pages patched exactly as before).

## 9. Permission changes
- **Added:** `instructions.draft` → admin, super admin (justification: admins prepare drafts; publishing remains super admin only via the existing `form.approve`).
- **No other changes:**
  - Auditors keep `audit.read`, `stats.read` and `report.export`.
  - Collection staff and lab operators have no admin permission.
  - `report.export_pii` remains super admin only and unused until Phase 7.

## 10. Screenshots (`docs/phase-5/screenshots/`, synthetic data)
| | | |
|---|---|---|
| ![](phase-5/screenshots/01-admin-sign-in-en.png) Admin sign-in | ![](phase-5/screenshots/02-admin-mfa-setup-en.png) Two-step setup | ![](phase-5/screenshots/03-admin-recovery-codes-en.png) Recovery codes (masked) |
| ![](phase-5/screenshots/04-admin-dashboard-en.png) Dashboard | ![](phase-5/screenshots/05-registrations-search-en.png) Registration search | ![](phase-5/screenshots/06-registration-record-en.png) Full record |
| ![](phase-5/screenshots/07-registration-after-actions-en.png) After transfer, correction, QR revoke | ![](phase-5/screenshots/08-customer-branch-changed-en.png) Customer sees branch change | ![](phase-5/screenshots/09-staff-list-invite-en.png) Staff list + invite |
| ![](phase-5/screenshots/10-staff-member-en.png) Staff account (suspended) | ![](phase-5/screenshots/11-branches-en.png) Branches | ![](phase-5/screenshots/12-instructions-en.png) Instructions (published provisional) |
| ![](phase-5/screenshots/13-email-monitor-en.png) Email monitor | ![](phase-5/screenshots/14-audit-log-en.png) Audit log (admin) | ![](phase-5/screenshots/15-audit-log-auditor-en.png) Audit log (auditor, redacted) |
| ![](phase-5/screenshots/16-admin-dashboard-ar.png) Arabic dashboard | ![](phase-5/screenshots/17-registration-record-ar.png) Arabic record | ![](phase-5/screenshots/18-staff-ar.png) Arabic staff |
| ![](phase-5/screenshots/19-mobile-dashboard.png) Mobile dashboard | ![](phase-5/screenshots/20-mobile-registrations.png) Mobile registrations | |

## 11. Test results
See §16 for the final run of this phase. New in Phase 5:
- **`server/test/proxy.test.ts` (12 tests):** client-IP resolution, configuration rules and rate-limit bypass attempts.
- **`server/test/admin.test.ts` (33 tests):**
  - **Access:** the matrix of 30 endpoints across collection staff, lab operator, customer and anonymous users (every denial audited); MFA setup and verification required; auditor scope; `/auth/me` permissions.
  - **Dashboard:** statistics deltas from real events.
  - **Search and records:** search by all five keys with hash-only audit; pagination and cursor validation; the full record without tokens.
  - **Changes:** transfer (validation, sessions closed, email, customer view, collection only at the new branch, refused after collection); cancellation; correction (encrypted history, stale identity, locked after collection).
  - **Customers:** lock and unlock; temporary lockout cleared; staff accounts refused; resend verification.
  - **QR:** revoke and replace; refused when used.
  - **Staff:** invitation to working account; escalation attempts; self-change; customer-to-staff refused; role, branch, status and session effects; resend invite; last super admin (concurrency plus a direct rule test).
  - **Branches:** CRUD rules, deactivation with pending registrations, hidden from new registrations, collection blocked, transfer then collect, no deletion.
  - **Instructions:** draft, submit, return, publish (provisional vs approved with reference), immutability, sample keeps its version, withdraw.
  - **Emails:** masking, scrubbing, retry rules.
  - **Audit and export:** audit filters and auditor redaction, read-only; CSV safety.
  - **Privacy:** canary sweep for collection staff.
- **`server/test/e2e/admin.spec.ts` (6 browser tests):**
  - invitation → password → sign-in → MFA enrolment → dashboard;
  - browser access control (signed-out, customer, collection staff, admin without MFA);
  - registration search, record, transfer, correction and QR revoke, plus the customer notice;
  - staff invite, branch change and suspension;
  - branches, instructions (admin drafts, super admin publishes), email monitor, audit log, and the auditor's redacted and limited view;
  - Arabic RTL, and 375 px mobile with no horizontal scrolling on 8 admin pages.

## 12. Security and patient-privacy verification
- **Staff privacy unchanged:** collection staff receive age and gender only. New tests:
  - every admin endpoint returns 403 to collection staff, with no canary data in the response;
  - the staff scan view keeps the exact Phase 4 key set after admin changes.
- **Every admin endpoint:**
  - authentication, permission and MFA via `requirePermission` (denials audited);
  - object checks, explicit response field lists, `no-store`, CSRF unchanged;
  - rate limits on searches, views and every change.
- **Personal data:** visible only to `registration.read_full` holders (admin, super admin). Searches are audited by keyed hash and record views with the fields accessed. Free-text reasons, IPs and emails are hidden from auditors.
- **Secrets:** no raw QR tokens, email tokens or payloads in responses, audit or logs (QR history has no tokens; the email monitor selects no payloads; recipients are masked).
- **Privilege escalation:** role ceilings, self-change refusal, authority re-read in the transaction, and a race-safe last-super-admin guard.
- **CSV:** formula injection neutralised (all six prefixes tested).
- **Audit chain:** still tamper-evident only (hardening is Phase 7).

## 13. Defects found and fixed during Phase 5
1. **Last-super-admin guard race** (found by the concurrency test): two super admins demoting each other at the same moment both succeeded. After waiting for a row lock, PostgreSQL re-checks only the locked rows, not the joined `user_roles` rows. **Fix:** take the locks first, then re-read state with fresh statements and re-derive the actor's authority from the database. Now exactly one change succeeds and the other is refused.
2. **Invite success message wiped** by the list reload (UI). Fixed.
3. Auditor opening an admin page outside their permissions saw a form with an error. **Fix:** page-level permission guard showing a clear "No access" message.
4. Test-only issues: name tags with digits, branch-order dependence between tests, BOM stripped by `Response.text()`.

## 14. Known limitations
- **Test harness (Windows):** an orphaned embedded-PostgreSQL worker can survive a run. It no longer blocks the next run (per-run data directory, §16a), but it stays alive until stopped; a fuller clean-up is proposed for Phase 7.
- **Screenshots:** MFA secrets, recovery codes and customer QR codes are masked or redacted (§16b).
- **Physical devices** (phones, tablets, USB scanners) are still untested; the admin portal was tested in Edge desktop and simulated 375 px only.
- **Arabic** admin wording needs professional review (machine-assisted by the developer).
- **Instructions:** published only provisionally in tests; no approved clinical content exists.
- **Lab operators** can sign in but have no portal pages until Phase 6 (the server refuses admin endpoints).
- **Admin statistics** are computed on request. That's fine at about 100 registrations a month; revisit at scale (Phase 7 performance testing).
- **Email retry** isn't available for one-time-link emails, by design.
- **GitHub:** the repository is still public, and its default branch is `feature/traced-portal`.

## 15. Production blockers (unchanged unless noted)
Repository visibility; approved identity-verification method; approved consent wording and clinical instructions; Arabic review; Resend/Vercel data-transfer approval and sending domain; real Wareed branches; device validation; audit-log hardening, backups and micro-instance validation (Phase 7); provisioning and deployment authorisation (Phase 8); real proxy-chain verification (`docs/architecture.md` §2a).

## 16. Final verification (26 Nov 2026, after the owner's finalisation instructions)
| Check | Result |
|---|---|
| TypeScript typecheck | clean |
| Static portal checks | 62 portal shells up to date; all 56 TRACED pages patched exactly as before (no public page changed) |
| Unit + integration (Vitest, real PostgreSQL) | **200 / 200**: the expected 199 (154 Phases 1–4 + 12 proxy + 33 admin) plus 1 new evidence check (no committed screenshot contains a decodable QR token or MFA code) |
| Browser tests (Playwright, Edge) | **22 / 22**: 9 customer + 7 collection staff + 6 admin |
| `npm audit` | 0 vulnerabilities |
| Secrets / sensitive-data scan of tracked files | no API keys, private keys, credential URLs, `#token=` links, `c1_` QR tokens, `.env`, local databases, mail captures or test results; only `example.com` test addresses, the published support address and documentation placeholders |

**Browser test count, reconciled:** the correct total is **22** (9 + 7 + 6, all listed in the Playwright output). An earlier progress message said 23. That was my arithmetic slip, not a skipped or removed test.

**Final frontend changes verified by the passing browser run:** mobile table layout (8 admin pages at 375 px, no horizontal page scroll); English and Arabic labels (Arabic RTL admin pages, the translation-key tests); admin page permission checks (an auditor on an admin page gets "No access"); collection-staff restriction (browser: "No access" on three admin pages, API 403); customer branch-transfer notice; MFA enrolment (QR, code, recovery codes) and verification redirect; administrative actions (transfer, correction, QR revoke, staff invite, branch change, suspension, branch create and deactivate, instruction draft → submit → publish).

### 16a. Browser-test harness: Windows orphan process
**Issue.** On Windows, Playwright force-kills the E2E server at the end of a run, so its cleanup may not run. An embedded-PostgreSQL `io_worker` can survive as an orphan (its parent no longer exists) and keep files in its data directory open. The server used one fixed data directory and deleted it on start, so the next run failed with "Timed out waiting … config.webServer". This happened twice during Phase 5. With the owner's approval, the orphan (PID 35920, `…\Traced Website\node_modules\@embedded-postgres\…\postgres.exe --forkchild="io_worker"`, parent gone, not the dev database) was stopped. At the final check no orphan existed: every `postgres.exe` belonged to the development database (`-D …\.dev-db\data -p 54329`, parent alive), and none was stopped.

**Fix (small, implemented and tested).** `server/test/e2e/serve.ts` now uses a fresh directory per run (`test-results/e2e-pg/run-<time>-<random>`) and removes earlier runs' directories best-effort. A directory still held open is skipped and removed by a later run. **Test:** a leftover run directory containing a file held open with an exclusive lock by a separate process (deletion confirmed to fail with "resource busy") was present during the final runs. The suite still started and passed 22/22, and the locked directory was simply skipped. A larger harness rework (per-run ports for everything, killing orphans) is deferred to Phase 7.

### 16b. Screenshot sanitisation
- **MFA setup screenshot:** the authenticator key is replaced with `XXXX …` and the QR is blurred before capture. **Recovery codes screenshot:** codes replaced with `XXXXX-XXXXX` before capture.
- **Customer QR codes:** screenshots of the customer portal and confirmation emails (Phases 3–5) showed decodable QR codes that encode QR tokens. The tokens belonged to throwaway test databases deleted after each run, but they were sanitised anyway. A new helper `server/test/e2e/redact-qr.ts` finds every decodable QR whose content is sensitive (`/traced/c/`, `c1_`, `otpauth:`, `token=`) and paints over it with a hatched grey box. All screenshot helpers now run it automatically, it was applied once to all 114 committed screenshots (13 customer QR codes redacted), and the new evidence test fails if any committed screenshot still contains one. A false positive in one admin screenshot during development was fixed by redacting only sensitive content.
- No other screenshot contains credentials or tokens. Addresses are synthetic (`example.com`); IPs are synthetic `10.x` test addresses.

### 16c. Security confirmations
- **Trusted proxy:** still fixed. `server/test/proxy.test.ts` (12 tests) passes: leftmost entries ignored, bypassed outer proxy loses a hop, untrusted peers ignored, forged addresses still rate-limited.
- **Production proxy config:** requires an explicit `TRUSTED_PROXY_HOPS` (startup fails otherwise) and refuses the legacy `TRUST_PROXY` (tested).
- **Collection staff:** still receive only patient age and gender. Tested by the Phase 4 allowlist tests, the Phase 5 canary sweep over every admin endpoint, and the exact scan-view key set after admin changes.
- **Admin permissions:** enforced on all 30 admin endpoints for every role (matrix test, every denial audited) and on admin pages in the browser.
- **MFA:** mandatory. Admin endpoints return `MFA_SETUP_REQUIRED` / `MFA_REQUIRED`, and admin pages redirect to two-step verification (API and browser tests).
- **Last active super administrator:** protected (rule test). Two super admins demoting each other simultaneously leaves exactly one super admin (concurrency test).
- **Test artifacts:** no real patient information; all names, emails and phones are synthetic.

## 17. Completion
**Phase 5: complete for the approved scope.** Engineering completion is about **65%** (Phases 0–5 ≈ 225 of ≈ 300–390 hours, by the Phase 0 estimates; business, legal and clinical approvals excluded).

## 18. Recommended Phase 6 scope (requires approval)
The detailed plan with decisions, transition matrix, tests and hour estimate is in **`docs/phase-6-plan.md`** (≈ 41–52 h). Summary:
- **Physical sample identity:** a physical sample ID (`samples.sample_code`) and a separate secure sample QR token; bilingual, printable labels with the TRACED brand, tracking ID, sample ID and QR, with no personal data; audited reprints.
- **Custody model:** the approved transition model over the existing statuses, with a role per transition. For example: branch staff package, mark ready and dispatch; transport or branch hands over; the lab receives, analyses and completes; admins correct by appending events.
- **Custody records:** append-only `custody_events` (previous and new status, actor, location, handover details, remarks) with two-sided handovers where the workflow requires them; rejection and damage reporting.
- **Lab portal:** lab-operator pages (scan the sample QR, receive, update analysis status).
- **Views:** the customer timeline (no internal or staff details); the full admin custody history; staff scans of physical samples still limited to age and gender.
- **Tests:** transition-matrix tests, concurrency on handovers, and privacy sweeps for sample scans and labels.
