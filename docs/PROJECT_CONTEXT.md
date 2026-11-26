# TRACED: Project Context

**What:** TRACED customer registration and chain-of-custody platform for LinusBio MENA in Saudi Arabia (collection partner: Wareed). Customers register patients for a hair-sample test, receive a tracking ID and a secure QR code, collection staff scan the QR at a branch and confirm collection, admins manage operations, and (Phase 6) the physical sample is tracked to the lab.

**Where:**
- Public site: https://linusbiomena.vercel.app/traced/ (the existing static site; its pages must be preserved)
- Repo: `linusbiomena-commits/Traced.Life`. Development happens on `feature/traced-portal`; `main` is production and must never receive direct pushes.
- Local: `http://localhost:8787` (API + static site), customer portal `/traced/account/`, staff portal `/traced/staff/` (incl. Samples), admin portal `/traced/admin/`, laboratory portal `/traced/lab/`.

**Layout:**
| Path | Contents |
|---|---|
| `dist/` | Static site (byte-exact) plus generated portal shells under `traced/{account,staff,admin,lab,c,s}` and `ar/traced/...`; portal JS/CSS in `dist/portal/` |
| `server/src/` | Hono app: `modules/{auth,accounts,rbac,audit,registrations,consents,tracking,qr,collection,custody,mail,admin,dev}`, `middleware/`, `db/`, `cli/` |
| `server/migrations/` | `0001`–`0011` (checksummed; never edit applied ones) |
| `server/test/` | Vitest suites (real embedded PostgreSQL) and `e2e/` Playwright specs |
| `scripts/` | Portal page generator and account-link patcher |
| `docs/` | Phase reports, architecture, identity verification, device testing, audit hardening, handover files |

**Roles:** customer, collection_staff, lab_operator, admin, super_admin, auditor (see `server/migrations/0003_seed_roles_permissions.sql`).

**Key documents:** `docs/architecture.md` (GCP plan), `docs/development.md` (developer guide), `docs/identity-verification.md`, `docs/device-testing.md`, `docs/audit-hardening-plan.md`, `docs/phase-{0..7}-report.md`, `docs/security/`, `docs/deploy/` (Phase 8 preparation: `docs/deploy/phase-8-preparation.md`), `docs/manual-testing.md`, `docs/phase-5-plan.md`.

Idea and business ownership: LinusBio MENA. Volume expectation: about 100 registrations per month initially.
