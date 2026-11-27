# TRACED: Decision Register

Last updated: 2026-11-26 (Phase 5 approved and implemented). Only **Approved** items may be treated as settled. Anything else needs the owner's explicit approval.

## Approved
| # | Decision | Source |
|---|---|---|
| A1 | Stack: static site + generated portal pages; Hono/TypeScript/Node backend; PostgreSQL (embedded locally, Cloud SQL in prod); `qrcode` 1.5.4; `@zxing/browser` for scanning; Resend Free behind the mailer/outbox; Playwright on Edge | Master handover §5 |
| A2 | Production target: Vercel (frontend) + Cloud Run + Cloud SQL + Secret Manager + Cloud Scheduler, region me-central2, dedicated GCP project, budget SAR 60–110/month. **Not provisioned.** | Master handover §6 |
| A3 | No AWS, Supabase or Render | Master handover §5 |
| A4 | Tracking ID `TRC-SA-MM/YY-XXXXX`, Asia/Riyadh, monthly sequence, no reuse | Phase 3 |
| A5 | 256-bit random QR token; QR carries no personal data or tracking ID; no automatic expiry; active until collected, cancelled, revoked or replaced | Phase 3–4 |
| A6 | QR revocation allowed for the customer (own registration), admin (reason required) and super admin; refused for staff, lab operator and auditor | Phase 4 |
| A7 | Collection staff receive only patient age and gender plus operational data; enforced by server allowlists | Master handover §7 |
| A8 | Six roles and the Phase 1 permission catalogue are preserved | Phase 1 |
| A9 | No National ID, Iqama or nationality in the initial implementation; account holder must confirm 18+; no arbitrary minimum patient age | Phase 2 |
| A10 | Header label "My Account" / "حسابي", person icon on mobile; footer Account link points to the local portal | Phase 2 |
| A11 | Standing authorisation: commit and push tested work to `feature/traced-portal`; never `main`, never deploy | Master handover §23 |
| A12 | Phase 5 (admin portal) approved, with the trusted-proxy fix first | Owner, 2026-11-26 |
| A13 | Branch transfers before collection by authorised admins: reason, from/to, who, when, audit, sessions invalidated, customer notified, tracking ID kept | Owner, 2026-11-26 |
| A14 | Only the super admin approves/publishes collection instructions; admins prepare drafts (new permission `instructions.draft`). Publishing in the app is not clinical approval | Owner, 2026-11-26 |
| A15 | PII exports: super admin only, fresh MFA, reason, date limits, audit, CSV-injection safe. **Deferred to Phase 7**; non-identifying operational CSV allowed in Phase 5 | Owner, 2026-11-26 |
| A16 | Admin search by patient name, customer name, email, mobile, tracking ID; audited without readable terms | Owner, 2026-11-26 |
| A17 | Customer account actions: resend verification, lock, unlock (reasons, audit). No deletion or unrestricted deactivation | Owner, 2026-11-26 |
| A18 | Admin patient corrections before collection only, with reason and encrypted history | Owner, 2026-11-26 |
| A20 | Phase 5 finalised (owner, 2026-11-26); committed evidence must never contain decodable QR tokens, MFA secrets or recovery codes | Owner, 2026-11-26 |
| A21 | Stage A: Staff/Admin login links on the customer sign-in page; local test accounts only via one-time links (no stored passwords, MFA unchanged) | Owner, 2026-11-26 |
| A22 | Phase 6 approved: physical sample ID `TRC-SA-MM/YY-XXXXX-SXX` (keeps the registration tracking ID); separate secure sample QR; scans never change status by themselves; 50×30 mm configurable label without personal data; append-only custody events with a server-enforced matrix; packaging/dispatch by branch staff; **no transport portal** (dispatch record + independent lab receipt); minimal lab-operator portal with MFA and no patient identity; rejection with provisional reason categories; admin-authorised recollection with new sample ID/QR and fresh identity verification; customer timeline; admin custody management; no report upload or LIS integration | Owner, 2026-11-26 |
| A23 | Phase 6 implementation choices: sample ID reuses `samples.sample_code`; `in_transit` reserved (no transport accounts, no fabricated custody); recollection issues a new customer QR (spent QR never reactivated); customer status emails behind `CUSTOMER_STATUS_EMAILS` (off until wording approved); report availability is status-only | Phase 6 |
| A24 | Phase 7 approved (owner, 2026-11-26) and implemented locally: migrations 0010–0011 additive; PII export super admin only with fresh TOTP; MFA reset by super admin only; Cloud Scheduler OIDC recommended for production; deployment templates kept under `docs/deploy/` (not repo root) | Owner / Phase 7 |
| A25 | Phase 7 accepted; Phase 8 **preparation** approved (owner, 2026-11-27). Architecture fixed: Vercel frontend, Cloud Run backend, Cloud SQL PostgreSQL in me-central2, Resend Free (subject to privacy approval), Secret Manager, Cloud Scheduler, Cloud Monitoring/Logging, GitHub; no AWS/Supabase/Render. Separate project "TRACED Production" on the existing company billing account; budget SAR 110 with 50/80/100% alerts (alerts never shut services down). No provisioning or public deployment until infrastructure, pricing and release decisions are approved | Owner, 2026-11-27 |
| A26 | Orphaned test PostgreSQL workers stay running for now; cleanup only with `--yes` and authorisation | Owner, 2026-11-26 |
| A27 | Public website (no portal) deployed to Vercel project `tracedlife` (team `linus-bio-mena`) | Owner, 2026-11-27 |
| A28 | Google Cloud abandoned for TRACED: Dammam (me-central2) refused for the available billing account (CNTXT access not granted). Empty project `traced-production` kept, not deleted | Owner, 2026-11-27 |
| A29 | Hosting on **Oracle Cloud**, tenancy `karamait` as the central KaRama IT account; region me-riyadh-1 (Jeddah alternative); one compartment `TRACED` only for now; cost tags `KaRamaIT.Project/Environment/CostCenter`; budget SAR 110 incl. VAT (EUR 23.25) with 50/80/100% + forecast alerts; no paid resources before approval of exact configuration and cost | Owner, 2026-11-27 |
| A30 | OCI hosting configuration and cost approved (`docs/deploy/oci-plan.md`); server launch paused after Out of host capacity; owner requested the Pay As You Go upgrade; no shape or region change | Owner, 2026-11-27 |
| A31 | Launch target 1 Dec 2026 (owner); security not traded for the date; restricted pilot with synthetic data if real-patient approvals are outstanding. Oracle A1 server launched after the Pay As You Go upgrade; SCCC kept as an assessed (not opened) backup | Owner, 2026-11-27 |
| A19 | Client IP: count trusted proxy hops from the right (`TRUSTED_PROXY_HOPS`, optional CIDRs / proxy secret); production must set it explicitly | Phase 5 milestone 1 |

