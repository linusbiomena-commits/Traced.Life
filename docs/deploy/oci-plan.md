# TRACED on Oracle Cloud Infrastructure (OCI): setup record and hosting plan

**Status (27 Nov 2026):** free governance setup done (compartment, tags, budget, IAM). **No compute instance, volume, bucket, vault, network or other billable resource exists.** Hosting waits for the owner's approval of the configuration and cost in §6–§8.

This replaces the Google Cloud plan (`phase-8-preparation.md`) as the hosting direction. Google Cloud could not be used: Dammam (me-central2) was refused for the project's billing account (see `docs/HANDOVER.md`, Phase 8B). The Google project `traced-production` is kept, empty, and is not deleted.

## 1. Tenancy facts (verified with the OCI CLI)

| Item | Value |
|---|---|
| Tenancy | `karamait` |
| Home region | **me-riyadh-1 (Riyadh)**; the only subscribed region |
| Availability domains | one (`ME-RIYADH-1-AD-1`) |
| Subscription | plan **FREE_TIER**, upgrade state **PROMO** (free trial with promotional credit, started 27 Nov 2026) |
| Account type | **PERSONAL** (not a company account) |
| Billing currency / country | **EUR** / Saudi Arabia |
| Identity domain | `Default` |
| Existing admin access | group `Administrators` with `manage all-resources in tenancy` (unchanged) |
| Service limits (Riyadh) | A1: 16 OCPUs / 96 GB regional; block storage: 200 GB free, 5 free volume backups |

CLI access uses a **session token** (`oci session authenticate`, profile `TRACED`, about 1 hour, renewable with `oci session refresh --profile TRACED`). No API signing key was created. The CLI is installed in `%USERPROFILE%\oci-cli-venv` (`oci.exe` in `Scripts`).

## 2. Created (free) resources

```
karamait (root tenancy)
├── TRACED                         compartment (all TRACED infrastructure)
│     tag defaults: KaRamaIT.Project=TRACED, KaRamaIT.Environment=production, KaRamaIT.CostCenter=TRACED
│     policy TRACED-Workload-Policy
├── tag namespace KaRamaIT         keys Project, Environment, CostCenter (all cost-tracking)
├── budget TRACED-monthly          EUR 23.25 / month on compartment TRACED, 4 alert rules
├── groups TRACED-Operators, KaRamaIT-Finance-Readers (no members)
├── dynamic group TRACED-Instances (instances in compartment TRACED)
└── policies TRACED-Operators-Policy, KaRamaIT-Finance-Readers-Policy
```

### Tags
- `KaRamaIT.Project`: list `TRACED` (add values for future applications).
- `KaRamaIT.Environment`: list `production`, `staging`, `development`.
- `KaRamaIT.CostCenter`: list `TRACED`.
- All three are **cost-tracking** tags, so Cost Analysis and the cost reports can be filtered and grouped by them.
- Tag defaults on compartment TRACED apply all three automatically to every resource created there.

### Budget and alerts
- Amount: **EUR 23.25 per month**. SAR 110 including 15% VAT is SAR 95.65 before VAT; at 4.1116 SAR/EUR (XE mid-market, 27 Nov 2026) that is EUR 23.26. OCI budgets measure usage cost before tax, so the 100% alert fires at about SAR 110 including VAT.
- Target: compartment TRACED (covers everything in it).
- Alert rules, all emailed to info@karamaitco.com:
  - actual spend 50%, 80% and 100%;
  - forecast spend 100%.
- Alerts are notifications only. **Nothing is stopped or deleted automatically.** A budget is not a spending cap.

## 3. IAM

| Principal | Kind | Permissions | Members |
|---|---|---|---|
| `Administrators` | group (existing) | `manage all-resources in tenancy` | tenancy administrator (unchanged) |
| `TRACED-Operators` | group | `manage all-resources in compartment TRACED`; `read usage-reports`, `read usage-budgets` in tenancy | none yet |
| `KaRamaIT-Finance-Readers` | group | `read usage-reports`, `read usage-budgets`, `inspect compartments` in tenancy; `read objects` in Oracle's `usage-report` tenancy (download cost/usage CSV reports) | none yet |
| `TRACED-Instances` | dynamic group (workload identity, instance principal) | matching rule: instances in compartment TRACED. Policy `TRACED-Workload-Policy`: `read secret-bundles`; `manage objects` only in bucket `traced-db-backups`; `read objects` and `OBJECT_CREATE` only (no overwrite or delete) in bucket `traced-audit-checkpoints`; `use log-content`; `use metrics` in namespace `traced` | none until a VM exists |

- No users, API keys, auth tokens or customer secret keys were created.
- Application identities have no tenancy-wide or administrative rights.
- To give someone access, add an existing identity-domain user to one of the groups.

## 4. Viewing and downloading TRACED expenditure

