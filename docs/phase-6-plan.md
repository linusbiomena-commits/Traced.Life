# TRACED Platform: Phase 6 Implementation Plan (Physical Sample Labels and Chain of Custody)

Status: **PROPOSED, awaiting approval.** Nothing in this plan has been implemented. Written 26 November 2026 on top of Phase 5 (`feature/traced-portal`).

## 0. Principles
- Reuse what exists:
  - the `samples` table and its statuses (migration 0007);
  - `registration_status_history`;
  - the audit service, the QR token pattern (256-bit random, HMAC lookup, encrypted for redisplay);
  - the zxing scanner, the staff portal shell, the admin portal, the outbox;
  - the explicit-allowlist response style.
- Additive migrations only (`0009_…`). No restructuring of completed modules.
- **Privacy:**
  - A physical label and a sample-QR scan never carry or return personal data.
  - Collection staff keep the age-and-gender-only rule.
  - The lab sees no patient identity at all (sample ID, tracking ID and operational data only).
  - Customers see a simplified timeline without staff names or internal remarks.
- No invented integrations: no courier APIs, LIS or lab instruments. Handover partners are recorded as typed text plus the account that recorded them.
- Every custody change is an append-only event. Corrections are new events, never edits.

## 1. Decisions needed before building (recommendations first)
1. **Sample ID format:** `TRS-SA-YYMM-XXXXXX` (random Crockford base32, not sequential, so a label can't be guessed from its neighbour) *or* a per-month sequence like tracking IDs. Recommended: random.
2. **Who records which transition** (recommended matrix in §4). In particular:
   - (a) Does transport have its own login? Recommended: no in Phase 6; branch staff record "dispatched" with the courier reference, and the lab records "received".
   - (b) Is `lab_operator` used now (it exists, with MFA)? Recommended: yes, for the lab-side steps.
3. **Label printer and size:** browser printing on A4 sticker sheets *or* a 50×25 mm thermal label. Recommended: support both through two print stylesheets, and validate with the real printer.
4. **When the label is printed:** immediately after "Confirm sample collected" (recommended) *or* later from history.
5. **"Report available" status:** is a report delivered through TRACED in a later phase, or only marked here? Recommended: status only; no report files in Phase 6.
6. **Rejection:** who can reject (lab only, recommended) and whether a rejected sample allows a recollection with a new sample on the same registration. The `samples` unique index already allows one live (non-rejected) sample per registration.

## 2. Workstreams

### 2.1 Physical sample identity and QR (staff portal)
- On successful collection (Phase 4 transaction), also:
  - allocate `samples.sample_code` (column exists, unique);
  - issue a separate sample QR token: new table `sample_qr_tokens`, mirroring `customer_qr_tokens` (HMAC lookup, encrypted value, active/revoked).
- The sample QR encodes `https://<origin>/traced/s/#<token>` (prefix `s1_`), distinct from the customer QR (`c1_`), so neither scanner accepts the other's code.
- Label page `/traced/staff/label/?sample=…` with print CSS (A4 sheet and thermal size). The label contains:
  - the TRACED wordmark;
  - the tracking ID and sample ID;
  - the sample QR;
  - the collection date (Riyadh) and the branch code.
  - **No** name, DOB, phone, email or age.
- Reprinting is audited (`sample.label_printed` with a reprint counter and reason after the first print) and rate-limited. PNG and SVG download of the sample QR.

### 2.2 Custody events and transitions (server)
- New append-only table `custody_events`:
  - registration, sample, tracking ID;
  - `from_status`, `to_status`, `occurred_at`;
  - `recorded_by`, `actor_role`, `location_type` (branch, transport, lab), `branch_id` or lab location;
  - handover counterpart (text, max 200), `verification` (method code, e.g. `label_scanned`), remarks;
  - `corrects_event_id` (for corrections).
  - Triggers reject update, delete and truncate.
- One service function `recordCustodyEvent()`:
  - lock order: registration → sample → audit;
  - validates the transition against a server-side matrix (§4) and the actor's permission and branch;
  - keeps `samples.status` and `registrations.status` in step and writes `registration_status_history` and audit;
  - idempotency key per request, so double-submitting can't create two events.
- Corrections: `custody.correct` (admin) appends a correcting event with a mandatory reason; the history shows both.

### 2.3 Scanning a physical sample
- **Staff portal:** "Scan sample" mode reuses the scanner and accepts only `s1_` tokens. It shows tracking ID, sample ID, sample status, branch, the allowed next actions, and age and gender (unchanged rule); nothing else.
- **Lab portal** (new, minimal, `lab_operator` with MFA, `custody.record_lab`), pages `/traced/lab/`:
  - scan or enter sample → receive (with a condition check: intact or damaged);
  - start analysis → complete analysis → mark report available;
  - reject (reason required);
  - lab history.
- Lab responses contain **no** age or gender (not needed) and no personal data.

### 2.4 Branch handover workflow (staff)
- From history or a scan: **package** → **ready for dispatch** → **dispatched** (courier or company name and reference, handed over by the current staff account). Batch selection of several samples for one dispatch.
- Where the workflow needs both sides of a handover, record both: the branch records "dispatched to X"; the lab records "received from X" with the label scan as verification. A mismatch (received without dispatched) is allowed but flagged for admins.

### 2.5 Admin custody views
- The registration record gains a custody timeline (all events, actors, locations, remarks, corrections).
- A custody dashboard with counts by status, "dispatched but not received after N hours" and rejections. Filters and pagination. Admin correction action (reason required).
- Audit-log areas for `custody` and `sample`.

### 2.6 Customer timeline
- `/me/registrations/:id` adds a simplified timeline: collected → sent to the laboratory → received by the laboratory → analysis in progress → completed → report available (or "issue with sample, we'll contact you").
- Dates only: no staff names, courier references, remarks or internal statuses.
- An optional email on "received by laboratory" and on rejection: the templates exist but are off until the wording is approved.

## 3. Database (migration 0009, additive)
- `samples`: no column changes needed (`sample_code` and statuses exist); possibly `label_print_count`.
- New tables:
  - `sample_qr_tokens`;
  - `custody_events` (append-only);
  - `sample_label_prints` (append-only reprint log, or audit only).
- Indexes for the lab queue, dispatch age and per-branch custody queries.
- New outbox kinds (disabled by default): `sample_received`, `sample_rejected`.
- Permissions: use the existing `custody.record_branch` (collection staff), `custody.record_lab` (lab operator, admin) and `custody.correct` (admin, super admin). **No new roles.** Possibly no new permissions.

## 4. Proposed transition matrix (to confirm)
| From → To | Who (permission) | Notes |
|---|---|---|
| awaiting_sample_collection → sample_collected | collection staff (`collection.collect`) | Phase 4 transaction, now also issues the sample ID, QR and label |
| sample_collected → sample_packaged | collection staff at that branch (`custody.record_branch`) | |
| sample_packaged → ready_for_dispatch | collection staff at that branch | |
| ready_for_dispatch → dispatched | collection staff at that branch | courier or company and reference required |
| dispatched → in_transit | optional; branch or admin | only if the operation needs it |
| dispatched / in_transit → received_by_laboratory | lab operator (`custody.record_lab`) | label scan required; condition intact/damaged |
| received_by_laboratory → analysis_in_progress → analysis_completed → report_available | lab operator | |
| any lab-side state → rejected | lab operator | reason required; customer notified (when approved) |
| any → (correction event) | admin (`custody.correct`) | reason required; appends, never edits |
| cancelled | admin, before collection only (Phase 5) | unchanged |

Anything not in the matrix is refused by the server, with a test for every forbidden pair.

## 5. Testing plan
- Unit and integration tests:
  - the full transition matrix (every allowed and forbidden pair for each role);
  - branch scoping;
  - idempotent double submits;
  - concurrent transitions (one wins);
  - corrections append only;
  - DB triggers reject edits;
  - sample QR vs customer QR separation;
  - reprint auditing.
- Privacy sweeps:
  - lab responses contain no personal data;
  - staff sample scans return age and gender only;
  - labels contain no personal data (render the label HTML and assert);
  - the customer timeline has no internal fields.
- Browser tests (simulated camera, as in Phase 4):
  - collect → label printed (print stylesheet snapshot) → package → dispatch → lab scan → receive → analysis → report available → customer timeline;
  - rejection path;
  - Arabic RTL and mobile.
- Regression: all 199 existing tests and 22 browser tests.

## 6. Delivery order and estimate
| Step | Hours |
|---|---|
| Migration 0009, sample ID and sample QR issuance inside collection, label page and print CSS, reprint audit | 8–10 |
| Custody service, transition matrix, append-only events, corrections, idempotency | 8–10 |
| Staff portal: scan sample, package, ready, dispatch (batch) | 5–6 |
| Lab portal (sign-in reuse, MFA, scan, receive, analysis steps, reject, history) | 6–8 |
| Admin custody timeline, dashboard, correction UI | 4–5 |
| Customer timeline (+ disabled notification templates) | 2–3 |
| Tests (integration, privacy sweeps, concurrency, browser), screenshots, report, handover | 8–10 |
| **Total** | **≈ 41–52 hours** |

The estimate assumes the §1 decisions follow the recommendations. A separate transport login, or report-file delivery, would add roughly 8–15 h each.

## 7. Out of scope for Phase 6
Personal-data exports, audit-chain hardening, OWASP/ZAP, load and backup testing, physical-device validation (Phase 7); provisioning and deployment (Phase 8); courier or LIS integrations; report-file storage and delivery; any change to approved consent or clinical content.
