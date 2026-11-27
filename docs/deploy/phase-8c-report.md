# Phase 8C report: HTTPS backend, Resend email, restricted portal preview

**Date:** 27 Nov 2026 (evening, Riyadh). Branch `feature/traced-portal`; latest commit: see `git log -1` (this report's commit). Every result below comes from commands actually run. Nothing here exposes PostgreSQL, enables real-patient workflows or changes the public website.

## 1. Summary

| Area | Status |
|---|---|
| API | **Live at https://api.tracedmena.life** in **restricted-preview mode** (database `traced_preview`, synthetic data only) |
| HTTPS | Let's Encrypt certificate for `api.tracedmena.life` (valid to 25 Feb 2027, auto-renew), TLS 1.3, HTTP → HTTPS 308 |
| Access gate | Caddy forwards `/api/v1/*` **only** with the correct `x-traced-proxy-auth` (added by the Vercel middleware); otherwise 403. `/api/v1/internal/*` 404; health check open |
| Email | Resend via Vault key; sender `TRACED <info@tracedmena.life>`, reply-to `info@tracedmena.life`; **9/9 test emails accepted** by Resend (sign-up EN/AR, reset, 4 invitations, bounce test, owner mailbox) |
| Portal preview | **https://tracedlife-git-feature-traced-portal-linus-bio-mena.vercel.app** (Vercel Authentication). Portal pages EN/AR load; middleware live. **API calls answer 503 until the owner adds `TRACED_PROXY_SECRET` in Vercel (§6)** |
| Background jobs | outbox (5 min), audit checkpoint (02:30 Riyadh) + upload (15 min), nightly encrypted backup (01:30 Riyadh), health metrics (5 min): all running and verified |
| Monitoring | 7 OCI alarms → topic `traced-ops-alerts` → info@karamaitco.com (**subscription pending confirmation**) |
| Production database `traced` | clean, untouched since its migration (0001–0011) |
| Public website | https://tracedlife.vercel.app unchanged (public pages only; portal paths 404) |
| Spend | EUR 0.00 actual / EUR 0.00 forecast against the EUR 23.25 (SAR 110 incl. VAT) budget |

## 2. DNS and credentials (verified)
- `api.tracedmena.life` A → 84.13.153.140 (reserved, free).
- Google Workspace MX (`aspmx.l.google.com` + alternates) intact.
- Website A records (Squarespace) and `www` CNAME (`ext-sq.squarespace.com`) unchanged.
- Resend: DKIM `resend._domainkey`, return path `send.tracedmena.life` (Forge MX + SPF), DMARC `p=none`.
- **Note for the company mailbox:** the root domain currently has **no SPF record**. Recommended (Squarespace → DNS → custom record): TXT `@` = `v=spf1 include:_spf.google.com ~all`, plus Google Workspace DKIM (Admin console → Apps → Gmail → Authenticate email). This protects mail sent from Gmail as `info@`; it does not affect Resend, which aligns through its own DKIM and SPF on `send.`.
- Vault: `traced-resend-api-key` ACTIVE (created by the owner). The server's instance principal reads all 7 runtime secrets (format checks only; nothing printed).

## 3. Backend deployment
- Server `traced-app-1` (A1, Riyadh); containers `traced-api` (image `traced-api:d97437b`, arm64, read-only filesystem, 768 MB limit), `traced-caddy` (only published ports 80/443), `traced-postgres` (no published port).
- Firewall: NSG ingress **TCP 443 and 80 only**. External scan: 22, 5432, 2019, 8080 closed.
- Response headers at the edge: HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`; the API also sends `Cache-Control: no-store` and its own secure headers.
- Proxy chain: Caddy keeps `X-Forwarded-For` and appends the peer; the API (`TRUSTED_PROXY_HOPS=2`, `TRUSTED_PROXY_SECRET`) trusts the client IP only when the Vercel secret is present (`server/src/lib/client-ip.ts`). Rate limits, CSRF (Origin = preview origin + per-session CSRF token), Secure cookies and MFA are unchanged from the tested application.
- Preview mode = `NODE_ENV=development` + `DEV_IDENTITY_VERIFICATION=true` + `traced_preview`, so synthetic collection can be tested end to end. **Production mode** (`vm_07 … production`) uses `traced`, approved consent texts/instructions only, and refuses development identity verification.
- Fix made during deployment: `AUTO_MIGRATE=false` (the API runs as `traced_app`, which cannot run migrations; proved by `oci-db-layout.test.ts`).

## 4. Email results (`deploy/oci/vm/vm_10_email_test.sh`)

| Email | Recipient | Result |
|---|---|---|
| Sign-up verification (EN) | delivered+signup@resend.dev | sent, provider id, payload cleared |
| Sign-up verification (EN) | bounced+signup@resend.dev | accepted by Resend (bounce happens after; not fed back, see R4) |
| Sign-up verification (EN) | **info@tracedmena.life** (owner mailbox) | sent |
| Sign-up verification (AR) | delivered+signup-ar@resend.dev | sent |
| Password reset | delivered+signup@resend.dev | sent |
| Password reset, unknown address | delivered+nobody@resend.dev | **nothing sent**, same 202 answer (no account disclosure) |
| Invitation: collection staff, laboratory operator, super admin, auditor | delivered+…@resend.dev | first attempt failed (CLI container had no internet), **retried and sent on attempt 2**: retry behaviour verified |

- **Retry/failure:** the outbox retries with backoff up to 6 attempts and then marks the email failed (`outbox-reliability.test.ts`). Seen live above.
- **Owner checks still needed:**
  1. In info@tracedmena.life, open the TRACED verification email and confirm the sender name **TRACED**, address **info@tracedmena.life**, and that **Reply** goes to info@tracedmena.life.
  2. In Gmail, use ⋮ → **Show original**: SPF, DKIM and DMARC should read **PASS**.
  3. Reply to the message and confirm the reply arrives in the same mailbox.

  Do **not** click the verification link unless you want that synthetic preview account verified.
- Privacy review: `docs/security/resend-privacy-review.md`. Real-patient email stays disabled until approvals R1–R3.

## 5. Background jobs, audit protection, monitoring
- Audit checkpoint run now: signed, verification `ok`, no findings. Uploaded to `traced-audit-checkpoints`; the server's attempts to **overwrite and delete it were refused**. Retention rule (400 days) remains **unlocked**.
- **Remaining independent-audit requirements:**
  - a sibling compartment `TRACED-Audit` that TRACED operators cannot manage (D-K);
  - lock the retention rule after approval (irreversible);
  - verification that reads checkpoints from the bucket.
- Backups: nightly encrypted dump of `traced` at 01:30 Riyadh time (`traced_preview` is synthetic and not backed up). The last successful backup is recorded for monitoring.
- Health metrics (namespace `traced`): `api_health`, `containers_up`, `disk_used_pct`, `backup_age_hours`; first sample 1 / 3 / 15% / 2 h.
- Alarms: API unhealthy, metrics missing, container down, disk > 80%, backup > 26 h, CPU > 85%, memory > 90%. **The owner must click Oracle's confirmation email sent to info@karamaitco.com.**
- Logs: `journalctl` on the server (systemd units `traced-*`), Docker logs. The application logs no personal data by design.

## 6. Owner action: the proxy secret into Vercel (value never shown here)
1. Oracle Console (region Saudi Arabia Central): Identity & Security → **Vault** → compartment **TRACED** → `traced-vault` → **Secrets** → `traced-proxy-secret` → **Secret versions** → the current version's ⋮ → **View secret contents** → copy.
2. Vercel → team **LinusBio MENA** → project **tracedlife** → **Settings** → **Environment Variables** → **Add**:
   - Key `TRACED_PROXY_SECRET`;
   - Value: paste;
   - Environment: **Preview** only, Git branch **feature/traced-portal**;
   - mark it **Sensitive**;
   - **Save**.
3. Tell me "added". I redeploy the preview and verify sign-in through the portal (the API should stop answering 503).

## 7. Deployed-system testing so far

| Check | Result |
|---|---|
| Unit/integration suite (local) | **272/272** |
| Browser suite (local, Edge) | 30/30 (27 Nov) |
| HTTPS, certificate, redirect, headers, ports | pass (§3) |
| Access gate: no or wrong proxy secret → 403; internal → 404 | pass |
| Database permissions on the server | pass (`oci-hosting-report.md`) |
| Backup + real restore | pass (34/34 tables) |
| Email (§4) | pass; owner header/reply check pending |
| Audit checkpoint + append-only upload | pass |
| Portal pages on the preview (EN/AR, staff, lab) | 200 with portal headers (`no-store`, `noindex`, `camera=(self)`) |
| **Full UI regression through the preview** (sign-up → verify → registration → QR → staff collection → label → custody → lab → rejection/recollection → report status → admin/MFA → audit → export, EN/AR) | **Not run yet.** It needs the proxy secret in Vercel and test inboxes. Use plus-addresses on the Google Workspace mailbox (e.g. `info+cust1@tracedmena.life`, `info+staff1@…`, `info+lab1@…`), which arrive in info@ |

## 8. Problems found and fixed in this phase
1. **Trailing-slash redirect:** `vercel.json` `trailingSlash: true` redirected `/api/v1/*` before the middleware ran. Removed; static pages still resolve.
2. **Camera blocked:** `Permissions-Policy: camera=()` would have blocked the QR scanners. Now `camera=(self)`.
3. **Email argument quoting:** the sender name/address contains spaces and angle brackets. `vm_07` now takes the name and address separately.
4. **Middleware typing:** the TypeScript build warned about `process` (no Node types). Declared in `middleware.ts`.
5. **Test script:** the random test passwords contained a newline (invalid JSON). Fixed.

## 9. Remaining decisions and launch blockers
- **Owner actions now:**
  - proxy secret into Vercel (§6);
  - confirm the Oracle alert subscription;
  - check the TRACED email in info@ (§4);
  - root SPF/DKIM for Google Workspace (§2);
  - **names and work emails of the first two super administrators** (I will not invent them).
- **Before real customers:**
  - approved consent texts EN/AR (8; D-N), plus the loader tool;
  - Resend privacy approvals R1–R3;
  - identity-verification method (collection stays blocked, D-I);
  - `TRACED-Audit` compartment and retention lock (D-K);
  - company account conversion (D-L);
  - release approval (D-O).
- **Not implemented, by design:** medical report delivery (status only). Customer status emails stay off.

## 10. Costs
- **Within free allowances:**
  - A1 1 OCPU / 4 GB;
  - 50 GB boot volume;
  - reserved IP (no charge);
  - Vault DEFAULT + software key + 10 of 150 free secrets;
  - backups of ~26 KB each;
  - custom metrics and 7 alarms;
  - email notifications (1,000 free per month);
  - outbound traffic far below 10 TB.
- **Budget actual: EUR 0.00.**
- **Resend:** plan as chosen by the owner. Its daily and monthly limits must be checked on the Resend dashboard; preview traffic so far: 9 emails.
- **Expected monthly: EUR 0.** The worst case without free allowances is about SAR 64 incl. VAT.

## 11. Exact next action
After the owner adds `TRACED_PROXY_SECRET`:
1. Redeploy the preview and verify sign-in through the portal.
2. Run the full UI regression (§7) with plus-addressed test accounts on `traced_preview`.
3. Create the two real super administrators in **production** (`traced`) only at the production switch, with `vm_08_create_admin.sh` after `vm_07 … production`. For the preview, create preview admins with plus-addresses.

## 12. Update (27 Nov, late): preview connected and tested end to end

- **Proxy secret:** the owner added `TRACED_PROXY_SECRET` in Vercel (Preview, branch only). The first test returned 403. A presence-only diagnostic showed the header arrived but in the **base64 form** the OCI Console displays. The shared value is now defined as exactly that form, on Caddy, the API and Vercel (`vm_07` updated). Via Vercel `/api/v1/auth/me` → API `401` (correct); direct → `403`.
- **Incident (preview only):** a malformed temporary Caddy diagnostic stopped Caddy for about 2 minutes. It was restored from backup. Diagnostics now validate the config before applying it and roll back automatically.
- **Fixes:**
  - `vm_07` restarts the service on re-run (`enable --now` did not apply a new image);
  - label printing requires `size` (journey fixed; `db-roles.test.ts` now asserts 200 instead of `< 500`).
- **Preview-only mail capture:** `MAIL_CAPTURE_DOMAINS` writes mail for `@preview.tracedmena.test` to files instead of sending it. It is refused when `NODE_ENV=production`, and unit tests cover the guard and domain matching, including lookalike domains.
- **Deployed end-to-end journey (`vm_13_e2e.sh`): 61/61 pass.**
  - Super admin invitation + MFA; admin invites collection staff, laboratory and auditor (MFA).
  - Customer sign-up → email verification → sign-in; registration; QR.
  - Staff validation (age/gender only) → development identity check (preview only) → collection → label print → package → ready → dispatch.
  - Lab receipt → analysis → report-available status; customer progress.
  - Rejection → admin recollection (lab refused) → new QR → `-S02`.
  - Admin lists, audit log, CSV report, audit checkpoint + verify, auditor read-only; personal-data export with a fresh code; MFA reset.
  - Access denials; password reset; Arabic email.
  - Captured mail is deleted after each run.
- **Not yet done:** visual browser pass of the portals on the preview. Vercel Authentication requires the owner's Vercel sign-in in the browser; I do not enter credentials. Manual guide: `docs/deploy/preview-testing-guide.md`.

## 13. Preview super administrator login changed to info@tracedmena.life (27 Nov, owner request)

- **New audited procedure:** `changeUserEmail` (`server/src/modules/accounts/accounts.service.ts`), CLI `server/src/cli/change-user-email.ts`, server wrapper `deploy/oci/vm/vm_14_change_email.sh`.
  - Keeps the account id, roles, MFA requirement and all history. The new address starts unverified.
  - Revokes all sessions and expires every unused emailed link.
  - Writes an `account.email_changed` audit entry (reason, no addresses). An optional fresh setup invitation is audited as `staff.invite_resent`.
  - Runs as `traced_app` (no extra database rights). **Refused when `NODE_ENV=production`.** Tests: `account-email-change.test.ts` (3).
- **Applied on `traced_preview`:**
  1. The synthetic customer `7781e185…` moved from info@tracedmena.life to `test-customer-info@preview.tracedmena.test` (same id; 1 unused link expired).
  2. The preview super admin `68e1a2d9…` moved from `info+admin@tracedmena.life` to **info@tracedmena.life** (same id, role `super_admin`; the old setup link expired). A fresh setup email was **sent** on the first attempt.
- **Verified:**
  - exactly one usable setup link exists;
  - `super_admin` has `requires_mfa = true`;
  - both audit entries are present and the **audit chain is intact**;
  - no other account uses info@ or `info+admin@`.
- **Pending (owner):** open the newest "Set up your account" email in info@, choose a password, then enrol two-step verification. Claude then confirms `last_login_at` and `mfa_enabled_at` on the account.
- Production (`traced`) was not touched. It has no accounts yet.