- **Cost Analysis:** Console → Billing & Cost Management → Cost Analysis.
  - Set the date range to the month, and the grouping dimension to Compartment (or Tag: `KaRamaIT.Project`).
  - Filter Compartment = TRACED. "Save as new report" keeps the view for next month.
  - Download as CSV or PNG from the report menu.
- **Monthly cost reports (CSV):** Console → Billing & Cost Management → Cost and Usage Reports.
  - Download the daily files for the month.
  - Filter the `product/compartmentName` or `tags/KaRamaIT.Project` column for TRACED.
- **Scheduled monthly report:** Cost Analysis → Scheduled reports can write a monthly CSV to an Object Storage bucket. That needs a bucket, so it is not created yet; it fits inside the free 10 GB.
- **Budget status:** Console → Billing & Cost Management → Budgets → `TRACED-monthly`.
- **Invoices and payments:** Console → Billing & Cost Management → Invoices / Payment history. Requires the tenancy administrator.

## 5. Proposed hosting architecture (not created)

Everything in **me-riyadh-1**, compartment TRACED:
- **Compute:** one `VM.Standard.A1.Flex` VM (Arm), 1 OCPU, 4 GB RAM, Ubuntu 24.04 LTS (aarch64). 50 GB balanced boot volume, encrypted at rest (Oracle-managed key, or a free Vault software key).
- **Containers (Docker Compose):**
  - `postgres:18`: data on the boot volume, listening only on the internal Docker network, never published to the host or internet;
  - `traced-api`: the existing Hono/TypeScript server, built for `linux/arm64`;
  - `caddy`: TLS termination with an automatic Let's Encrypt certificate. It needs an API host name, which is decision D9 and means a DNS change that needs approval.
- **Network:**
  - a new VCN with one public subnet and a network security group;
  - ingress 443 only (80 only for the certificate challenge/redirect);
  - **no SSH from the internet**: administration through the free OCI Bastion service with time-limited sessions.
  - `/api/v1/internal/*` is not routed by Caddy; scheduled jobs call it from the VM itself.
- **Secrets:** OCI Vault (software keys free; 150 secrets free) holds:
  - `DATABASE_URL` for `traced_app`;
  - the owner and migration credentials;
  - `TOKEN_HMAC_KEY`, `DATA_ENCRYPTION_KEY`, `AUDIT_CHECKPOINT_KEY` and `PROXY_SHARED_SECRET`;
  - later, the Resend key.

  The VM reads them at service start through its instance principal (no key files).
- **Database roles:** owner role (migrations, `server/sql/production-roles.sql`) separate from `traced_app` (runtime) and `traced_readonly`, as tested in Phase 7. A self-managed PostgreSQL has a real superuser, so the role script runs as originally designed.
- **Scheduled jobs:** systemd timers on the VM. The outbox runs every 5 minutes; the audit checkpoint runs daily at 02:30 Riyadh time. They call `http://127.0.0.1` with `INTERNAL_CRON_SECRET`, which the code already supports; Google OIDC is not available on OCI.
- **Backups (all in Riyadh):**
  - nightly encrypted `pg_dump` (custom format) uploaded by the instance principal to Object Storage bucket `traced-db-backups`, kept 35 days by a lifecycle rule;
  - weekly boot-volume backups through a backup policy, within the 5 free backups;
  - restore drill: restore into a temporary database on the same VM, or a temporary second free A1 VM, and compare fingerprints as in `npm run drill:backup`.

  **Recovery point is up to 24 hours** (no point-in-time recovery). Continuous WAL archiving can be added later.
- **Audit checkpoints:** bucket `traced-audit-checkpoints` with an Object Storage **retention rule, left unlocked** until the owner approves the period and access model. Locking is irreversible. The workload can only create and read objects. **Code task before go-live:** an OCI Object Storage writer for checkpoints (instance principal, no overwrite), replacing the planned GCS writer.
- **Monitoring and logging:**
  - OCI Monitoring alarms on CPU, memory, disk and instance health, emailed through Notifications (1,000 emails/month free);
  - Logging through the agent for app and system logs.

  The application logs no personal data by design.

### Independent audit evidence: does it need its own compartment?
**Yes, before production launch.** `TRACED-Operators` can manage everything in compartment TRACED, including any bucket there, and IAM permissions inherit into child compartments. A bucket inside TRACED, or in a child compartment of it, is therefore not independent of the people who run the database.

The recommended structure, created only when you approve it, is a **sibling** compartment `TRACED-Audit` under the root:
- only `Administrators` can manage it;
- the workload may only create and read checkpoint objects;
- the bucket's retention rule is locked once the period is approved.

Until then, production must not claim independent audit evidence.

## 6. Pricing (Oracle public price list API, EUR, pay-as-you-go, 27 Nov 2026)

