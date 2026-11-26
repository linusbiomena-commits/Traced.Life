# TRACED Platform: Phase 3 Report

Tracking IDs, QR engine, email delivery and dashboard integration · 26 November 2026 · branch `feature/traced-portal`. Developed and tested locally; **not deployed**. Committed and pushed to `feature/traced-portal` under the standing authorisation (commit ID in the handover message).

## 1. Phase 2 decisions applied

| Decision | Implementation | Tested |
|---|---|---|
| Gender: Male / Female | Unchanged (already enforced in API + DB). Subject to lab confirmation. | `decisions.test.ts` |
| Account holders 18+ | Sign-up requires an "I confirm that I am 18 years of age or older" checkbox (EN/AR); stored as `users.adult_confirmed_at`. Self-registration still requires 18+. | `decisions.test.ts`, E2E |
| No arbitrary minimum patient age | None exists; a 10-day-old child registers successfully. "My child" means under 18 by definition. | `decisions.test.ts` |
| Corrections before collection, history preserved, no silent changes after collection | New `PATCH /me/registrations/:id/patient` plus "Correct details" on the registration page. Previous values go to the **append-only, encrypted `patient_revisions`** table; the audit records field names only. Once any registration of the patient passes "awaiting sample collection", changes are refused with `PATIENT_LOCKED`, including the earlier implicit update when "myself" registered again. | `decisions.test.ts` |
| Header label "My Account" / "حسابي", mobile icon kept | All 56 pages updated by the idempotent patch script; the header still fits at 360/375/390/768 px. | E2E |
| Footer Account link → local portal | Already done in Phase 2; kept. | E2E |
| No National ID / Iqama / nationality | Unchanged; the API rejects such fields. | `registrations.test.ts` |
| Consent texts provisional; Arabic needs professional review | Unchanged; production refuses provisional consents and requires the Resend transport. | — |

## 2. Git

- Phases 1–2 committed and pushed before Phase 3 work: **`cdcb44d`** → `origin/feature/traced-portal`.
- Pre-push checks performed: branch is `feature/traced-portal`; the repository has **no deployment configuration** (no `vercel.json`, `.vercel/`, Netlify or CI workflow files); `.env`, `.dev-db/`, `.dev-mail/`, `test-results/` and `node_modules/` are gitignored and were confirmed absent from the commit; a staged-diff secret scan found only test fixtures; typecheck and tests were green.
- **Not verifiable from here:** whether the GitHub repository `linusbiomena-commits/Traced.Life` has been connected to Vercel (or another host) in a web dashboard. The Vercel connector isn't authorised in this session. No secrets or production data exist in the repository either way. Please confirm no preview/production deployment is attached to this repo.

## 3. Tracking IDs: `TRC-SA-MM/YY-XXXXX`

- **Allocator:** `allocate_tracking_id()` in PostgreSQL (migration 0005, fix in 0006). It upserts the month's counter in `tracking_sequences` inside the registration transaction; the row lock serialises concurrent registrations. The month is computed **in Asia/Riyadh time** in the database.
- **Uniqueness at DB level:** `UNIQUE(tracking_id)`, `UNIQUE(tracking_period, tracking_seq)`, a format CHECK, and a new CHECK that the ID equals exactly the formatted period + sequence.
- **Monthly reset:** one counter row per `YYMM`, so a new month starts at 00001.
- **Exhaustion:** past 99,999 the allocator raises `TRX01`. The API returns `503 TRACKING_CAPACITY_REACHED`, the whole registration rolls back, and the counter stays at 99,999 (nothing saved, nothing duplicated, no wraparound).
- **Never reused:** counters only increase; registrations can't be deleted (new trigger); cancelled registrations keep their ID. A rolled-back allocation is never issued.
- **One ID per registration, including retries:** the same Idempotency-Key returns the original registration without touching the counter (6 concurrent identical submissions → counter +1).
- **Deadlock avoided:** the counter is locked before any audit write, so all transactions take locks in the same order (found during implementation).
- **Display vs filenames vs URLs:** displayed with the slash; filenames use `TRC-SA-11-26-00001`; URLs use the percent-encoded form; APIs address registrations by UUID only. The tracking ID is **not** a credential (validation refuses it).

