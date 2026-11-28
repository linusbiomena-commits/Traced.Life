# TRACED: final user acceptance report (restricted pilot)

**Date:** 28 November 2026 · **Launch target:** 1 December 2026 · **Branch:** `feature/traced-portal`

**Environment:** https://www.tracedmena.life
- Restricted pilot gate is on.
- The API runs on Oracle Cloud Riyadh, `traced-app-1`, in preview mode against the isolated database `traced_preview`.
- Mail to `@preview.tracedmena.test` is captured on the server and never sent.
- The production database `traced` was not touched and still has 0 users.

**How it was tested:**
- Real-browser UAT in the Claude desktop browser pane against the deployed site, one synthetic account per role (run id `u1128`).
- The owner typed every password. No password, token, QR code or recovery code was written into this report, a log, a screenshot or GitHub.
- Links from captured mail were read on the server with `deploy/oci/vm/vm_18_captured_link.sh`, which refuses any non-synthetic address.

Statuses used: **Passed** · **Failed** · **Fixed and retested** · **Not tested** · **Blocked** · **Not implemented**.

## 1. Summary

| Area | Status |
|---|---|
| Admin Sign Out (reported bug) | **Fixed and retested** (fddcc9c: real root cause, regression tests for 6 roles, deployed, verified in browser) |
| Authenticated saves after the CSRF header fix (984320a) | **Passed**: every write in this UAT succeeded; no CSRF_REJECTED |
| Optional MFA (pilot only); production refuses `PILOT_MFA_OPTIONAL` | **Passed**: pilot sign-in for every role without two-step verification; config test proves production refuses to start with it |
| Fresh MFA for personal-data export | **Passed** (refused without enrolled authenticator, server-enforced). Successful export with a real fresh code: **Not tested**: owner asked to skip the MFA super admin test |
| Route inventory (76 portal routes EN/AR + 10 customer routes) | **Passed** |
| Pilot gate on every host | **Passed** |
| Customer journey | **Passed** |
| Collection staff journey | **Passed** |
| Laboratory journey (incl. rejection) | **Passed** |
| Recollection across portals | **Passed** (reject → authorise → new QR → awaiting collection); the second collection itself is covered by the deployed automated journey (vm_13, 61/61), not repeated by hand |
| Admin journey | **Passed** |
| Super admin journey (plain) | **Passed** |
| Auditor journey | **Passed** |
| Sign Out, every role in the browser | **Passed** (customer, collector, lab, admin, super admin, auditor) |
| Responsive (375 px) | **Passed** for public/sign-in/pilot pages in the browser; signed-in pages at 375 px covered by the automated e2e suite |
| Email checks | **Passed** (capture routing, masked monitor, failure handling); real delivery to external inboxes: **Not tested** (deliberately; no external emails sent) |
| Security regression | **Passed** (see §9), including the X-Forwarded-For spoofing check (§9.4) |
| Reproducible bugs found in this UAT | **None** beyond the Sign Out bug fixed before the UAT; observations listed in §10 |
| Physical devices (camera scan on phones, label printer) | **Not tested** (no hardware). Manual entry / USB-scanner path tested |
| Real report delivery | **Not implemented** (status tracking only, by design) |
| Real identity verification | **Not implemented**: development simulation only (cannot be enabled in production) |

## 2. Sign Out fix (reported bug)

**Root cause** (two faults together):
1. The Vercel middleware forwarded only the headers it listed. Origin and X-CSRF-Token were dropped, so the sign-out POST was refused with CSRF_REJECTED. Fixed in 984320a: all request headers are now forwarded except `host`, `connection`, `content-length`, `authorization` and `cookie`; the pilot cookie is removed from `cookie`, and the proxy secret is always replaced.
2. `signOut()` swallowed every error and redirected to the sign-in page, which sent the still-signed-in user straight back. Fixed in fddcc9c: a refused sign-out shows "You are still signed in. Sign out did not complete." Only a 204, or a 401 (already signed out), leads to the signed-out page.

**Tests:**
- `server/test/sign-out.test.ts`, 6 roles. For each: a request without CSRF is refused and the session survives; a real sign-out revokes the server session and clears the cookie; replaying the old cookie returns 401; signing in again works.
- e2e test "sign out: a refused request never pretends…".
- `vercel-middleware.test.ts` asserts all headers are forwarded.

