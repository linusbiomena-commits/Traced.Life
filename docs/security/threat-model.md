# TRACED: Threat model (Phase 7)

Method: assets → actors → trust boundaries → STRIDE per component → controls (with the test that proves each) → residual risk. Scope: the TRACED portal and API as built on `feature/traced-portal` (customer, collection staff, laboratory, admin, super admin, auditor), planned on Vercel + Cloud Run + Cloud SQL (me-central2). Not in scope: Wareed's and the laboratory's own systems, physical security of branches.

## 1. Assets

| Asset | Why it matters |
|---|---|
| Patient identity (name, date of birth, gender) and guardian contact (name, email, phone) | Health-related personal data under Saudi PDPL; children are the main patients |
| Customer QR token (`c1_`) | Bearer credential: whoever holds it can present the registration for collection |
| Sample QR token (`s1_`) and sample ID | Identifies a physical sample; scanning never changes custody by itself |
| Chain-of-custody records, consent records, audit log | Evidence; must be complete and unaltered |
| Sessions, passwords, MFA secrets, recovery codes | Account takeover |
| Keys: `TOKEN_HMAC_KEY`, `DATA_ENCRYPTION_KEY`, `AUDIT_CHECKPOINT_KEY`, Resend key, DB credentials | Compromise of any defeats a control layer |
| Personal-data exports | Bulk disclosure in one file |

## 2. Actors

Anonymous internet user; customer (adult account holder); collection staff (age + gender only); laboratory operator (no patient data); admin; super admin; auditor (read, redacted); scheduler (machine); database owner / cloud admin (privileged insider); attacker with a stolen device, phishing kit, or a leaked repository artefact; email provider (processor, US).

## 3. Trust boundaries

