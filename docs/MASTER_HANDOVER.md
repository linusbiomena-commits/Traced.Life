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
| 6 | Physical sample IDs `TRC-SA-MM/YY-XXXXX-SXX`, sample QR, labels, append-only custody, staff packaging/dispatch, laboratory portal, rejection + recollection, customer timeline, admin custody; migration 0009 | `phase-6-report.md` |
| 7 | Security hardening and production readiness (local only): threat model, MFA reset + recovery codes, least-privilege DB roles (tested), signed audit checkpoints + verification + OIDC scheduler auth (migration 0010), super-admin PII export, audit-integrity page, performance run + indexes (0011), backup drill, outbox/camera-test reliability, security probes, deployment templates, launch checklist, Phase 8 plan | `phase-7-report.md` |
| 5 | Trusted-proxy fix; admin portal (MFA, dashboard, audited search/records, transfers, cancellation, corrections, customer lock, QR, staff, branches, instruction drafts/publish, email monitor, audit viewer, operational CSV); migration 0008 | `phase-5-report.md` |

## 3. Current phase
Phases 0–7 and Stage A are complete. **Phase 8 (Google Cloud provisioning and deployment) is NOT authorised**: wait for the owner's explicit approval and decisions D1–D10 (`docs/deploy/phase-8-plan.md`). Manual testing guide (all portals incl. laboratory and a full synthetic journey): `docs/manual-testing.md`.

## 4. Architecture
- Local: one Node process serves the API (`/api/v1`) and the static site from `dist/` on :8787; embedded PostgreSQL on :54329 (`npm run dev:db`).
- Production target (not provisioned): Vercel static site; Cloud Run API in me-central2; Cloud SQL PostgreSQL; Secret Manager; Cloud Scheduler calls `POST /api/v1/internal/outbox/run`. Details: `docs/architecture.md`.
- Database: migrations 0001–0011 (0008 = admin portal, 0009 = custody, 0010 = audit integrity, 0011 = performance indexes). Key tables: users/roles/permissions/sessions/auth_tokens, audit_logs, collection_branches, patients, registrations (+ status history), consent_documents/records, patient_revisions, tracking_sequences, customer_qr_tokens, staff_branch_assignments, email_outbox, collection_instructions, collection_sessions, identity_verifications, samples, registration_branch_transfers, collection_instruction_drafts, sample_qr_tokens, custody_events, sample_label_prints, recollection_authorizations, audit_checkpoints, audit_verifications.

## 5. Major technical decisions
See `docs/DECISIONS.md` (approved vs proposed vs unresolved).

## 6. Latest test results
See `docs/TEST_STATUS.md` (Phase 5 final run).

## 7. Roadmap
7 Security hardening (audit roles and checkpoints, OWASP, device validation, load and backup tests) → 8 Production provisioning and deployment (explicit approval only).

## 8. Production blockers
1. GitHub repository is **public** (recommend private; owner action).
2. No approved identity-verification method, so production collection is blocked by design.
3. Provisional consent text and collection instructions; Arabic review.
4. Resend (US) and Vercel data transfer approval; sending domain.
5. Real branch data; physical-device validation.
6. Real proxy chain must be verified at deployment (`docs/architecture.md` §2a); the code fix is done.
7. Phase 7 open items: checkpoint GCS writer + bucket lock, housekeeping purges, CI pipeline, Vercel proxy-secret middleware, staging drills (`docs/phase-7-report.md` §4).
8. Provisioning and deployment authorisation (Phase 8).