## Proposed / awaiting approval
| # | Item | Notes |
|---|---|---|
| P1 | OCI hosting configuration and cost; O1 Pay As You Go upgrade / company account; O2 A1 capacity; O3 TRACED-Audit sibling compartment; D9 API host name/DNS; recovery point (24 h vs WAL archiving) | `docs/deploy/oci-plan.md` §8–§9 |
| P7 | F-03: keep or purge historical screenshots with synthetic test QR tokens (history rewrite) | `docs/security/security-assessment.md`; keeping recommended |
| P8 | Data retention periods | `docs/security/privacy-review.md` §4 |
| P2 | Make GitHub repo `linusbiomena-commits/Traced.Life` **private** | Currently public; recommended |
| P3 | Identity-verification method per scenario (adult, child + guardian, dependent) | `docs/identity-verification.md`; production collection blocked until decided |
| P5 | API routing: Vercel rewrite vs. direct Saudi-hosted API domain | `docs/architecture.md` §2 |
| P6 | Exact proxy chain in production (`TRUSTED_PROXY_HOPS` 1 or 2; Vercel proxy secret) | `docs/architecture.md` §2a; verify in Phase 8 |

## Unresolved (business, legal or clinical; not technical)
1. Official production sending domain.
2. Resend US data processing and storage (PDPL / cross-border transfer).
3. Vercel data transit if `/api` is proxied.
4. Approved consent and privacy wording (EN + AR).
5. Professional Arabic translation review.
6. Approved clinical hair-collection instructions and checklist.
7. Child and guardian identity verification.
8. TRACED patient eligibility criteria.
9. Real collection-branch data (Wareed).
10. Physical Android, iPhone and USB scanner validation.
11. Final GCP pricing in me-central2; `db-f1-micro` suitability (shared core, no SLA).
12. Backup/restore on Cloud SQL staging and checkpoint bucket lock (Phase 8; local drill and audit hardening done in Phase 7).
13. Production provisioning and deployment authorisation (Phase 8).
14. External GitHub deployment configuration (webhooks need repository-admin access to inspect).
