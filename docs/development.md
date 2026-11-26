# Local development

Requirements: Node.js 22.12+ and npm. No PostgreSQL install or admin rights needed: the dev database runs from `node_modules` (embedded-postgres). Browser tests use the installed Microsoft Edge (no browser download).

```powershell
npm install
copy .env.example .env      # then set your own local DB password in DATABASE_URL
npm run gen-keys            # paste the two printed lines into .env
```

Run in two terminals:

```powershell
npm run dev:db              # local PostgreSQL (UTF-8) on 127.0.0.1:54329, data in .dev-db/
npm run dev                 # API + static site on http://localhost:8787 (applies migrations automatically)
```

First time only, add sample data (clearly marked `[DEV]` branches and PROVISIONAL consent texts):

```powershell
npm run seed:dev
```

- Public site: http://localhost:8787/traced/ and /ar/traced/ (header "My Account" opens the portal).
- Customer portal: http://localhost:8787/traced/account/ (Arabic: /ar/traced/account/).
- API: http://localhost:8787/api/v1/... (e.g. `/api/v1/health`).
- Emails are **not sent**. Every email goes through the outbox and is written to `.dev-mail/` (an `.html` preview with the QR code embedded, a `.txt` copy and the QR `.png`), and links are printed in the server console. Open a link in the browser to verify an account or reset a password; open the `.html` file to preview the branded email.
- The outbox retries failed emails in the background (every `OUTBOX_INTERVAL_MS`). Delivery status is in the `email_outbox` table.

> If you created `.dev-db/` before Phase 2, delete it once (`Remove-Item -Recurse .dev-db`) so it is re-initialised as UTF-8; Arabic text cannot be stored otherwise and migrations will refuse to run.

If a database has registrations created before Phase 3 (no tracking ID), assign IDs and QR codes once:

```powershell
npm run backfill:phase3                  # add -- --send-emails to also queue confirmation emails
```

To try the Phase 4 QR validation API locally, give a staff account a branch:
`INSERT INTO staff_branch_assignments (user_id, branch_id) VALUES ('<staff user id>', '<branch id>');`
(the admin portal will manage this in Phase 5).

Create a staff-side account (prints a one-time setup link):

```powershell
npm run create-user -- --email you@example.com --role super_admin
```

## Portal pages

The 22 HTML shells under `dist/traced/c/` (QR landing page) and `dist/traced/account/` and `dist/ar/traced/account/` are generated; edit `scripts/build-portal-pages.mjs`, not the HTML. Page behaviour and text live in `dist/portal/js/` (text in `dist/portal/js/i18n/en.js` and `ar.js`, which must keep identical keys).

```powershell
npm run build:portal        # regenerate portal pages + (re)apply the TRACED header/footer "Account" link
npm run check:portal        # verify both are up to date (also part of npm test)
```

## Checks

```powershell
npm run typecheck
npm test                    # unit + integration; starts its own throwaway PostgreSQL
npm run test:e2e            # browser tests in Edge; starts its own throwaway stack on port 8791
```

E2E screenshots are written to `docs/phase-3/screenshots/`. Stop `dev:db` with Ctrl+C (it shuts PostgreSQL down cleanly). `.env`, `.dev-db/`, `.dev-mail/` and `test-results/` are gitignored.