**Example IDs from the test runs:** `TRC-SA-11/26-00001`, `TRC-SA-11/26-00002` (current month); `TRC-SA-03/31-…` → `TRC-SA-04/31-00001` across the Riyadh midnight of 31 March (20:59:59 vs 21:00:00 UTC); `TRC-SA-12/31-00001` → `TRC-SA-01/32-00001` across the year; `TRC-SA-02/34-99999` (last of a month, the next is refused); `TRC-SA-08/35-00001` (backfilled legacy registration in its original month).

**Migration strategy for Phase 2 registrations without an ID:** `npm run backfill:phase3` processes them oldest first, one transaction each (idempotent, restartable). Each gets an ID in the Riyadh month of its **original** registration date, a QR token, a move to "awaiting sample collection" with an explanatory history row, and an audit entry. Emails are sent only with `--send-emails` (deduplicated). Run it right after migrations 0005/0006 and before opening Phase 3 registration. (No such rows exist yet: production has never been deployed, and your local dev database has 0 registrations.)

## 4. QR engine (internal, open source)

- `qrcode` 1.5.4 (MIT) on the server; no external QR service. Tokens come from Node `crypto.randomBytes(32)`, i.e. **256 bits**, prefixed `c1_` (customer type; future sample labels will use `s1_` in their own table).
- **Content:** only `https://<site>/traced/c/#c1_<token>`. No name, email, phone, date of birth, medical data or tracking ID. The token sits in the URL fragment, which browsers never send to servers. A phone camera opens a static page that strips the token from the address bar immediately, sends nothing and shows no data. **There is no public QR lookup.**
- **Storage:** an HMAC-SHA256 of the token for validation (unique), plus an AES-256-GCM encrypted copy (bound to the registration) so the same QR can be redisplayed and downloaded. Token fields are immutable; tokens can't be deleted; a revoked token can't be reactivated (DB triggers); one active token per registration (partial unique index).
- **Downloads:** PNG and SVG (`?download=1` for attachment), owner-only, `no-store`, strict CSP; SVG output is checked for scripts and handlers.
- **Revocation / regeneration:** "Replace QR code" (customer, before collection, 3/day) revokes the old token for good, issues a new one and emails it. The tracking ID stays the same.
- **Staff validation service (ready for Phase 4):** `POST /api/v1/staff/qr/validate`. It requires `collection.scan`, **and** an active assignment to the registration's branch (new `staff_branch_assignments` table), and is rate-limited. The response is built by one explicit allowlist function: `qrValid, trackingId, patientAge, patientGender, sampleType, sampleStatus, collectionInstructions (provisional), identityVerification {status: 'not_available'}`. Invalid/unknown/revoked/cancelled → `{qrValid:false, reason}` only. Every validation is audited with the field names accessed.

## 5. Email

