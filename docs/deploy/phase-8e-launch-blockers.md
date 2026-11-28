# TRACED Phase 8E: final production launch blockers (28 Nov 2026)

**Scope approved by the owner:** consent publishing tool (built), instruction publishing check, identity-verification proposal, alerts, DNS, audit protection plan, laboratory decision, MFA export test plan.

**Restrictions kept:**
- no production switch, the pilot gate stays on, no real registration or collection;
- no merge to `main`, no new paid infrastructure;
- no IAM or compartment changes, no retention lock.

## 1. Consent publishing tool: done (local; not on the server yet)

- `publish-consent` command, migration `0012`, server wrapper `vm_21_publish_consent.sh`, uploader `upload-consent-release.sh`, and your instructions in `docs/deploy/consent-publishing.md`.
- Every requirement in your list is covered; the table in that document maps each one.
- **Tests:** `server/test/consent-publish.test.ts`, 12 tests on synthetic documents, run as the restricted `traced_app` role. Full suite **314/314**.
- **Not done (needs your authorisation):** building a server image with this code and applying migration 0012 to `traced_preview` and `traced`. Both are additive schema changes.

## 2. Collection instructions: existing mechanism verified, nothing new built

Admin portal → **Instructions**:
- An admin creates a bilingual draft (EN + AR title, steps, checklist) and submits it.
- **Only the super admin** publishes, with the **clinical approval reference** and an optional effective date. A reference gives status `approved`; without one the version stays `provisional`, and production uses approved versions only.

What it already preserves:
- **Versioning:** a version number can't be reused.
- **Text immutability:** a database trigger blocks changes to published text, and the runtime role can only insert and read.
- **Approval references.**
- **Publication records:** `published_by`, `approved_by`, `approved_at`, `effective_from`.
- **History:** every published version stays, and each sample records the instruction version used.
- **Audit:** `instructions.published`, plus draft submit, withdraw and return.
- **Tests:** `admin.test.ts` "collection instruction versions".

Optional hardening (not required): the trigger freezes the instruction **text** but not its approval fields. Only a database owner could change those, because the runtime role has no UPDATE right. A two-line migration like 0012 would close it if you want.

## 3. Identity verification

Proposal for your review: `docs/identity-verification-staff-led-proposal.md` (blind-match variant A recommended, 33–41 h; variant B 25–31 h). **Not implemented.**

## 4. Oracle monitoring alerts

**Checked 28 Nov:**
- One email subscription to **info@karamaitco.com** on topic `traced-ops-alerts`: state **PENDING**. No alert has ever been delivered.
- All **7 alarms** are enabled:
  - `traced-api-unhealthy`, `traced-containers-down`, `traced-health-metrics-missing` and `traced-backup-stale` (critical);
  - `traced-cpu-high`, `traced-memory-high` and `traced-disk-high` (warning).

**Done:** confirmation **re-sent** at 15:28 UTC (18:28 Riyadh) for the **existing** subscription (`oci ons subscription resend-confirmation`). No duplicate was created.

**You:**
1. Open the info@karamaitco.com mailbox (check spam).
2. Find the email from Oracle Cloud ("OCI Notifications Service Subscription Confirmation", topic `traced-ops-alerts`).
3. Click **Confirm subscription**. The browser shows "Subscription confirmed". The link expires after a few days; if so, ask for another resend.

**After you confirm, Claude will:**
- check the subscription state is `ACTIVE`;
- publish **one test message** to the topic (`oci ons message publish`, subject "TRACED alert test");
- ask you to confirm it arrived.

This tests delivery without triggering a real alarm.

## 5. Email domain (Squarespace → Domains → tracedmena.life → DNS)

**Keep exactly as they are (checked 28 Nov):**

