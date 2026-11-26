# TRACED: Master Handover

Last updated: 2026-11-26. Permanent rules are in `/CLAUDE.md`; the exact checkpoint is in `docs/HANDOVER.md`.

## 1. Overview
Customer registration, secure QR and chain-of-custody platform for TRACED (LinusBio MENA, Saudi Arabia, collection partner Wareed), built on top of the existing static TRACED website. It has three portals (customer, collection staff, admin) over six roles. Context: `docs/PROJECT_CONTEXT.md`.

## 2. Completed phases
| Phase | Summary | Report |
|---|---|---|
| 0 | Repo inspection, architecture, DB/API/RBAC plan, roadmap | `phase-0-report.md` |
| 1 | PostgreSQL foundation, checksummed migrations, sign-up/verify/sign-in/reset, sessions, CSRF, lockout (10 attempts → 15 min), MFA + recovery codes, invitations, RBAC, audit hash chain, CLIs | `phase-1-report.md` |
| 2 | Customer portal (EN/AR, RTL, responsive), five-step registration, consents, ownership, duplicate-submit protection, account navigation patch | `phase-2-report.md` |
| 3 | Tracking ID engine, 256-bit QR (PNG/SVG), replace/revoke, public QR landing, bilingual email + outbox, patient correction history | `phase-3-report.md` |
| 4 | Staff portal, camera/USB/manual scanner, age/gender-only scan result, identity framework (dev simulation only), versioned instructions, transactional collection, admin QR revocation API, Cloud Scheduler outbox endpoint | `phase-4-report.md` |
| 5 | Trusted-proxy fix; admin portal (MFA, dashboard, audited search/records, transfers, cancellation, corrections, customer lock, QR, staff, branches, instruction drafts/publish, email monitor, audit viewer, operational CSV); migration 0008 | `phase-5-report.md` |

## 3. Current phase
Phase 5 is complete. **Phase 6 (physical sample labels and chain of custody) awaits the owner's approval**; proposed scope in `docs/phase-5-report.md` §18. Do not start it without approval.

## 4. Architecture
- Local: one Node process serves the API (`/api/v1`) and the static site from `dist/` on :8787; embedded PostgreSQL on :54329 (`npm run dev:db`).
- Production target (not provisioned): Vercel static site; Cloud Run API in me-central2; Cloud SQL PostgreSQL; Secret Manager; Cloud Scheduler calls `POST /api/v1/internal/outbox/run`. Details: `docs/architecture.md`.
- Database: migrations 0001–0008 (0008 = admin portal). Key tables: users/roles/permissions/sessions/auth_tokens, audit_logs, collection_branches, patients, registrations (+ status history), consent_documents/records, patient_revisions, tracking_sequences, customer_qr_tokens, staff_branch_assignments, email_outbox, collection_instructions, collection_sessions, identity_verifications, samples, registration_branch_transfers, collection_instruction_drafts.

## 5. Major technical decisions
See `docs/DECISIONS.md` (approved vs proposed vs unresolved).

## 6. Latest test results
See `docs/TEST_STATUS.md` (Phase 5 final run).

## 7. Roadmap
6 Physical sample labels and chain of custody (reuse `samples`) → 7 Security hardening (audit roles and checkpoints, OWASP, device validation, load and backup tests) → 8 Production provisioning and deployment (explicit approval only).

## 8. Production blockers
1. GitHub repository is **public** (recommend private; owner action).
2. No approved identity-verification method, so production collection is blocked by design.
3. Provisional consent text and collection instructions; Arabic review.
4. Resend (US) and Vercel data transfer approval; sending domain.
5. Real branch data; physical-device validation.
6. Real proxy chain must be verified at deployment (`docs/architecture.md` §2a); the code fix is done.
7. Audit-log hardening, backup/restore and micro-instance validation (Phase 7).
8. Provisioning and deployment authorisation (Phase 8).