1. Browser ↔ Vercel edge (TLS) → Cloud Run (TLS, `X-Forwarded-For` appended, optional proxy secret).
2. Cloud Run ↔ Cloud SQL (Unix socket, `traced_app` role).
3. Cloud Run → Resend (TLS, US processing).
4. Cloud Scheduler → Cloud Run `/internal/*` (OIDC token).
5. Cloud Run → checkpoint sink (create-only).
6. Humans with console / database-owner rights (outside the app's control).

## 4. STRIDE

| # | Threat | Component | Controls | Proof (tests) | Residual |
|---|---|---|---|---|---|
| S1 | Credential stuffing / brute force | sign-in | argon2id, per-IP and per-account rate limits, lockout, generic errors | `auth.test.ts`, `security-probes.test.ts` (enumeration + 429) | Distributed low-rate attacks; add Cloud Armor/Vercel firewall later |
| S2 | Privileged account takeover | admin/lab/auditor | TOTP MFA mandatory, replay protection per step, recovery codes hashed, MFA re-verify per session, step-up code for exports | `rbac-mfa.test.ts`, `auth-hardening.test.ts`, `pii-export.test.ts` | Phishing of a live TOTP code (no WebAuthn yet) |
| S3 | Lost authenticator → lock-out or insecure reset | MFA | Super-admin-only reset with reason, not self, sessions revoked, audited; user re-enrols | `auth-hardening.test.ts` | Social engineering of the super admin: identity confirmation is a manual procedure |
| S4 | Forged client IP to dodge limits / poison audit | proxy | right-to-left hop counting, explicit `TRUSTED_PROXY_HOPS` in production, optional proxy secret | `proxy.test.ts` | Must be verified on the real path (Phase 8 procedure) |
| S5 | Forged scheduler call | `/internal/*` | OIDC RS256 + audience + service account + expiry, or shared secret; 404 when unconfigured | `audit-integrity.test.ts`, `outbox-reliability.test.ts` | — |
| T1 | Editing custody/consent/audit rows | DB | append-only triggers + **no UPDATE/DELETE/TRUNCATE grants** for `traced_app` | `db-roles.test.ts`, `database.test.ts` | Database owner can still do it → T2 |
| T2 | Insider rewrites history (owner access) | DB | hash chain, HMAC-signed checkpoints with key outside DB, external create-only copy, daily verification + alert | `audit-integrity.test.ts` (edit, tail cut, custody edit, forged/deleted checkpoint, tampered copy) | Collusion of DB owner **and** key holder **and** bucket admin; bucket lock pending (Phase 8) |
| T3 | Tampering via CSRF | API | `__Host-` SameSite=Strict cookie, CSRF token, Origin check | `security-probes.test.ts` | — |
| T4 | Duplicate / racing custody transitions | custody | row locks, expected-status check, idempotency keys | `custody.test.ts` | — |
| R1 | Staff deny an action | all | every state change audited with actor, role, IP, request id | per-feature tests | — |
| I1 | Staff/lab see patient identity | staff/lab APIs | server-side response allowlists (age + gender for staff; nothing for lab) | `staff.test.ts`, `custody.test.ts`, `privacy-verification.test.ts` | Physical: patient may show documents at the branch |
| I2 | IDOR across customers / branches | API | ownership and branch-assignment checks per object | `registrations.test.ts`, `staff.test.ts` | — |
| I3 | Role reaches another role's area | API | permission per route; full route × role sweep | `authz-matrix.test.ts` + `permission-matrix.md` | Admins can use the lab API by design (documented) |
| I4 | Bulk data exfiltration by an admin | exports | PII export super-admin only, step-up TOTP, reason, column minimisation, day/row limits, audited with file hash, no server copy | `pii-export.test.ts` | A legitimate super admin can still export within limits; review audit regularly |
| I5 | QR token leaks (screenshots, logs, email) | QR | tokens HMAC'd at rest, encrypted for redisplay, never logged; screenshot redaction + evidence test | `qr.test.ts`, `frontend.test.ts` | 16 historical synthetic-test screenshots in Git history (F-03) |
| I6 | Email content at the US processor | mail | emails carry no patient name/DOB/phone; legal approval pending | `email.test.ts` | PDPL transfer decision (D3) |
| I7 | Spreadsheet formula injection in exports | CSV | prefix neutralisation, quoted cells | `admin.test.ts`, `pii-export.test.ts` | — |
| D1 | Request floods / large bodies | API | 32 KB body limit, rate limits, Cloud Run max 2 instances | `security-probes.test.ts` | Volumetric DDoS → platform protections |
| D2 | DB connection exhaustion | DB | pool 5 × 2 instances + jobs ≤ 25 (budget), statement and idle-in-transaction timeouts on `traced_app` | `docs/performance/README.md` | db-f1-micro shared CPU under sustained load |
| D3 | Email backlog / provider outage | outbox | durable outbox, backoff, attempt cap, scheduler | `email.test.ts`, `outbox-reliability.test.ts` | Resend 100/day cap |
| E1 | Privilege escalation via role management | admin | authority re-derived from DB under locks, cannot grant above own level, last super admin protected, no self-changes | `admin.test.ts` | — |
| E2 | SQL injection | API | parameterised queries only; dynamic SQL only from fixed allowlists | `security-probes.test.ts` | — |
| E3 | XSS / script injection | portal | CSP `script-src 'self'`, DOM built with text nodes, no inline scripts | `frontend.test.ts`, `security-probes.test.ts` | — |
| E4 | Supply chain | deps | pinned versions, `npm audit` 0, small dependency set, vendored scanner | `npm audit` | No SBOM/signing yet |

## 5. Top residual risks (for the launch decision)

1. **Identity verification at collection** is not implemented (dev simulation only): collection must stay blocked in production until approved.
2. **Insider with owner + key + bucket rights** could rewrite evidence undetected → keep the three with different people; lock the bucket.
3. **TOTP phishing** for privileged roles → consider WebAuthn/passkeys for admins (Phase 9).
4. **Cross-border processing** (Vercel edge transit, Resend US) → legal decisions D2/D3.
5. **db-f1-micro has no SLA** → acceptable for pilot only, with alerts and tested restores.
