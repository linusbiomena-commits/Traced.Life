# TRACED Registration & Chain of Custody: Phase 0 Report

Date: 26 November 2026 · Scope: inspection and planning only. No source code changed, no dependencies installed, no migrations, no deployments, no branch created.

---

## 1. Existing application: what is actually there

| # | Item | Finding (verified) |
|---|------|--------------------|
| 1 | Frontend framework | **None in the repo.** The site is a static mirror of third-party Shopify themes (traced.life, linusbio.com, clearstrandasd.com), saved as pre-built HTML. The Traced pages use the theme's compiled **Tailwind v4 CSS** (`/media/757a41e511ee27ea5474.css`, 147 KB), **Alpine.js** (`x-data` components such as `headerDropdown`, `heroHomepage`) and **Swiper**, all bundled in `/media/*.js`. There is no `package.json`, no build step and no source for these bundles. |
| 2 | Backend | **None.** No server, no API routes, no serverless functions. `GET https://linusbiomena.vercel.app/api/health` returns 404. |
| 3 | Database / ORM | **None.** |
| 4 | Authentication | **None of our own.** The Traced header's account link goes to `https://account.traced.life/profile`, the **original US company's Shopify customer accounts**. |
| 5 | Email | **None.** The Traced "Send enquiry" form (`traced-enquiry.js`) opens the visitor's mail app with a `mailto:LinusBio@karama.tech` link. |
| 6 | Hosting / deploy | **Vercel**, static (`Server: Vercel`, region `bom1` edge, HSTS preload on). The live `/traced/` page is byte-identical (same MD5/ETag) to `LinusBio MENA Website/dist/traced/index.html` at commit `6c6f9b6`. No `vercel.json` in the repo, so the output directory (`dist`) is set in the Vercel dashboard. Git remote: `github.com/karamaitltd/LinusBioMENA-Website`. **No Content-Security-Policy and no X-Frame-Options** are sent. No custom domain, only `linusbiomena.vercel.app`. |
| 7 | TRACED routes | 28 English pages under `/traced/` and 28 Arabic pages under `/ar/traced/`: home, `products/test/` (currently "Coming soon" + enquiry form), `pages/{contact,faqs,our-story,report,science,traced-score,what-we-test}`, 3 policies, 16 blog pages. Header nav: Home, Shop (`products/test`), Learn dropdown. |
| 8 | Translation architecture | Arabic is **separate pre-translated HTML files** under `/ar/` (`lang="ar-SA" dir="rtl"`). `language-switch.js` maps `/x` ↔ `/ar/x` by path prefix and stores the choice in `localStorage['linusbiomena-language']`. Dictionary `dist/locales/ar-SA.json` is used only by the Python build tools. Long-form Arabic is machine translated (per the repo's own audit). |
| 9 | Reusable UI | The compiled Tailwind design tokens (below), the three brand fonts, the Traced header/footer markup, `language-switch.js/.css`, `brand-contact.js` (+966 phone input helper), the enquiry-form styling and country-code select, and `menu-rotate-fix.js`. No component library: reuse means copying markup and using the existing CSS classes and variables. |
| 10 | Environment variables | **None in use.** `.gitignore` already excludes `.env` and `.env.*`. `.openai/hosting.json` only contains a project id and `"static": {"directory": "dist"}` (no secrets). |
| 11 | Git | `LinusBio MENA Website`: branch `main`, clean except untracked `exports/`, last commit 17 Nov 2026. `Traced Website` (split out today) is **not its own repo**: it is an untracked folder inside the large parent `Mohd Muzzammil Projects` repo, and it is **not deployed** anywhere. |
| 12 | Automated tests | **None** for the app. Only Python mirror tools (`tools/verify_mirror.py`, `build_arabic.py`, `make_rtl_css.py`, `mirror_site.py`) and JSON audit outputs. No CI. |

**Design tokens to reuse** (from the compiled CSS):

- Colours: primary `#c7d2ac` (50 `#e3e9d5`, 70 `#d8e0c5`), dark primary `#413f32`, dark secondary `#201f1a`, background-4 `#615e50` / `#b0aea7`, light `#f5f5f5` / `#fafafa`, grey `#d9d9d9`, quinary `#e1dcd7`, tertiary `#f1c494`, validation error `#ebab66`.
- Fonts: `--font-sans: "Saans"`, `--font-serif: "Serrif"`, `--font-mono: "Saans Semi Mono"` (woff2 files in `/media`).
- Radii: s 0.5rem, m 1rem, lg 1.5rem, xl 2rem, full.

**Observed while running the site locally:** the Traced pages keep loading Shopify scripts from `traced.life` / `shop.app` and attempt POSTs to `/.well-known/shopify/monorail/...` and web-pixel workers. On the live site those calls go to the original store's analytics.

---

## 2. Recommended integration architecture

Nothing exists to reuse on the server side, so the backend is entirely new. The goal is to add it **beside** the static site without touching how existing pages are built or served.

```
Browser ─► Vercel (static dist/, unchanged pages + new portal pages)
              │  same origin: /api/*  (rewrite or Vercel Functions)
              ▼
        TRACED API (Node 20+, TypeScript, Hono)  ── portable: Vercel Functions OR a container in a KSA region
              │                 │                 │
        PostgreSQL 16      Email provider     Cron / worker
        (region = legal     (Resend or SES)   (email outbox retries,
         decision)                             token expiry)
```

Key choices:

1. **Keep marketing pages untouched.** Portal pages are new static HTML shells under `/traced/account/`, `/traced/staff/`, `/traced/admin/` (+ `/ar/...` for the customer portal), styled with the existing CSS file and tokens. They load **no Shopify/Okendo/third-party scripts** and get a strict CSP.
2. **No frontend build step**, matching the existing site: plain ES modules + a small shared library and JSON dictionaries. QR images are generated **server-side**, so the browser only needs a scanner (native `BarcodeDetector`, with `@zxing/browser` vendored as a fallback for Safari/Firefox).
3. **Same-origin API** at `/api/*`. Session cookies can then be `HttpOnly; Secure; SameSite=Strict`, which removes most CSRF risk; we still add a CSRF token on state-changing requests.
4. **Backend written once, hosted where legal says.** Hono runs as Vercel Functions or as a normal Node server. If Saudi data residency is required (likely, see §12), the API and database run in a KSA cloud region and Vercel rewrites `/api/*` to it, so the domain stays the same.
5. **PostgreSQL with plain SQL migrations and `pg`** (no heavy ORM). Atomic tracking-ID allocation, partial unique indexes, append-only triggers and per-role DB grants are all easier to guarantee in explicit SQL.
6. **Transactional outbox for email.** Registration commits first (with an `email_deliveries` row in `queued`); a worker/cron sends and retries. Email failure can never roll back or duplicate a registration.

---

## 3. Proposed database schema

All primary keys are `uuid` (`gen_random_uuid()`), timestamps are `timestamptz` (UTC); Riyadh time is used only for tracking-ID periods and display.

### Identity & access
- **users**: id, email (citext, unique), password_hash (Argon2id), email_verified_at, status (`pending|active|suspended|deactivated`), locale (`en|ar`), mfa_totp_secret_enc, mfa_enabled_at, failed_login_count, locked_until, created_at, updated_at.
- **roles**: id, key (`customer|collection_staff|admin|super_admin`, optional `lab_operator|auditor`), name.
- **permissions**: id, key (e.g. `registration.read_full`, `staff.invite`, `custody.transition.dispatch`).
- **role_permissions**: role_id, permission_id.
- **user_roles**: user_id, role_id, granted_by, granted_at.
- **sessions**: id, token_hash (unique), user_id, created_at, last_seen_at, expires_at, mfa_verified_at, ip, user_agent, revoked_at.
- **auth_tokens**: id, user_id, purpose (`verify_email|reset_password|staff_invite`), token_hash, expires_at, used_at.
- **staff_invitations**: id, email, role_id, branch_ids uuid[], token_hash, invited_by, expires_at, accepted_at, revoked_at.

### Customers, patients, registrations
- **patients**: id, account_user_id → users, relationship (`self|child|legal_ward`), first_name, last_name, date_of_birth, gender, national_id_enc + national_id_hmac (blind index for duplicate checks; only if approved), nationality (only if approved), created_at. *The account holder (users) and the patient are separate, which supports guardians.*
- **form_definitions**: id, version, schema jsonb (fields, required flags, labels EN/AR), status (`draft|approved|retired`), approved_by, approved_at. Makes the form configurable and versioned.
- **registrations**: id, tracking_id (unique), tracking_period (`YYMM`), tracking_seq (1–99999), unique (tracking_period, tracking_seq), account_user_id, patient_id, branch_id, form_definition_id, extra_fields jsonb, status, cancelled_at, cancel_reason, created_at.
- **tracking_sequences**: period (`YYMM`, PK), last_value int `CHECK (last_value BETWEEN 0 AND 99999)`.
- **consent_documents**: id, type (`privacy|consent|terms`), version, locale, content_sha256, effective_from.
- **consent_records**: id, user_id, patient_id, registration_id, consent_document_id, accepted_at, ip, user_agent, withdrawn_at.

### QR, samples, custody
- **qr_tokens**: id, registration_id, token_hmac (unique), token_enc (AES-256-GCM, so the QR can be redisplayed), status (`active|revoked|consumed|expired`), issued_at, expires_at, revoked_at, revoked_by, revoke_reason, last_scanned_at. Partial unique index: one `active` token per registration.
- **collection_branches**: id, code (unique), name_en, name_ar, city, address_en, address_ar, active, created_at.
- **staff_branch_assignments**: id, user_id, branch_id, assigned_by, assigned_at, revoked_at. Partial unique on (user_id, branch_id) where not revoked.
- **identity_verifications**: id, registration_id, method (`customer_otp|customer_device_confirm|document_check|nafath`), status (`pending|verified|failed|expired`), performed_by, branch_id, provider_ref, created_at, completed_at.
- **samples**: id, sample_code (unique, random), registration_id, sample_type (`hair`), branch_id, collected_by, collected_at, status, label_print_count. Partial unique index: **one non-rejected sample per registration** (the database itself blocks duplicate collection).
- **sample_qr_tokens**: id, sample_id, token_hmac (unique), status, issued_at, revoked_at.
- **custody_events**: id (bigserial), registration_id, sample_id, tracking_id, event_type (`transition|handover|correction|note`), from_status, to_status, actor_user_id, actor_role, branch_id, location, handover_from, handover_to, courier_ref, remarks, corrects_event_id, occurred_at, recorded_at, request_id. **Append-only**: no UPDATE/DELETE grant for the app role, plus a trigger that rejects both.

### Operations & audit
- **email_deliveries**: id, registration_id, user_id, template, locale, to_email, provider, provider_message_id, status (`queued|sending|sent|delivered|bounced|failed`), attempts, next_attempt_at, last_error, created_at.
- **audit_logs** (append-only, same protection): id (bigserial), actor_user_id, actor_role, action, target_type, target_id, fields_accessed text[], ip, user_agent, request_id, metadata jsonb, created_at, prev_hash/hash (tamper-evident chain).
- **rate_limits**: key, window_start, count (Postgres-based limiter, so no extra service).

### Relationships
users 1–n patients (as account holder) · users 1–n registrations · patients 1–n registrations · registrations 1–n qr_tokens (1 active) · registrations 1–n samples (1 non-rejected) · samples 1–n sample_qr_tokens · registrations/samples 1–n custody_events · registrations 1–n consent_records / email_deliveries / identity_verifications · users n–n roles · users(staff) n–n collection_branches.

### Tracking ID: how it stays unique
Inside the registration transaction:
```sql
INSERT INTO tracking_sequences (period, last_value)
VALUES (to_char(now() AT TIME ZONE 'Asia/Riyadh', 'YYMM'), 1)
ON CONFLICT (period) DO UPDATE SET last_value = tracking_sequences.last_value + 1
RETURNING period, last_value;
```
- The row lock serialises concurrent registrations for the month, so no two get the same number.
- The month is computed **in the database** in Asia/Riyadh time, so there are no clock-skew bugs at month boundaries.
- Over 99,999 → the CHECK fails → the transaction rolls back → the API returns a clear "monthly capacity reached" error, and nothing duplicates.
- Display format `TRC-SA-MM/YY-XXXXX` is built from period + seq; `UNIQUE(tracking_id)` is the final guard.
- Cancelled registrations keep their ID forever (rows are never deleted). A number only "returns" if its transaction never committed, so it was never issued.
- APIs address registrations by **UUID**. Tracking-ID search goes through an encoded query parameter. Filenames and labels use a slash-free form (`TRC-SA-11-26-00001`) while the displayed ID is unchanged.

### QR token design
- 32 random bytes (`crypto.randomBytes`), base64url. Stored as **HMAC-SHA256 with a server pepper** (for lookup) plus an **AES-GCM encrypted copy** (for redisplay). The raw token is never returned in JSON.
- QR content: `https://<domain>/traced/c/#<token>`. Using the fragment keeps the token out of server logs and referrers. A member of the public who scans it sees a neutral "Show this at your collection branch" page. The staff scanner extracts the token.
- Dashboard and download get the image (`GET /api/me/registrations/:id/qr.png|svg`), rendered on the server with `qrcode`, `Cache-Control: no-store`, owner-only.
- Revoke = mark revoked + issue a new token + email the new QR. The tracking ID never changes.
- The QR alone grants nothing: validation requires a signed-in, active staff account assigned to the registration's branch, and collection additionally requires a completed identity verification.

---

## 4. Proposed API endpoints

All under `/api/v1`. JSON in and out, zod-validated, session cookie + CSRF header on writes.

**Auth (all roles)**
- `POST /auth/sign-up` · `POST /auth/sign-in` · `POST /auth/sign-out`
- `POST /auth/verify-email` · `POST /auth/verify-email/resend`
- `POST /auth/password/forgot` · `POST /auth/password/reset`
- `POST /auth/mfa/setup` · `POST /auth/mfa/verify` (admins required, staff optional)
- `POST /auth/invitations/accept` (staff and admins set a password from an invite)
- `GET /auth/me`

**Customer** (only own data; every query is scoped by `account_user_id = session.user_id`)
- `GET /me/form-definition` (active form + branches)
- `GET|POST /me/patients` · `PATCH /me/patients/:id`
- `POST /me/registrations` (creates registration + tracking ID + QR + queued email in one transaction; accepts an `Idempotency-Key` header to prevent double submits)
- `GET /me/registrations` · `GET /me/registrations/:id`
- `GET /me/registrations/:id/qr.png` · `.svg`
- `POST /me/registrations/:id/resend-email` (rate limited, e.g. 3/hour, 10/day)
- `GET /me/registrations/:id/status` (status timeline, customer-safe wording)
- `POST /me/registrations/:id/cancel` (only before collection)
- `POST /me/registrations/:id/identity/confirm` (customer side of check-in verification)

**Collection staff** (branch-scoped; **explicit response allowlist**)
- `POST /staff/scan` `{token}` → `{registrationRef, trackingId, qrValid, patientAge, patientGender, sampleType, collectionStatus, identityStatus, instructions}`. Nothing else is ever serialised.
- `POST /staff/registrations/:ref/identity` (start or complete verification)
- `POST /staff/registrations/:ref/collect` (transaction: lock registration, check token active + branch + identity + no live sample, create sample + sample token, append custody event)
- `GET /staff/samples/:id/label` (label data + sample QR: tracking ID, sample code, date; no PII)
- `POST /staff/samples/:id/events` (package, ready for dispatch, dispatch/handover, reject with reason)
- `GET /staff/history`

`:ref` is a short-lived opaque check-in reference returned by `/staff/scan`, not the registration UUID, so staff cannot enumerate registrations.

**Admin** (permission-checked; every read of personal data audited)
- `GET /admin/registrations?q=&trackingId=&status=&branch=&from=&to=` · `GET /admin/registrations/:id`
- `PATCH /admin/registrations/:id` (audited, reason required) · `POST /admin/registrations/:id/cancel`
- `POST /admin/registrations/:id/qr/revoke` (re-issues and emails)
- `GET /admin/registrations/:id/emails` · `POST /admin/emails/:id/retry`
- `GET /admin/registrations/:id/custody` · `POST /admin/samples/:id/events` (lab-side statuses, corrections)
- `GET|POST /admin/branches` · `PATCH /admin/branches/:id`
- `GET /admin/staff` · `POST /admin/staff/invitations` · `POST /admin/staff/:id/{activate,suspend,deactivate}` · `PUT /admin/staff/:id/branches`
- `GET|POST /admin/form-definitions` · `POST /admin/form-definitions/:id/approve` (super admin)
- `GET /admin/audit-logs` · `GET /admin/stats` · `GET /admin/reports/:type.csv` (exports audited; personal fields only with `export.pii`)

**System**
- `GET /health` · `POST /internal/cron/email-outbox` (secret-protected, called by Vercel Cron or the worker) · `POST /webhooks/email` (provider delivery events, signature-verified)

---

## 5. Proposed frontend routes

All are new static shells; none of the 56 existing Traced pages change except the entry points in §8.

| Portal | English | Arabic |
|---|---|---|
| Customer | `/traced/account/sign-up/`, `sign-in/`, `verify-email/`, `forgot-password/`, `reset-password/`, `/traced/account/` (dashboard), `/traced/account/register/`, `/traced/account/registrations/?id=` | same under `/ar/traced/account/…` |
| Public QR landing | `/traced/c/` | `/ar/traced/c/` |
| Staff | `/traced/staff/sign-in/`, `/traced/staff/` (scanner), `/traced/staff/collect/`, `/traced/staff/label/`, `/traced/staff/history/`, `/traced/staff/accept-invite/` | `/ar/traced/staff/…` (recommended: Saudi staff) |
| Admin | `/traced/admin/` (stats), `registrations/`, `registration/?id=`, `staff/`, `branches/`, `audit/`, `reports/`, `forms/`, `sign-in/` | English first; Arabic optional |

The existing `language-switch.js` works for these paths unchanged because it maps by the `/ar` prefix. Staff and admin pages are `noindex` and excluded from any sitemap.

---

## 6. Role-based permission matrix

✓ allowed · B = own assigned branch only · O = own records only · — denied (enforced in API; UI hiding is cosmetic)

| Capability | Customer | Collection staff | Lab operator* | Admin | Super admin | Auditor* |
|---|---|---|---|---|---|---|
| Sign up publicly | ✓ | — | — | — | — | — |
| Create / view own registrations, QR, status | O | — | — | — | — | — |
| Resend own QR email | O | — | — | ✓ (any) | ✓ | — |
| Scan & validate customer QR | — | B | — | — | — | — |
| See patient **age + gender** | O | B | — | ✓ | ✓ | — |
| See name, email, phone, DOB, ID, nationality | O | **—** | — | ✓ (audited) | ✓ | ✓ masked |
| Identity verification step | confirm O | B | — | ✓ | ✓ | — |
| Confirm collection, print label | — | B | — | — | — | — |
| Package / ready / dispatch | — | B | — | ✓ | ✓ | — |
| In transit / received / analysis / report | — | — | ✓ | ✓ | ✓ | — |
| Reject sample | — | B (pre-dispatch) | ✓ | ✓ | ✓ | — |
| Cancel registration | O (pre-collection) | — | — | ✓ | ✓ | — |
| Correction event | — | — | — | ✓ | ✓ | — |
| Revoke / regenerate QR | — | — | — | ✓ | ✓ | — |
| Invite / suspend staff, assign branches | — | — | — | ✓ | ✓ | — |
| Manage branches | — | — | — | ✓ | ✓ | — |
| Manage admins, approve form versions & consent docs | — | — | — | — | ✓ | — |
| View audit logs | — | — | — | ✓ | ✓ | ✓ |
| Export reports (no PII / with PII) | — | — | — | ✓ / perm | ✓ | ✓ / — |
| MFA required | — | recommended | ✓ | ✓ | ✓ | ✓ |

\* Optional roles. Until approved, admins perform the lab-side statuses.

### Status transitions

| From → To | Who | Conditions |
|---|---|---|
| (new) → Registration Completed | system | registration committed |
| Registration Completed → Awaiting Sample Collection | system | QR issued (email queued; email failure doesn't block) |
| Awaiting → Sample Collected | staff (B) | active QR, branch match, identity verified, no live sample |
| Sample Collected → Sample Packaged | staff (B) | |
| Packaged → Ready for Dispatch | staff (B) | |
| Ready → Dispatched | staff (B) / admin | handover recipient + courier ref required |
| Dispatched → In Transit | lab op / admin | |
| In Transit → Received by Laboratory | lab op / admin | received-by + condition |
| Received → Analysis in Progress → Analysis Completed → Report Available | lab op / admin | |
| Any pre-dispatch sample state → Rejected | staff (B) / admin | reason required |
| Any post-dispatch state → Rejected | lab op / admin | reason required |
| Rejected → Awaiting Sample Collection | admin | re-collection: new sample record, old one kept |
| Registration Completed / Awaiting → Cancelled | customer (O) / admin | |
| Any later state → Cancelled | admin | reason required |

Corrections never edit history: they append a `correction` event pointing at `corrects_event_id`. The transition table lives in one module shared by API validation and tests.

### Identity verification (QR ≠ identity)
Pluggable `IdentityVerifier` interface; staff only ever receive `identityStatus`.
1. **Now (recommended baseline):** at check-in the scan creates a pending verification and the customer confirms on their own signed-in phone (`customer_device_confirm`), or reads back a 6-digit code sent to their verified email (`customer_otp`). This proves account possession without showing staff any personal data.
2. **Later: SMS OTP** (Saudi provider with a registered sender ID).
3. **Later: Nafath.** The backend sends a request for the patient's/guardian's national ID; the customer approves in the Nafath app; staff see "Verified". Children are verified via the guardian.
4. A **physical ID-document check** would show staff the patient's name, which conflicts with the privacy rule. This needs a management decision (see §12).

---

## 7. Recommended folder structure

Shown for whichever repo is chosen (§12, decision 1):

```
dist/                                 existing static site (unchanged except entry points)
  traced/account/ staff/ admin/ c/    new portal page shells (EN)
  ar/traced/account/ staff/ c/        new portal page shells (AR)
  portal/
    css/portal.css                    uses existing tokens/fonts; no new design system
    js/core/ (api.js, i18n.js, session.js, forms.js, dom.js)
    js/customer/ js/staff/ js/admin/
    i18n/en.json  i18n/ar.json
    vendor/zxing-browser.min.js       pinned + SRI hash
server/
  src/
    app.ts  config/  db/(pool.ts, tx.ts)
    middleware/ (session, csrf, rbac, rate-limit, validate, audit, security-headers)
    modules/ auth/ users/ patients/ registrations/ tracking-id/ qr/ email/
             branches/ staff/ samples/ custody/ identity/ consent/ audit/ reports/
      each: routes.ts, service.ts, repo.ts, schema.ts, serializers.ts (allowlists)
    lib/ (crypto.ts, time.ts, errors.ts, ids.ts)
  migrations/ 0001_init.sql …
  templates/email/{en,ar}/registration-confirmed.{html,txt}
  test/ unit/ integration/ e2e/
api/[...route].ts                     thin Vercel adapter → server/src/app.ts (if hosted on Vercel)
docs/                                 this report, data-flow diagram, runbooks
package.json  tsconfig.json  vercel.json  .env.example
```

---

## 8. Existing files requiring modification

Kept to the minimum, all pending your approval:

| File | Change | Why |
|---|---|---|
| `dist/traced/products/test/index.html` and `/ar/` twin | Replace or add to the "Coming soon / Send enquiry" block with a "Register for TRACED" call to action | main entry point |
| Traced header (56 files: 28 EN + 28 AR) | Repoint the `account.traced.life` link to `/traced/account/` (or `/ar/…`) | today it sends users to the US company's Shopify accounts. **Option:** do it with one small script include instead of hand-editing markup. |
| `dist/traced/policies/privacy-policy/` (+AR) | New PDPL-aligned privacy notice text | must come from legal; we only place it |
| `.gitignore` | add `node_modules/`, `.vercel/`, coverage output | |
| Vercel project settings | output dir stays `dist`; add functions/rewrites | config, not code |

`language-switch.js`, `brand-contact.js` and the main CSS are reused **as is**.

## 9. New files to be created

`package.json`, `tsconfig.json`, `vercel.json` (rewrites; security headers scoped to `/traced/account|staff|admin|c`, `/ar/...` and `/api` only, so existing pages are unaffected), `.env.example`, `server/**` (modules above), `server/migrations/*.sql`, `api/[...route].ts`, email templates EN/AR, `dist/portal/**`, about 30 portal page shells (EN+AR), `server/test/**`, `playwright.config.ts`, `docs/*` (data-flow map, retention policy draft, runbooks), CI workflow (`.github/workflows/ci.yml`).

---

## 10. Dependencies and external services

**Runtime (server):** `hono` (router, portable Vercel/Node) · `pg` (Postgres) · `zod` (validation) · `@node-rs/argon2` (password hashing, prebuilt binaries, no native build) · `qrcode` (QR PNG/SVG) · `otpauth` (admin TOTP MFA). Node `crypto` for tokens, HMAC and AES-GCM. Email over the provider's HTTP API with `fetch` (no SDK needed).
**Browser:** `@zxing/browser` (vendored, pinned) as the scanner fallback; native `BarcodeDetector` + `getUserMedia` first. USB/Bluetooth scanners work as keyboard input, so no library is needed for them. I'd avoid `html5-qrcode`: it is effectively in maintenance mode, and ZXing is what it wraps anyway.
**Dev:** `typescript`, `tsx`, `vitest`, `@playwright/test`, a local PostgreSQL 16 (native install or Docker; not yet checked on this machine).

**External services (all need your decision or accounts):**
- **PostgreSQL host:** region depends on residency (KSA-region cloud vs Neon/Supabase outside KSA).
- **Email:** Resend (needs a verified **custom domain**; `vercel.app` cannot be verified) or Amazon SES in a Gulf region.
- **Custom domain** for the portal (e.g. `traced.<your-domain>.sa`): needed for email deliverability, brand trust and a clean cookie scope.
- **Later:** Saudi SMS provider (sender ID registration), Nafath (government onboarding).
- **Backups:** managed point-in-time recovery from the DB host + encrypted offsite copies.

---

## 11. Estimated development hours

| Phase | Scope | Hours |
|---|---|---|
| 0 | Inspection & plan | done |
| 1 | Repo/tooling setup, schema + migrations, auth (sign-up/in/out, verify, reset, sessions, MFA), RBAC, audit log, rate limiting | 48–64 |
| 2 | Customer portal shells EN/AR, configurable form, guardian/patient model, consent capture, dashboard | 40–52 |
| 3 | Tracking-ID engine + concurrency tests, QR engine, email outbox/retry/webhooks, EN/AR templates, resend | 28–38 |
| 4 | Staff portal, scanner (camera + USB), allowlisted scan API, identity-verification baseline, collection transaction | 36–48 |
| 5 | Admin portal: search/filter, registration detail, staff invites & lifecycle, branches, QR revoke, email status, audit viewer, stats, CSV exports | 56–72 |
| 6 | Sample IDs + sample QR, printable labels (browser print CSS), custody transitions, handovers, corrections, timelines | 32–42 |
| 7 | Security hardening (CSP, headers, ZAP scan, authz matrix tests), full E2E EN/AR, load test on ID allocation, docs/runbooks | 40–56 |
| 8 | Production infra, secrets, DNS/email domain, migration, smoke tests, rollback drill (excludes legal/vendor lead time) | 14–22 |
| **Total** | | **≈ 294–394 h** |

The estimates assume form fields, roles and hosting are decided before Phase 1 ends. Arabic copy for the new screens is machine-drafted and needs a professional review, which is not included.

---

## 12. Risks and unresolved decisions

### Decisions needed before Phase 1
1. **Which repo?** `LinusBio MENA Website` (deployed, has a GitHub remote, but contains all three brands) or the new `Traced Website` folder (split today, but not its own git repo and not deployed). My recommendation: make `Traced Website` its own git repo with a new remote and Vercel project, then branch `feature/traced-portal`. The alternative is a branch in the LinusBio repo, with the live site continuing as is.
2. **Hosting region for personal and health data:** KSA region or not (see legal list below). This decides Vercel Functions vs a KSA-hosted API.
3. **Email provider and sending domain.**
4. **Form fields:** whether National ID/Iqama and nationality are collected now. My recommendation: not until Nafath or a regulator requires them (PDPL data minimisation).
5. **Identity verification at the branch:** customer-device confirm / email OTP now, or a physical ID check, which conflicts with "staff never see names".
6. **Lab-side roles:** who records In Transit → Report Available (admins now, or a lab operator role, possibly at the US lab).
7. **Entry points:** header account link repointing (56 pages) and the product-page CTA.
8. **Sample ID format:** proposal `TRS-` + 8 random Crockford base32 characters, e.g. `TRS-7K4M-Q2XD` (unguessable, short enough to read aloud).
9. **QR expiry:** does a customer QR expire (e.g. 90 days) if no sample has been collected?
10. **Staff portal language:** Arabic needed?

### Needs management and legal approval before production (technical work alone does not establish compliance)
- **PDPL (SDAIA):** lawful basis and explicit consent for health data, privacy notice, data-subject rights process, records of processing, DPO/registration obligations where applicable, breach notification timelines.
- **Data residency and cross-border transfer:** PDPL transfer rules. **Samples and results appear to go to a US laboratory** (the site lists a New Jersey testing lab), which is a cross-border transfer of health data that needs a legal basis and safeguards.
- **Sector rules:** Ministry of Health / Saudi Health Council requirements for health information, any licensing for sample-collection branches, and whether SFDA rules apply to the test itself.
- **NCA cybersecurity controls** if contracting with government or critical sectors; cloud provider classification.
- **Minors:** guardian consent wording and proof of guardianship.
- **Retention periods** for registrations, samples, audit logs and email logs, plus deletion and anonymisation rules.
- **Brand and content rights:** the Traced pages, the commercial fonts "Saans"/"Serrif" and the imagery are mirrored from LinusBio's site. Confirm your licence covers new portal pages.

### Technical risks
- **Third-party scripts on existing pages:** Shopify analytics, preloads and web pixels pointing at the original store. Portal pages will exclude them. Whether to strip them from marketing pages is your call (out of scope by default).
- **No security headers today** on the live site. They will be added only for the new paths, to avoid breaking existing pages.
- **No tests, CI or build** exist yet. Everything is new; regression risk to existing pages is controlled by scoped changes plus a byte-level diff check on every untouched page.
- **Bearer nature of emailed QR codes:** mitigated by identity verification, branch scoping, revocation and audit, never by the QR alone.
- **Serverless + Postgres:** needs a pooled connection string; cold starts are acceptable at expected volume.
- **Camera access** needs HTTPS (localhost is fine for dev). iOS Safari has no `BarcodeDetector`, so the ZXing fallback must be tested on real devices.
- **Single row lock per month** on the sequence is fine for thousands per day; a load test in Phase 3 will confirm.

---

## 13. Testing strategy

- **Unit (Vitest):** tracking-ID formatting/parsing, transition table, response allowlist serializers, crypto helpers, form-definition validation, age calculation (Riyadh date).
- **Integration (real Postgres):** 500 parallel registrations → unique, gap-free IDs; month rollover at 23:59:59 → 00:00:00 Riyadh; exhaustion at 99,999; concurrent double-collection → exactly one sample; append-only triggers reject UPDATE/DELETE; email failure leaves the registration intact; idempotency key blocks double submit.
- **Authorization matrix:** every endpoint × every role (+ anonymous, suspended, other-branch staff, other customer) → expected 2xx/401/403/404. **Snapshot test that the staff scan response contains exactly the allowlisted keys.** IDOR probes with swapped UUIDs.
- **Security:** CSRF, XSS payloads in every field (EN/AR), SQL injection probes, rate-limit tests, session fixation and logout invalidation, MFA enforcement, OWASP ZAP baseline against localhost, `npm audit`.
- **E2E (Playwright, EN + AR, desktop + mobile viewport):** sign-up → verify (test mail transport) → register → QR shown, downloaded and emailed → staff scans (camera fed a QR image) → identity → collect → label print preview → custody steps → admin sees full record and audit trail.
- **Regression of the existing site:** hash every existing `dist` file before and after. Only the approved files may differ; link check over all 168 pages.

## 14. Deployment and rollback strategy

1. All development local (local Postgres, console/test email transport, no real data).
2. Vercel **preview** deployments behind Vercel deployment protection, with a separate non-production database and seeded fake data only.
3. Staging sign-off checklist: tests green, ZAP clean, legal items closed.
4. **Production only after your explicit approval:** take a database backup, run forward-only migrations, deploy with the feature flag `TRACED_PORTAL_ENABLED=false` (portal reachable only by direct URL for admins), smoke test, then enable the entry links.
5. **Rollback:** Vercel instant rollback to the previous deployment (the static site is unaffected) plus the flag turned off. Migrations are additive (expand/contract), so the old code keeps working. Point-in-time restore is the last resort. Rollback is rehearsed once on staging before go-live.

---

## Phase 0 progress report

- **Completed:** full inspection of both site folders, git state, live deployment comparison, design tokens, translation mechanism, runtime scripts; architecture, schema, API, routes, permission matrix, folder layout, estimates, risks, test and deploy plans (this document).
- **Remaining:** your decisions in §12, then Phase 1.
- **Files created:** `Traced Website/docs/phase-0-report.md` (this report). **Files modified:** `.claude/launch.json` gained a `traced-site` preview entry in the earlier "run this" step, before Phase 0. No source files modified.
- **Database changes:** none. **Dependencies installed:** none. **Deployments:** none. **Branch:** not created yet; it depends on decision 1.
- **Tests executed:** none (no application code exists). Verification done: live `/traced/` matches the local LinusBio `main` copy (identical MD5/ETag); `/api/health` 404 confirms there is no backend; response headers checked.
- **Blockers:** decisions 1–5 above, and the legal/hosting questions for production.
- **Completion:** Phase 0 100% (planning deliverable). Overall project ≈ 3–4% by estimated hours. No feature is implemented.
