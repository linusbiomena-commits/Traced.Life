# TRACED: launch plan for Tuesday 1 December 2026

**Updated:** 27 Nov 2026 (evening, Riyadh). Target: a fully functional TRACED deployment by 1 Dec, subject to release approval. Security is not traded for the date.

## 1. Where we are

| Area | State |
|---|---|
| Oracle account | Pay As You Go (upgrade completed 27 Nov), account type still PERSONAL |
| Server | **`traced-app-1` running** in Riyadh: A1.Flex 1 OCPU / 4 GB / 50 GB, Ubuntu 24.04 aarch64, no SSH key, SSH and rpcbind disabled, no inbound ports (ports 22/80/443/5432/111 tested closed from the internet) |
| Database | PostgreSQL 18.7 in Docker, data checksums on, no published port, internal network only. Migrations **0001–0011 applied**, checksums re-verified. Production roles applied. Security checks passed (`docs/deploy/oci-hosting-report.md`) |
| Backups | Nightly encrypted (gpg AES-256) `pg_dump` to `traced-db-backups` at 01:30 Riyadh. **Real backup + restore tested**: 34/34 tables matched, temporary database dropped |
| API | Image built on the server (`traced-api:67e0161`, arm64). **Not started**: production needs Resend and an API host name (§3) |
| Public website | https://tracedlife.vercel.app unchanged (public pages only) |
| Tests | 271/271 unit/integration; browser suite re-run 27 Nov (see `docs/TEST_STATUS.md`) |

## 2. Critical path

| Date | Work | Depends on |
|---|---|---|
| 27 Nov | Server + database + backups (**done, ahead of plan**). Deployment scripts for the API, HTTPS, scheduled jobs, checkpoint upload (`deploy/oci/vm/vm_07_api_install.sh`) and the Vercel middleware template (`docs/deploy/vercel-middleware.example.ts`) prepared | — |
| 28 Nov (by 18:00) | Owner decisions D-A to D-H below. Hosting decision: Oracle (now proven) vs SCCC backup | owner |
| 29 Nov | Reserve the public IP, DNS record, open 443/80, store the Resend key, run `vm_07`. API live behind HTTPS. Vercel preview with middleware; verify cookies, CSRF, trusted proxy. Create first super admins | D-A…D-F |
| 30 Nov | Full regression against the deployed preview (§5), physical devices and printers, security re-check, fixes | D-G devices |
| 1 Dec | Release gate (`docs/deploy/phase-8-preparation.md` §12, `launch-checklist.md`). Merge to `main` only with approval | release approval |

## 3. Everything I need from you (one list)

Step-by-step setup for D-A…D-H: `docs/deploy/api-go-live-guide.md`.


