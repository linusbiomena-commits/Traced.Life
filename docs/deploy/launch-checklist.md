# TRACED: Production launch checklist (go / no-go)

Tick each item with who checked it and when. Any unticked **blocking** item = no launch.

## Approvals (blocking)
- [ ] Phase 8 provisioning approved by the owner (cost estimate accepted)
- [ ] Region and API path decision (D1, D2) approved by privacy/legal
- [ ] Email provider and cross-border transfer (D3) approved
- [ ] Privacy notice, consent texts and collection instructions approved (Arabic and English)
- [ ] Identity verification method approved **or** collection disabled at launch (D4)
- [ ] Data retention periods approved (`docs/security/privacy-review.md`)
- [ ] Incident response and breach notification owner named

## Security (blocking)
- [ ] All production secrets generated offline and stored only in Secret Manager; none in repo, chat or tickets
- [ ] `NODE_ENV=production` startup guards pass (they refuse unsafe config)
- [ ] Service connects as `traced_app`; `production-roles.sql` applied after the latest migration; owner credentials disabled
- [ ] `TRUSTED_PROXY_HOPS` verified with the forged `X-Forwarded-For` test on both the public path and the `run.app` URL
- [ ] Scheduler OIDC works; `/internal/*` refuses calls without a valid token
- [ ] First super administrators created with one-time links; MFA enrolled; recovery codes stored offline
- [ ] At least two super administrators (lost-authenticator reset needs a second one)
- [ ] Audit checkpoint key set; checkpoint job ran; verification `ok`; bucket retention policy set (locked after trial)
- [ ] `npm audit` clean on the release commit; repository secret scan clean
- [ ] Development identity verification disabled (`DEV_IDENTITY_VERIFICATION=false`) — guard enforces it
- [ ] Local test accounts not present in production (created only by `dev:test-accounts`, which refuses production)

## Reliability (blocking)
- [ ] Automated backups + PITR on; a restore-to-new-instance drill done on staging and recorded
- [ ] Rollback drill done (revision traffic shift and Vercel promote)
- [ ] Alerts configured and test-fired (integrity failure, 5xx, connections, budget, uptime)
- [ ] Previous revision verified against the new schema (additive migrations)

## Functional (blocking)
- [ ] Full browser suite passes against staging
- [ ] Bilingual review of all customer, staff, lab and admin screens and emails
- [ ] Email delivery from the official domain (SPF/DKIM/DMARC pass) in Arabic and English
- [ ] Physical devices and label printer validated at the pilot branch (`docs/device-checklist.md`)

## Non-blocking (track)
- [ ] Customer status emails wording (keep off until approved)
- [ ] Load test on staging at 5–10× expected volume
- [ ] Penetration test by an independent party
- [ ] Decide on removing historical screenshots containing synthetic test QR tokens from Git history (`docs/security/security-assessment.md` F-03)
