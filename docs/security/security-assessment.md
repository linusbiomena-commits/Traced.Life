# TRACED: Security assessment (Phase 7, 26 Nov 2026)

Scope: application code, database design and grants, configuration, dependencies and repository history of `feature/traced-portal`. Method: OWASP Top 10 (2021) review plus automated probes, a route × role authorization sweep, tamper tests, a dependency audit and a full-history secret/QR scan. **OWASP ZAP was not run:** it is not installed on this machine and installing it was out of scope; the automated probes in `server/test/security-probes.test.ts` cover the checks a baseline ZAP scan would make against this API (headers, injection, traversal, error leakage, cookie flags). A ZAP baseline against staging is listed for Phase 8. No independent penetration test has been done.

## 1. Results summary

| Check | Result |
|---|---|
| Authorization sweep (every `/api/v1` route × 7 roles) | no unintended access; matrix in `permission-matrix.md` |
| Security probes (10 tests) | pass |
| Tamper detection (audit edit, tail cut, custody edit, forged/deleted checkpoint, tampered external copy, wrong key) | all detected |
| Least-privilege DB role | full journey works as `traced_app`; UPDATE/DELETE/TRUNCATE on evidence, DDL, migrations bookkeeping, role/permission edits all refused by PostgreSQL (42501) |
| `npm audit` (all and production) | 0 vulnerabilities |
| Secret scan, all commits (keys, private keys, token links, `c1_`/`s1_` tokens, otpauth secrets, DB URLs with passwords) | none; two false positives (site text `re_buyer_site_abandonment`, `.env.example` placeholder) |
| QR scan of every PNG in history (378 blobs) | 16 old versions contain synthetic test QR tokens / MFA secrets (F-03); current versions clean |

## 2. OWASP Top 10 mapping

| Category | Status | Notes |
|---|---|---|
| A01 Broken access control | Controlled | per-route permissions, object checks, sweep test, CSRF + Origin, staff/lab response allowlists |
| A02 Cryptographic failures | Controlled | argon2id passwords; AES-256-GCM for MFA secrets, QR redisplay, outbox payloads, patient revisions; HMAC-SHA256 for tokens; TLS by platform; keys only from env/Secret Manager |
| A03 Injection | Controlled | parameterised SQL; probes; CSV neutralisation; email templates escape |
| A04 Insecure design | Controlled | threat model; step-up MFA for exports; append-only evidence; refusal instead of truncation |
| A05 Security misconfiguration | Controlled | strict headers, production config guards (refuse unsafe settings), no stack traces |
| A06 Vulnerable components | Controlled | 0 advisories; pinned versions; few dependencies |
| A07 Identification & authentication | Mostly | MFA for privileged roles, lockout, rate limits, session idle/absolute timeouts; TOTP is phishable (R3) |
| A08 Software & data integrity | Controlled for data; partial for build | hash chain + signed checkpoints; CI signing/SBOM not yet |
| A09 Logging & monitoring | Partial | complete audit trail and integrity job; alerts defined but not provisioned (Phase 8) |
| A10 SSRF | N/A | the server fetches only Google JWKS (fixed URL) and Resend (fixed URL); QR content is never fetched |

## 3. Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-01 | Medium | No recovery path for a lost authenticator; users could not refresh recovery codes | **Fixed** (super-admin reset, self-service regeneration) |
| F-02 | Medium | Runtime DB role draft granted UPDATE broadly and missed Phase 6 evidence tables | **Fixed** (per-table grants, tested) |
| F-03 | Low | Git history (public repo) has 16 older screenshot versions whose QR codes contain tokens / MFA secrets of **synthetic accounts in deleted test databases** (`localhost:8791`). They grant nothing (databases and keys no longer exist) but show the token format | **Open, owner decision**: leave (recommended, no real data) or rewrite history (needs approval; breaks clones) |
| F-04 | Low | Phase 6 append-only tables `sample_label_prints`, `recollection_authorizations` allowed TRUNCATE | **Fixed** (migration 0010) |
| F-05 | Low | Outbox could retry forever if a send crashed the process every time | **Fixed** (attempt cap) |
| F-06 | Low | Long integrity verification could exceed the runtime role's 15 s statement timeout as data grows | **Fixed** (per-transaction timeout, consistent snapshot) |
| F-07 | Info | Server listened on 127.0.0.1 only (would fail on Cloud Run) | **Fixed** (`HOST`) |
| F-08 | Info | Scheduler auth was shared-secret only | **Improved** (OIDC verification added; recommended for production) |
| F-09 | Medium | Checkpoint sink is a local folder; production needs a retention-locked bucket | **Open, Phase 8** |
| F-10 | Medium | Identity verification at collection is a development simulation | **Open, blocking for collection** |
| F-11 | Low | A TOTP code used on the live system after the last backup can be replayed within its 30-second window against a restored copy | Accepted (negligible; noted in the restore procedure) |
| F-12 | Info | Admins can call the laboratory API (they hold `custody.record_lab` by the role catalogue) | Accepted by design; revisit when a dedicated lab role is staffed |

## 4. Recommendations (next phases)

WebAuthn for privileged roles; ZAP baseline + independent penetration test on staging; Cloud Armor or Vercel firewall rules for sign-in; SBOM and image signing in CI; periodic access review of super admins and export audit entries.
