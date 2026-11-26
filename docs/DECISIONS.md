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
| A19 | Client IP: count trusted proxy hops from the right (`TRUSTED_PROXY_HOPS`, optional CIDRs / proxy secret); production must set it explicitly | Phase 5 milestone 1 |

## Proposed / awaiting approval
| # | Item | Notes |
|---|---|---|
| P1 | Phase 6 scope (physical sample labels, chain of custody) and its §1 decisions (sample ID format, who records each transition, transport login, label printer/size, report-available meaning, rejection rules) | `docs/phase-6-plan.md` |
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
12. Backup and recovery verification; audit-log hardening (Phase 7).
13. Production provisioning and deployment authorisation (Phase 8).
14. External GitHub deployment configuration (webhooks need repository-admin access to inspect).