- **Phase 1 abstraction reused:** `Mailer.send()` gained optional inline attachments and returns `{provider, messageId}`; `sendMailInBackground()` keeps its signature but now goes through the outbox.
- **Transactional outbox (`email_outbox`):** the confirmation email is written in the same transaction as the registration, so registration succeeds even if the provider is down. A background worker (interval `OUTBOX_INTERVAL_MS`, plus an immediate kick) sends with `FOR UPDATE SKIP LOCKED`, retries with backoff (1 min, 5 min, 15 min, 1 h, 6 h; max 6 attempts), recovers emails stuck by a crash, marks permanent provider errors as failed immediately, and stores status, attempts, last error and **provider message ID**. A unique `dedupe_key` prevents duplicate automatic emails. One-time links are encrypted in the queue and erased once sent; the QR image is rendered at send time from the current token, never stored.
- **Resend transport** (REST, no SDK), following Resend's documented API: `POST https://api.resend.com/emails` with Bearer auth, the required `User-Agent`, an `Idempotency-Key` per outbox row (Resend keeps keys for 24 h), and the QR as an inline attachment (`content_id: traced-qr`). 429/5xx/network errors are retried; other 4xx are permanent. **Not configured:** no account, key or domain was created or purchased. Production refuses to start without `MAIL_TRANSPORT=resend` + key + sender.
- **Templates (EN + AR, RTL), branded:** verification, account exists, reset, password changed, staff/admin setup, **registration confirmation**, **QR resend**. The registration email contains a greeting (account holder/guardian name), confirmation, tracking ID, scannable QR, branch, instructions, dashboard link and support contacts. **No patient name, date of birth or phone** (tested).
- **Customer resend:** "Email me the QR code again", limited to 3/hour per registration and 10/day per account. Delivery status is shown on the registration page.
- **Local capture kept:** the dev transport writes `.html` previews (QR embedded), `.txt` and the `.png` to `.dev-mail/`.

Previews: `docs/phase-3/screenshots/15-email-registration-confirmation-en.png`, `25-email-registration-confirmation-ar.png`.

## 6. Customer portal changes

- **Confirmation / details page:** "Registration successful", tracking ID, QR image, Download PNG / SVG, "Email me the QR code again" + email status, collection instructions, status and history, branch, patient (with "Correct details", locked after collection), contact, collection, consents. The Phase 2 "not available yet" placeholders are gone.
- **Dashboard:** "My QR codes" lists each active registration's QR thumbnail, tracking ID and a download link; "Sample tracking" shows tracking IDs.
- **QR landing page** `/traced/c/` and `/ar/traced/c/`.
- Bilingual, responsive (checked at 375 px in EN and AR), same TRACED styling.

## 7. Database migrations