**Browser (deployed):** for every role, Sign Out shows "You have signed out.". Afterwards `/api/v1/auth/me` returns 401, and so does that role's own API (admin registrations, `me/registrations`, staff samples, lab dashboard, audit log).

## 3. Route inventory

All 38 portal pages from `dist/portal/js/core/paths.js` load in English and Arabic: 76 routes, every one 200 with the correct page title and the portal script. The customer routes `account/`, `account/register/`, `account/registration/`, `account/registrations/` and `account/settings/` also load in EN and AR (10 more).

Gate check without the pilot cookie:

| Host | Portal pages | `/api/v1/*`, `/portal/*` | Public site, `/traced/pilot-access/` |
|---|---|---|---|
| www.tracedmena.life | 303 → `/traced/pilot-access/?next=…` | 401 | 200 |
| tracedmena.life | 308 → www (then gated) | 308 → www | 308 → www |
| tracedlife.vercel.app | 303 → pilot access | 401 | 200 |

## 4. Customer (`uat-customer-u1128@preview.tracedmena.test`)

| Step | Status | Evidence |
|---|---|---|
| Sign up (adult confirmation) | Passed | "Check your email" page |
| Verification email captured, link verifies, token removed from URL | Passed | "Email verified" |
| Sign in | Passed | dashboard "No registrations yet" |
| Registration for a child, 5 steps | Passed | `TRC-SA-11/26-00007` |
| Validation: empty fields, adult DOB for a child, future DOB, invalid mobile, missing consent | Passed | messages shown, step not advanced |
| Double click on submit | Passed | exactly 1 registration |
| QR shown; PNG and SVG download | Passed | 200, `no-store` |
| Email QR again | Passed | captured |
| Customer correction (surname, with reason) | Passed | "The patient's details have been updated." |
| Replace QR (old one stops working) | Passed | new QR differs |
| Profile saved from registration | Passed | name and mobile in settings |
| Arabic registration page | Passed | `dir=rtl`, no horizontal overflow |
| Sign Out | Passed | 401 afterwards |

## 5. Admin (`uat-admin-u1128@…`)

| Step | Status |
|---|---|
| All 10 admin pages load; personal-data export shows "No access" for admin | Passed |
| Branch: create, empty-form validation, edit, deactivate, activate (with reasons) | Passed |
| Staff: invite (captured), assign branch, change roles (removing collection staff also removes its branches), suspend, reactivate (back to "Invitation pending"), resend invitation | Passed |
| Registration search: tracking ID, name, email, status, QR state, branch, date | Passed |
| Registration `…00007` before collection: transfer to another branch and back (with and without customer email), patient correction, QR revoke with replacement | Passed (all in record history with actor and reason) |
| Emails monitor: masked addresses, no content or links, failed item explained | Passed |
| Audit log entries for every action | Passed |
| Audit integrity: manual verification | Passed (266 entries, 5 checkpoints) |
| Operational CSV (totals only, `personalData: false`) | Passed |
| Settings: profile name saved | Passed |
| Change password | Not tested in the browser (covered by unit and e2e tests) |
| Sign Out | Passed |

## 6. Collection staff (`uat-collector-u1128@…`, DEV-RUH-01)

| Step | Status |
|---|---|
| Account setup via invitation link, sign in | Passed |
| Screens show age and gender only, never names | Passed |
| Scan via manual entry (same path as USB scanners): tracking ID alone refused; unknown code refused; valid QR accepted | Passed |
| Collection blocked until identity is verified (simulation "Failed" keeps it blocked) and all 4 checklist items are ticked | Passed |
| Collect → `TRC-SA-11/26-00007-S01` | Passed |
| Re-scan of the used QR refused ("Do not collect again") | Passed |
| Label: no personal data; print count increments | Passed (print dialog stubbed) |
| Custody: packaged → ready for dispatch → dispatched (courier and tracking number); no further branch action | Passed |
| Camera scanning on a phone | Not tested (no device) |
| Sign Out | Passed |

## 7. Laboratory (`uat-lab-u1128@…`)