| Host | Type | Value | Purpose |
|---|---|---|---|
| `@` | MX | `1 aspmx.l.google.com`, `5 alt1.aspmx.l.google.com`, `5 alt2.aspmx.l.google.com`, `10 alt3.aspmx.l.google.com`, `10 alt4.aspmx.l.google.com` | Google Workspace mail |
| `@` | A | `216.198.79.1` | website (Vercel) |
| `www` | CNAME | `b83c9dbf798b91c5.vercel-dns-017.com` | website (Vercel) |
| `api` | A | `84.13.153.140` | TRACED API (Oracle) |
| `send` | CNAME | `send.forge.rmta.net` | **Resend return path: carries Resend's SPF and bounce MX.** Don't add a separate TXT or MX at `send` (a CNAME can't coexist with them) |
| `resend._domainkey` | TXT | the existing `p=MIGfMA0…` key | **Resend DKIM** |
| `@` | TXT | `google-site-verification=h1A2…` | Google verification |

**Add or change:**

| # | Host | Type | Value | Notes |
|---|---|---|---|---|
| 1 | `@` | TXT | `v=spf1 include:_spf.google.com ~all` | **Google Workspace SPF.** There is no SPF at `@` today, so this creates no duplicate. Resend doesn't belong here: it uses `send` |
| 2 | `google._domainkey` | TXT | **the value Google generates** (see below) | **Google Workspace DKIM.** Never invent this key |
| 3 | `_dmarc` | TXT (**replace** the existing record) | `v=DMARC1; p=none; rua=mailto:dmarc-reports@tracedmena.life; adkim=r; aspf=r; pct=100` | **DMARC reporting**, still monitor-only. First create the mailbox or group `dmarc-reports@tracedmena.life` in Google Workspace (or use info@). Exactly one `_dmarc` record may exist |

**Generating the Google DKIM key:**
1. Go to admin.google.com → **Apps → Google Workspace → Gmail → Authenticate email**.
2. Choose the domain **tracedmena.life** → **Generate new record**: key length **2048**, prefix selector **google**.
3. Copy the **TXT record value** shown (it starts `v=DKIM1; k=rsa; p=`) into Squarespace as host `google._domainkey`. If Squarespace rejects the 2048-bit value, generate a 1024-bit key instead.
4. Wait until it resolves (usually under an hour; up to 48 h), then click **Start authentication** in Google Admin.

**DMARC enforcement:** keep `p=none` until 2–4 weeks of reports show both Google Workspace and Resend passing SPF or DKIM in alignment. Then go to `p=quarantine`, and later `p=reject`, only with your approval.

**After your changes, Claude will verify by public DNS:**
- exactly one SPF at `@`;
- DKIM present for `google` and `resend`;
- DMARC with `rua`;
- MX, website and API records unchanged.

**Final transactional email tests:** E1–E5 in `production-release-readiness.md` §8.2 (customer verification, password reset, staff invitation, lab invitation, admin invitation; your own `info+…@tracedmena.life` addresses). In "Show original", SPF and DKIM must show **PASS** for `tracedmena.life` (DKIM `d=tracedmena.life`), DMARC **PASS**, From `TRACED <info@tracedmena.life>`, and links on `https://www.tracedmena.life`. Run them after the DNS changes have propagated.

## 6. Independent audit storage (plan only; nothing created)

| Item | Plan |
|---|---|
| Compartment | **TRACED-Audit**, a child of the tenancy root (sibling of TRACED) |
| Audit admin group | **TRACED-Audit-Admins**: a named person outside day-to-day operations (compliance / DPO); not a member of TRACED-Operators |
| Move | `oci os bucket update --bucket-name traced-audit-checkpoints --compartment-id <TRACED-Audit>` (objects and the retention rule move with the bucket; the namespace and name are unchanged, so the server's upload code needs **no change**) |
| Audit admin permissions | `Allow group TRACED-Audit-Admins to manage buckets in compartment TRACED-Audit` (bucket settings and retention rules); `Allow group TRACED-Audit-Admins to read objects in compartment TRACED-Audit` |
| Operators (restricted) | `Allow group TRACED-Operators to read buckets in compartment TRACED-Audit`; `Allow group TRACED-Operators to read objects in compartment TRACED-Audit`. Their existing `manage all-resources in compartment TRACED` no longer reaches the bucket once it has moved |
| Workload (checkpoint upload) | Replace the two audit statements in `TRACED-Workload-Policy` with: `Allow dynamic-group TRACED-Instances to read objects in compartment TRACED-Audit where target.bucket.name = 'traced-audit-checkpoints'` and `Allow dynamic-group TRACED-Instances to manage objects in compartment TRACED-Audit where all {target.bucket.name = 'traced-audit-checkpoints', request.permission = 'OBJECT_CREATE'}` (create only: no overwrite, no delete) |
| No modification | Create-only server permission. The retention rule blocks overwrite and delete for everyone while it exists. Checkpoints are HMAC-signed and hash-chained, so any altered copy fails verification |
| No deletion | The retention rule keeps every object for **400 days** (your decision; legal may require longer) |
| Retention locking | Set `time-rule-locked` at least **14 days ahead** (OCI requires that; it is the window to cancel). After the lock date the rule **can't be removed or shortened by anyone**, the bucket can't be deleted while objects are retained, and only lengthening is possible. **Irreversible.** Recommended after the move and 2–4 weeks of clean production checkpoints |
| Existing checkpoints | Before the move, record the object count and ETags; after it, compare (expect the same 5+ objects). No object is copied or rewritten |
| Encryption | The bucket uses Vault key `traced-master-key` (TRACED compartment). Recommend switching the bucket to an **Oracle-managed key** after the move, so new checkpoints don't depend on a key operators control. Existing objects stay under the old key (OCI doesn't re-encrypt them), so that key should never be scheduled for deletion |
| Change alerts | A free OCI **Events** rule on the TRACED-Audit compartment (bucket update, retention-rule changes, policy changes) notifying the audit admin |
| Verification | Daily automatic and on-demand verification in the admin portal (Audit integrity); after the move, run `vm_12_jobs_check.sh` (checkpoint + upload) and confirm the new object |
| Recovery | Checkpoints also live in the database and the nightly backups. If the database is lost: restore the backup into a new database and verify it against the bucket checkpoints (proven by the backup drill) |
| Cost | **EUR 0**: compartments, groups, policies and Events are free; checkpoint objects are KB-sized, within the free Object Storage allowance |

**Protection levels:**
- **Ordinary operators** (TRACED-Operators): can read, but can't delete or overwrite checkpoints or change the retention rule.
- **The server:** can only create.
- **Tenancy Administrators keep full control** of IAM. Before the lock they could remove the rule, delete objects or change policies. After the lock they still can't delete retained objects or remove the rule, but they could still disable the old Vault key or delete the compartment's other resources.

**Mitigations:**
- keep the Administrators group to two named people with MFA;
- OCI's own Audit service log (365 days, not editable, free) records every such action;
- the Events alerts above.

## 7. Laboratory location

- **One designated laboratory is sufficient for launch.** Custody records the laboratory step as "Laboratory", and every lab operator account works for that one laboratory. Dispatch records the courier and tracking number, and the receiving lab confirms receipt (accept or reject).
- **Condition:** all samples go to that one laboratory and only its staff get `lab_operator` accounts. The laboratory's name and address should be in the approved collection instructions, not in the software.
- **Multiple laboratories** would need (not to be built without approval):
  - a laboratories table (admin-managed, EN/AR name, address, active);
  - lab-operator-to-laboratory assignments;
  - a destination laboratory chosen at dispatch;
  - lab screens and receipt limited to samples dispatched to that laboratory;
  - the destination shown in the admin custody timeline and the operational CSV;
  - migration, authorisation-matrix and e2e updates.
  - Estimate: **16–24 h**.

## 8. MFA-protected super admin export (prepared; about 20 minutes with you)

Synthetic account `uat-superadminmfa-u1128@preview.tracedmena.test` (password already set by you; MFA not enrolled).

1. You sign in to the pilot admin portal in the browser pane (you type the password).
2. Claude opens the two-step setup (`/traced/admin/two-step/`). The secret is read inside the page, and the six-digit codes are computed there and kept only in the tab's session storage. Recovery codes are not read into Claude's output or screenshots.
3. Enrolment confirmed: `mfa_enabled_at` is set. In the pilot, sign-in still doesn't ask for the code; that's the approved optional setting, which skips the requirement for every account. In production the code is required at sign-in for lab operators, admins, super admins and auditors (`catalogue.ts`). The production behaviour is covered by the automated tests, not by this pilot check.
4. Personal-data export (super admin page):
   - (a) a wrong code is refused;
   - (b) a valid fresh code succeeds: Claude checks the response row count and fingerprint without saving a file;
   - (c) reusing the same code is refused (`claimTotpStep`);
   - (d) an admin account is still refused (403).
5. Audit log: `report.exported_pii` success with the reason, failure entries for (a) and (c); integrity check passes.
6. Sign out; the session ends.

Controls unchanged: production refuses `PILOT_MFA_OPTIONAL`, so lab operators, admins, super admins and auditors must enrol and use MFA. Every personal-data export needs a fresh code from an enrolled authenticator, in the pilot too.

## 9. Security confirmations (28 Nov, after the Phase 8E changes)

| Control | Evidence |
|---|---|
| Pilot MFA optional | server env has `PILOT_MFA_OPTIONAL=true` in preview mode (`vm_07`); all six roles signed in without MFA in the 28 Nov UAT |
| Production refuses optional pilot MFA | `loadConfig` throws; `pilot-mfa-optional.test.ts` (in the 314/314 run) |
| Sign Out | `sign-out.test.ts` (6 roles) in the run; browser UAT for every role |
| CSRF | `auth.test`, `sign-out.test` (refusal without the token) in the run; browser UAT (direct API call without the token: 403) |
| Trusted proxy | `proxy.test` in the run; live spoofing check (counted under the real IP) |
| Role permissions unchanged | `authz-matrix.test` (every route × 7 roles) in the run; Phase 8E added no HTTP route and changed no permission. The CLI checks `consent.manage` (super admin) itself |