- `0005_tracking_qr_email.sql` (additive): `users.adult_confirmed_at`; `patient_revisions` (append-only); `tracking_sequences` + `allocate_tracking_id()`; `customer_qr_tokens` (+ immutability/no-delete triggers); `staff_branch_assignments`; `email_outbox`; no-delete trigger on `registrations`; tracking-ID consistency CHECK.
- `0006_fix_allocate_tracking_id.sql`: replaces the allocator after an ambiguous-column bug found by the tests (0005 was already applied to your local DB, so it wasn't edited).

## 8. API endpoints (new in Phase 3)

| Endpoint | Access |
|---|---|
| `GET /me/registrations/:id/qr.png`, `GET /me/registrations/:id/qr.svg` (`?download=1`) | verified customer, owner only |
| `POST /me/registrations/:id/resend-email` | owner; 3/h per registration, 10/day per account |
| `POST /me/registrations/:id/qr/regenerate` | owner; before collection; 3/day |
| `PATCH /me/registrations/:id/patient` | owner; before collection |
| `POST /staff/qr/validate` | `collection.scan` + branch assignment |

Changed: `POST /auth/sign-up` now requires `confirmAdult: true`; `POST /me/registrations` returns the tracking ID and QR info; registration detail adds `qrCode`, `email`, `canCorrectPatient`, `canRegenerateQr`, `canResendEmail`. The API now has 27 routes in total.

## 9. Test results

| Suite | Result |
|---|---|
| TypeScript typecheck | **clean** |
| Unit + integration (Vitest, real PostgreSQL 18) | **129 / 129 pass**: the 86 existing (6 Phase 2 assertions updated because tracking ID/QR now exist) + **43 new**: tracking 13, QR 12, email 12, decisions 6 |
| Browser E2E (Playwright, Edge) | **9 / 9 pass** (≈ 80 s), updated for Phase 3 |
| Portal/navigation generation checks | pass |
| `npm audit` | 0 vulnerabilities |

Your requested coverage:

| Area | Where |
|---|---|
| Tracking-ID format, concurrency (200 direct + 24 concurrent API registrations), Riyadh boundary, monthly reset, year rollover, exhaustion (DB + API), cancelled not reused, rollback not issued, duplicate protection | tracking |
| Migration backfill | tracking |
| QR generation **and decoding** (jsQR), token uniqueness (2,000), ownership, revocation, unauthorised validation, allowlist, tracking ID rejected as credential | QR |
| PNG/SVG downloads (types, signatures, slash-safe filenames, no-store) | QR, E2E |
| Automatic email, retry/backoff, max attempts, permanent errors, crash recovery, dedupe, resend rate limit, EN/AR templates, Resend request format | email |
| Personal-data leakage | QR (QR content, audit, outbox, JSON), email (no patient data), staff sweep over all 27 routes |
| Dashboard QR rendering, mobile responsiveness | E2E (QR image loaded; 375 px EN/AR incl. QR page; header 360–768 px) |
| **Full local flow:** sign-up → email verification → sign-in → registration → tracking ID → QR → dashboard → email via test mailer → QR PNG download decoded | E2E "English" (Arabic flow covers the AR email) |

Defects found by the new tests and fixed: the ambiguous allocator column (0006); a potential lock-order deadlock between the tracking counter and the audit chain; flaky email assertions caused by asynchronous delivery (tests now wait deterministically); the nav-patch script trying to patch the new QR page; spacing on the details page.

## 10. Security checks

- Collection-staff privacy: explicit allowlist + branch authorisation + all-routes canary sweep (staff never see name, email, phone, DOB, account holder or tokens).
- QR tokens: 256-bit, hashed for lookup, encrypted at rest, never in audit, outbox, JSON, logs or URLs sent to servers (tested).
- Ownership on every new customer endpoint (404 for others, 401 signed out, 403 staff).
- Rate limits on resend, regenerate, corrections and staff validation.
- Email: dynamic values HTML-escaped (tested with `<script>`), no patient data, payload encryption, provider idempotency.
- Audit-log hardening: plan in `docs/audit-hardening-plan.md` and draft roles in `server/sql/production-roles.sql`. **The current chain is tamper-evident but not tamper-proof**; production verification is Phase 7.

## 11. Known issues and blockers

1. **Email provider not approved or configured.** Also note from Resend's documentation: *all Resend account data, logs and email metadata are stored in the United States regardless of sending region.* That needs PDPL/legal review before use, or an alternative provider. The free tier allows 100 emails/day and 3,000/month.
2. **Collection instructions** (portal, email and staff) are **provisional** until the lab/management approves them.
3. **Identity verification** is reported as `not_available` until the Phase 4 method is decided (OTP / Nafath later).
4. Branch assignments for staff can only be set in the database until the admin portal (Phase 5).
5. Consent texts and Arabic copy are still provisional (unchanged).
6. Portal JS sub-modules are not individually cache-busted (Phase 2 note still applies).
7. Hosting region and data residency are still undecided.

## 12. Decisions for you

1. Email provider: proceed with Resend despite US data storage, or choose a provider with Saudi/GCC storage; plus the sending domain.
2. Approved customer and staff collection instructions (EN + AR).
3. QR validity: should an unused customer QR expire (e.g. 90 days)? Currently it stays valid until revoked or collected.
4. Who may revoke QR codes besides the customer (admin tools come in Phase 5).
5. Approval to start **Phase 4** (collection staff portal and scanner) and the identity-verification approach for it.

## 13. Completion

**Phase 3: complete for its scope**, verified by 129 automated tests, 9 browser tests and 27 screenshots. **Overall: about 40%** by Phase 0 hour estimates (Phases 0–3 ≈ 135 of ≈ 300–390 h).