| SKU | Price | Free allowance |
|---|---|---|
| B93297 Compute A1 OCPU | EUR 0.0093 per OCPU-hour | first 3,000 OCPU-h/month in the price list. Current Always Free docs state 1,500 OCPU-h, which is 2 OCPUs; 1 OCPU uses 744 |
| B93298 Compute A1 memory | EUR 0.001395 per GB-hour | 18,000 GB-h (price list) / 9,000 GB-h (docs); 4 GB uses 2,976 |
| B91961 Block volume storage | EUR 0.023715 per GB-month | 200 GB boot + block (B91445) |
| B91962 Block volume performance units | EUR 0.001581 per VPU per GB-month (balanced = 10 VPU) | included in the free 200 GB |
| Volume backups | storage rate | 5 backups |
| B91628 Object Storage | EUR 0.023715 per GB-month | first 10 GB |
| B93456 Outbound data (Middle East) | EUR 0.0465 per GB | first 10 TB/month |
| Vault software keys / secrets | free | 150 secrets |
| B92593 Logging storage | EUR 0.0465 per GB | first 10 GB |
| B90941 Notifications email | EUR 0.0186 per 1,000 | first 1,000 |
| Bastion | free | none stated |

Sources:
- prices: `https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=EUR`;
- allowances: https://docs.oracle.com/iaas/Content/FreeTier/resourceref.htm;
- FX: XE 1 EUR = 4.1116 SAR.

## 7. Monthly cost estimate (100 registrations/month)

| Scenario | EUR ex VAT | SAR ex VAT | SAR incl. 15% VAT |
|---|---|---|---|
| A. Within Always Free (1 OCPU, 4 GB, 50 GB boot, 5 volume backups, ≤ 10 GB object storage, free Vault/Bastion/Logging/email) | **0.00** | **0** | **0** |
| B. No free allowance at all (worst case): compute 6.92 + memory 4.15 + 50 GB balanced 1.98 + 20 GB backup objects 0.47 | **13.52** | **55.6** | **63.9** |
| Budget | 23.25 | 95.6 | **110** |

Both scenarios are inside SAR 110.
- Usage at 500 or 1,000 registrations a month does not change the shape. Storage and traffic stay within the free allowances; database growth is megabytes per month.
- Free allowances are not guaranteed. The worst case B is the planning figure.
- **Not included:** a domain name, and a Resend paid plan if email volume exceeds its free tier.

## 8. Risks and decisions before creating paid or free compute

1. **Free trial and account type (decision O1).** The tenancy is a free-trial account (PROMO). After the trial ends (30 days, around 27 Dec 2026) or the credit runs out, only Always Free resources keep running. Oracle may also reclaim Always Free compute it considers idle: 95th-percentile CPU, network and (for A1) memory under 20% over 7 days. A TRACED VM at 100 registrations a month would look idle.
   - **Recommendation:** upgrade the tenancy to **Pay As You Go** before production. Always Free stays free after the upgrade; the budget alerts watch the rest.
   - The account is **PERSONAL**. If invoices must be issued to KaRama IT LTD with its VAT number, ask Oracle to convert or upgrade it as a company account. Only the owner can do this.
2. **A1 capacity (O2).** Limits allow 16 OCPUs, but free-tier tenancies can hit "out of host capacity" in a region. This can only be confirmed by launching the instance; if it happens, retry later or after the Pay As You Go upgrade.
3. **Audit compartment (O3).** Approve a sibling `TRACED-Audit` compartment before production (§5).
4. **API host name and DNS (D9).** Needed for TLS and for the Vercel `/api/v1` rewrite with the proxy secret (Routing Middleware). DNS changes need approval.
5. **Code tasks before deployment:**
   - OCI Object Storage checkpoint writer;
   - arm64 container build;
   - Compose file, systemd timers and a backup script.

   The production config guard already accepts `INTERNAL_CRON_SECRET` on its own (`server/src/config.ts`), so the scheduler needs no code change.
6. **Recovery point:** up to 24 hours with nightly dumps (Cloud SQL would have had point-in-time recovery). Approve, or ask for WAL archiving.
7. **Unchanged launch blockers:** identity verification (collection stays blocked), customer status emails off, Resend privacy approval, release gate in `phase-8-preparation.md` §12.

## 9. Proposed next steps (each needs approval)

1. Owner: decide O1 (Pay As You Go upgrade, company account) and O3 (audit compartment).
2. Approve creation of: VCN + NSG, the A1 VM (1 OCPU / 4 GB / 50 GB), the Vault and secrets, the backup bucket, and the audit bucket (retention unlocked). Expected cost: scenario A (EUR 0), at most scenario B (SAR ≈ 64 incl. VAT).
3. Code tasks in §8.5 on `feature/traced-portal`, tested locally.
4. Install the database, apply migrations 0001–0011 on a clean database, apply `production-roles.sql`, then run the security checks with synthetic data only.
5. A separate approval for any public API exposure and Vercel integration.