| Step | Status |
|---|---|
| Setup, sign in; dashboard lists the dispatched sample; no patient data | Passed |
| Reject without a reason refused | Passed |
| Receive as Damaged and reject for "Damaged packaging" with remarks; no further lab action | Passed |
| Accept / analysis / report-available path | Not repeated by hand: covered by the deployed automated journey (vm_13) and e2e |
| Sign Out | Passed |

## 8. Super admin and auditor

| Step | Status |
|---|---|
| Super admin (plain): sign in, menu includes personal-data export | Passed |
| Recollection: refused without the confirmation tick; authorised; registration back to awaiting collection with a new active QR; append-only custody timeline names every actor | Passed |
| Personal-data export without an enrolled authenticator refused ("code incorrect"), also refused via direct API without CSRF | Passed |
| Super admin with MFA: enrolment and export with a fresh code | **Not tested**: owner asked to skip (28 Nov). Controls unchanged: export still requires a fresh code from an enrolled authenticator (`server/src/modules/auth/mfa.ts:84`) |
| Auditor: menu limited to dashboard, audit log, audit integrity, settings | Passed |
| Auditor reads: audit log, stats, operational CSV allowed; registrations, staff, branches, emails, samples, staff/lab/customer APIs return 403 | Passed |
| Auditor writes (valid CSRF): branch create, recollection, QR revoke, personal-data export all return 403; each denial logged as `authz.denied` with the missing permission | Passed |
| Auditor runs integrity verification | Passed (341 entries, 5 checkpoints) |
| Sign Out (both) | Passed |

## 9. Security regression

1. **Pilot gate**: §3. Bypass with encodings, slashes, backslashes or case is covered by `vercel-middleware.test.ts` (12 tests).
2. **CSRF**: writes without the token are refused (403 CSRF_REJECTED, seen in the browser); writes with it work for every role.
3. **Authorisation**: auditor (§8), staff and lab cannot open other roles' APIs. Every denial is audited.
4. **Client IP spoofing through the forwarded headers**: the middleware now forwards the incoming `X-Forwarded-For`.
   - Design: Caddy appends the peer address. The API trusts 2 hops only when `x-traced-proxy-auth` matches the secret (1 hop otherwise) and counts from the right, so a value a client prepends never ends up as the client IP.
   - Empirical check: a pilot-password attempt sent with `X-Forwarded-For: 203.0.113.99`, then a read of the `pilot:ip:*` rate-limit key on the server (`vm_19_ratelimit_ips.sh`).
   - Result: **Passed**. The attempt (401) was counted under the real client IP, key `pilot:ip:5.156.151.42` in the 12:15 Riyadh window. No key exists for 203.0.113.99, so a client cannot choose the IP used for rate limits and audit entries.
5. **Privacy**: staff, lab and auditor views show no patient names. Labels carry no personal data. The email monitor masks addresses. QR tokens never appear in URLs sent to the server (the token is in the fragment) and are never shown on admin pages.

## 10. Observations (not bugs; no change made)

- The staff invite form ticks "Collection staff" by default.
- A collection staff member can be invited without a branch (by design; they see nothing until assigned).
- Empty registration search says "Nothing to show yet." rather than "No matches".
- On the child step, errors say "Enter your First name" (the patient is the child).
- The admin sign-in text says accounts "require two-step verification", which isn't accurate during the pilot.
- An account without an authenticator trying the export is told "code incorrect" rather than "set up two-step verification first".
- Consent texts and collection instructions are marked provisional and not legally approved. **Approval is needed before real patients.**
- Identity verification is development simulation only. **A real method is needed before real patients.**
- Invalid form fields are not individually highlighted (existing behaviour).

## 11. Regression suite

**Passed** (28 Nov 2026, 12:28, on fddcc9c plus the UAT docs and scripts):
- `npm run typecheck`: clean.
- `npm run check:portal`: portal pages and pilot pages up to date.
- `npm test`: **302/302** tests in 29 files.

The deployed automated journey on the server (vm_13) passed 61/61 on the current build earlier on 28 Nov.

## 12. Not done / blockers for real launch

- Approved consent texts and collection instructions.
- A real identity verification method.
- Physical device tests: phone camera scan, label printer.
- MFA super admin export test (skipped by owner).
- Owner decision to switch the pilot gate off (needs both `TRACED_PILOT_GATE=off` and `TRACED_LAUNCH_APPROVED=yes`).
- Production database cutover. Real patient registration and collection remain disabled.