| # | Decision / credential | Why | Needed by |
|---|---|---|---|
| D-A | **API host name**, for example `api.traced.life` or `api.<company-domain>`, and who manages that DNS zone | TLS certificate (Let's Encrypt) and the Vercel rewrite target | 28 Nov |
| D-B | Approve: reserve a public IP (free), add DNS A record, open TCP 443 (and 80 for certificate issuance) on `traced-nsg-app` | the API becomes reachable; the database stays private | 28 Nov |
| D-C | **Resend**: account, verified sending domain (SPF, DKIM, DMARC records in DNS), and a send-only API key. **Store the key yourself** in OCI Vault as secret `traced-resend-api-key` (Console → Identity & Security → Vault → `traced-vault` → Secrets → Create; key `traced-master-key`). I must not handle API keys | production refuses to start without it; sign-up verification, password reset and staff/admin invitations are all email | 28 Nov |
| D-D | **Sender address** (`MAIL_FROM`, e.g. `TRACED <no-reply@traced.life>`) and reply-to | email headers | 28 Nov |
| D-E | **Privacy approval for Resend** (processes email addresses in the US: PDPL cross-border transfer), or name an in-region provider | legal | 28 Nov |
| D-F | **Site origin** (`APP_ORIGIN`): `https://tracedlife.vercel.app` or a custom domain; approve deploying the **portal pages + middleware** to Vercel (preview first, production at release) | portal pages are currently excluded from the live site | 29 Nov |
| D-G | **First super administrators**: two named people and their work emails (MFA is enforced at first sign-in). Physical **devices/printers** for branch testing | bootstrap (`create-user` sends a one-time link by email) | 29 Nov |
| D-H | Approve a proxy secret: I generate it into Vault (`traced-proxy-secret`); you paste the same value into Vercel env `TRACED_PROXY_SECRET` (I can show you where; I will not type it into Vercel) | trusted client-IP chain | 29 Nov |
| D-I | **Identity verification method** for collection (`docs/identity-verification.md`) | without it, production sample collection stays **blocked** (see §4) | before real collection |
| D-J | Pilot model for 1 Dec: (a) production with **registration only**, collection blocked; or (b) additionally a **separate non-public pilot** instance with synthetic data (development identity verification is refused in production by design) | §4 | 28 Nov |
| D-K | O3: separate `TRACED-Audit` compartment; retention period and when to **lock** the audit bucket (irreversible) | independent audit evidence claim | before claiming it |
| D-L | Company account conversion in Oracle (KaRama IT LTD, VAT number) | invoices | any time (owner action) |
| D-M | Monitoring: approve an OCI Notifications topic emailing info@karamaitco.com (free; Oracle sends a confirmation email) + alarms (CPU, memory, disk, instance down, backup failure) | operations | 29 Nov |
| D-N | **Approved consent texts (hard blocker for any production registration):** privacy notice, sample-collection consent, accuracy declaration, guardian authorisation, each EN + AR (8 texts) with an approval reference. Production serves only `approved` texts; the current ones are provisional placeholders. Also collection instructions (approved in the admin portal) and customer status email wording (stays off) | production refuses provisional content | before the production switch (ideally 30 Nov) |
| D-O | Final release approval on 1 Dec | gate | 1 Dec |

## 4. What cannot be safely enabled by 1 December (unless the approvals arrive)

| Feature | Status | Why |
|---|---|---|
| Real sample collection | **Blocked** in production | no approved identity verification method (D-I). The development-only verification is refused when `NODE_ENV=production`; it must not be presented as production-suitable |
| Medical report delivery | **Not implemented** | only report **status** tracking exists (the "report available" status). No report file is stored or delivered |
| Customer status emails | Off (`CUSTOMER_STATUS_EMAILS=false`) | wording not approved (D-N) |
| Independent audit evidence claim | Not yet | checkpoint copies go to the audit bucket (append-only for the server), but the bucket is in the TRACED compartment and its retention is unlocked (D-K) |
| Point-in-time recovery | Not available | nightly backups only, so up to 24 hours of data could be lost |
| Real patient data | Not accepted | until D-E, D-I, D-N and the release gate are approved |

If the approvals are outstanding on 1 Dec, the recommended launch is a **restricted pilot**: production stack live, customer registration and QR generation working, staff/admin portals in use by named staff only, collection blocked, and synthetic data for everything else (D-J).

## 5. Final end-to-end regression checklist

"Auto" means covered by the automated suites (unit/integration `npm test`, browser `npm run test:e2e`, Edge, synthetic data). "Deployed" means repeat on the deployed preview on 30 Nov.

| # | Flow | Automated coverage | Deployed check |
|---|---|---|---|
| 1 | Customer sign-up | portal.spec "English: sign up, verify, sign in…"; auth.test | real Resend email arrives |
| 2 | Email verification | same; email.test, outbox-reliability.test | link works from the inbox |
| 3 | Customer registration (self / child) | portal.spec EN + AR; registrations.test | yes |
| 4 | Patient registration rules (age, gender, no ID/Iqama/nationality) | registrations.test, privacy-verification.test | spot check |
| 5 | QR generation | qr.test; portal.spec | QR scans on a real phone |
| 6 | Collection staff authentication | staff.spec invitation → setup → sign in; rbac-mfa.test | yes |
| 7 | Identity verification | staff.spec (development verification only) | **blocked in production** (D-I) |
| 8 | QR scanning | staff.spec simulated camera, invalid input, camera errors | real devices (D-G) |
| 9 | Sample collection | staff.spec full collection; staff.test | pilot instance only |
| 10 | Physical sample label | tracking-custody.spec (label); custody.test | real printer (D-G) |
| 11 | Packaging | tracking-custody.spec | pilot |
| 12 | Courier dispatch | tracking-custody.spec | pilot |
| 13 | Laboratory receipt | tracking-custody.spec (lab camera) | pilot |
| 14 | Acceptance and rejection | tracking-custody.spec rejection | pilot |
| 15 | Recollection | tracking-custody.spec admin-authorised recollection, new -S02 | pilot |
| 16 | Analysis progress | tracking-custody.spec | pilot |
| 17 | Report availability status (status only) | tracking-custody.spec customer timeline | pilot |
| 18 | Admin management (staff, branches, instructions, transfers, corrections, QR revocation) | admin.spec; admin.test, authz-matrix.test | yes |
| 19 | MFA (setup, recovery codes, reset) | admin.spec, security.spec; auth-hardening.test | yes |
| 20 | Audit integrity (checkpoint, verify, chain) | security.spec; audit-integrity.test | checkpoint file reaches the audit bucket |
| 21 | Personal-data export | security.spec; pii-export.test | yes |
| 22 | Database backup and recovery | backup drill (`npm run drill:backup`); **real OCI backup + restore passed 27 Nov** | nightly run at 01:30 checked on 28 Nov |
| 23 | Database permissions | db-roles.test, oci-db-layout.test; **vm_03 on the server passed** | — |

## 6. Hosting contingency

- **Oracle Arm capacity** was the blocker until the Pay As You Go upgrade. The server now exists, so it does not need to be relaunched.
- **AMD alternative in Riyadh** (for the record): E4.Flex 1 OCPU (2 vCPU) / 4 GB is about EUR 23.4 a month, roughly SAR 111 incl. VAT, which is at the budget limit. E5.Flex is about SAR 134, over budget. A burstable E4 (50% baseline) would be about SAR 70 but has not been verified.
- **SCCC by stc** assessment: §7.

## 7. SCCC by stc (backup provider)

See `docs/deploy/sccc-assessment.md`.

## 8. Rollback (Oracle)

- **API:** images are tagged by commit (`traced-api:<commit>`). Set `REF` in `/etc/traced/api.conf` to the previous tag, then run `systemctl restart traced-api`.
- **Database:** migrations are forward-only. Restore a nightly backup into a **new** database with `traced-restore-check` logic (`pg_restore` into a temporary database), then switch `DATABASE_URL`. Never restore over the primary without an approved incident decision.
- **Website:** Vercel "Promote" a previous deployment, or `vercel rollback`.
- **Infrastructure:** nothing destructive is automated. Budget alerts never stop resources.
