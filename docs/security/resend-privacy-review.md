# Resend (transactional email): privacy review

**27 Nov 2026. Status: technical integration done for the restricted preview; NOT approved for real customers.** Choosing the Tokyo sending region does not by itself establish compliance with the Saudi PDPL or any contract requirement. This document records the facts and the approvals still needed.

## 1. Configuration
- Provider: Resend (US company). Verified domain `tracedmena.life`; sending region selected by the owner: **Tokyo (ap-northeast-1)**.
- Return path `send.tracedmena.life` (Resend "Forge" MX/SPF); DKIM `resend._domainkey.tracedmena.life`; DMARC `p=none`.
- Sender `TRACED <info@tracedmena.life>`; reply-to `info@tracedmena.life`. Replies go to the company's Google Workspace mailbox, not to Resend.
- API key: send-only, stored only in OCI Vault (`traced-resend-api-key`); read by the server's instance principal at start-up into tmpfs; never in Git, logs or the frontend.

## 2. What TRACED sends to Resend
For every email: recipient address, sender, reply-to, subject, HTML + text body. Per email type:

| Email | Personal data in it | Notes |
|---|---|---|
| Verify email, password reset, account setup (staff/admin invitations), password changed, account exists | recipient email; a **one-time link** (secret token) | links expire; tokens are single-use |
| Registration confirmation / QR resend | account holder's name in the greeting (if set), **tracking ID**, **QR code image** | the QR is a **bearer credential for collection**: anyone holding it can present it at a branch (identity verification at collection is the control) |
| Branch transfer | tracking ID | no patient data |
| Customer status (sample received, report available, recollection) | tracking ID + link | **disabled** (`CUSTOMER_STATUS_EMAILS=false`) until wording is approved |

Never sent: patient name/date of birth on registration emails, National ID/Iqama (not collected), medical results, sample details, report contents (report delivery is not implemented).

## 3. Where processing may happen
- **Sending infrastructure:** Tokyo region as selected. Message content may also pass through the recipient's mail provider in any country (e.g. Google, Microsoft), as with any email.
- **Account, dashboard, logs and metadata:** Resend is a US company. Account data, API logs and email metadata/content retained for its dashboard may be stored or accessed **outside Japan**, including the United States. Retention periods and sub-processors are set by Resend's terms and DPA. **Not verified here**; obtain Resend's current DPA, sub-processor list and data-retention settings.
- **Webhooks/bounces:** TRACED does not ingest Resend webhooks yet. Bounces and complaints are visible only in the Resend dashboard (see the gaps in §6).

## 4. Cross-border considerations (for the DPO/legal)
- Email addresses, names and tracking IDs are personal data. A QR code linked to a health-related service is sensitive in context, even though the email has no medical content.
- Transfer outside the Kingdom requires a lawful basis and safeguards under the PDPL and its implementing regulations (transfer rules, adequacy or appropriate safeguards, a risk assessment where required). The legal team decides which apply.
- Needed: **Resend DPA** signed or accepted, the **sub-processor list** reviewed, a **transfer impact/risk assessment**, the privacy notice updated to mention email processing outside KSA, and a record of processing.
- Alternative if the transfer is not approved: an email provider with in-Kingdom processing. The code only needs a new mailer transport; the outbox is provider-agnostic.

## 5. Data-minimisation controls already in place
- Email content is minimal by design (see §2). Patient details are not in emails; the account greeting name is optional.
- One-time link data is **encrypted in the database** (`payload_enc`, AES-256-GCM) and **cleared after sending**.
- Status emails are off. No marketing email exists.
- Unknown-address password resets send nothing and answer the same as known addresses, so no account is disclosed.
- Logs: TRACED logs no recipient addresses in application logs (rate-limit keys are HMACs).

## 6. Gaps and approvals still needed
| # | Item | Owner |
|---|---|---|
| R1 | PDPL cross-border transfer approval (DPO/legal), Resend DPA, sub-processors, retention | DPO / legal |
| R2 | Privacy notice text mentions email processing by Resend outside KSA | legal (consent texts D-N) |
| R3 | Decide whether QR codes may be emailed or should be shown only after sign-in | owner + DPO |
| R4 | Bounce/complaint handling: today the outbox records "sent" when Resend accepts the message; later bounces are not fed back. Optional code task: Resend webhook endpoint, signed, to mark bounced addresses | engineering (optional before launch) |
| R5 | Resend account security: 2FA on, named owners, API key rotation yearly | owner |

Real-patient email workflows stay disabled until R1–R3 are approved.
