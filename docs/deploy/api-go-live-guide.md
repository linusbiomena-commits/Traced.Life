# TRACED API go-live guide (restricted preview first)

**27 Nov 2026.** Step-by-step setup for the API, email and portal integration. Steps marked **[You]** need your accounts or decisions; steps marked **[Claude]** I run after you confirm. Nothing here exposes PostgreSQL (it never gets a port) or changes the public website at https://tracedlife.vercel.app.

## 0. The shape of it

```
Browser ──> https://tracedlife-git-feature-traced-portal-linus-bio-mena.vercel.app   (restricted preview: Vercel login required)
              │  /traced/...  portal pages (preview build only)
              │  /api/v1/*    Vercel Routing Middleware adds x-traced-proxy-auth, rewrites to ↓
            https://api.<your-domain>/api/v1/*   Caddy on traced-app-1 (ports 443/80 only, Let's Encrypt)
              └─> traced-api container ──> PostgreSQL (internal Docker network, no port)
```

**Two stages:**

| Stage | Dates | Mode | Database | Data |
|---|---|---|---|---|
| Restricted preview | 28–30 Nov | `vm_07 … preview` | `traced_preview` | synthetic only; development identity verification and provisional consent/instructions allowed so the whole flow can be tested |
| Production | release gate | `vm_07 … production` | `traced` (clean, already migrated) | real data only after the approvals |

Synthetic data never enters the launch database. Audit records are permanent, so mixing them in would pollute the production audit trail forever.

## 1. API domain **[You]**

Choose a host name under a domain you control (for example `api.traced.life` or `api.<company-domain>`) and tell me:
- the exact host name;
- where its DNS is managed (registrar, Cloudflare, etc.);
- whether the same domain will be used for email (recommended: one domain for both).

## 2. Reserved public IP (Oracle) **[Claude]**

- **Cost: none.** OCI does not charge for public IP addresses; there is no public-IP SKU in Oracle's price list. The tenancy limit is 50 reserved IPs, and 0 are used.
- **Why:** the server's current IP is ephemeral and changes if the instance is stopped. DNS needs a fixed address.
- **What I do:**
  1. create reserved IP `traced-api-ip` in compartment TRACED;
  2. remove the ephemeral IP from the server's primary private IP and attach the reserved one. Outbound traffic pauses for a few seconds; PostgreSQL is unaffected.

  I then tell you the address.
- **Network rule** (same step, after your approval): add ingress **TCP 443** and **TCP 80** (80 is only for Let's Encrypt validation and redirects) from 0.0.0.0/0 to `traced-nsg-app`. Nothing else is opened; 5432 stays closed.

  Vercel does not have fixed outbound IPs, so 443 cannot be limited to Vercel. Protection comes from HTTPS, the proxy secret (§9), application authentication and MFA, and rate limits.

## 3. DNS records **[You]**, at your DNS provider

| Type | Name | Value | TTL | Purpose |
|---|---|---|---|---|
| A | `api` | the reserved IP from §2 | 300 | API host |
| CAA (optional) | `@` | `0 issue "letsencrypt.org"` | 3600 | allow only Let's Encrypt; **skip it** if other services on this domain use other certificate authorities |
| Resend records | from §5 | exactly as Resend shows | default | email |

If the DNS is on Cloudflare, set the `api` record to **DNS only** (grey cloud). Proxied mode breaks certificate issuance and the proxy chain.

## 4. Resend account **[You]**

1. Sign up at resend.com with a company address (for example info@karamaitco.com). Enable two-factor authentication on the account.
2. Plan: start on the **Free** plan (at the time of writing 3,000 emails a month and 100 a day; check the current limits on Resend's pricing page). TRACED at about 100 registrations a month sends a few hundred emails. Do not buy a subscription yet.
3. Privacy (decision D-E): Resend processes recipient email addresses outside Saudi Arabia. Approve this transfer (PDPL) before real customers receive email. The restricted preview only emails your testers.

## 5. Sending-domain verification **[You]**

1. Resend → **Domains** → **Add domain**. Use a subdomain dedicated to transactional mail, for example `mail.<your-domain>`, so it does not affect the company's other mail.
2. Region: choose the closest region Resend offers (for example Ireland, `eu-west-1`).
3. Resend shows the records to add. Copy them **exactly**. They are typically:
   - an **MX** record and an **SPF TXT** record on a `send.` subdomain (bounce handling);
   - a **DKIM TXT** record named like `resend._domainkey…`.
4. Also add a **DMARC** record if the domain has none: TXT `_dmarc.<your-domain>` = `v=DMARC1; p=none; rua=mailto:dmarc@<your-domain>`. Start with `p=none`, then tighten to `quarantine` after a clean week.
5. Click **Verify** in Resend. DNS can take minutes to a few hours. Tell me when it shows **Verified**.

## 6. Resend API key into Oracle Vault **[You]**

**Create the key:** in Resend → **API Keys** → **Create**:
- name `traced-oci-riyadh`;
- permission **Sending access**;
- domain: only the verified domain.

Copy it once. **Do not paste it into chat, email, a ticket or a file.**

**Store it in the Vault**, either way:

- **Option A, Console:**
  1. cloud.oracle.com, region **Saudi Arabia Central (Riyadh)** → Identity & Security → **Vault** → compartment **TRACED** → `traced-vault` → **Secrets** → **Create secret**.
  2. Name `traced-resend-api-key`; encryption key `traced-master-key`; type **Plain-text**; paste the key; **Create**.
- **Option B, PowerShell on your PC.** It prompts with hidden input; the key is not echoed or saved:

  ```powershell
  & "$env:USERPROFILE\oci-cli-venv\Scripts\oci.exe" session validate --profile TRACED --auth security_token
  ```
  then run `deploy\oci\store-resend-key.ps1` from the repository (it looks up the vault and key itself).

Tell me "stored". I only check that the secret exists and is ACTIVE; I never read its value.

## 7. Sender address **[You]**

Tell me:
- `MAIL_FROM`, for example `TRACED <no-reply@mail.<your-domain>>`. It must be on the verified domain.
- a reply-to address that a person reads, for example `support@<your-domain>`, or none.

Customer status emails (sample received, report available, recollection) stay **off** until the wording is approved (D-N).

## 8. Vercel operational portal integration (restricted preview)

**Already prepared:** `scripts/build-public-site.mjs` includes the portal only when `TRACED_BUILD_PORTAL=1`. It **refuses** to do so in a Vercel production build, so production stays public-only.

1. **[You or Claude]** Vercel → project **tracedlife** → Settings → Environment Variables, scope **Preview only**:
   - `TRACED_BUILD_PORTAL` = `1`
   - `TRACED_API_ORIGIN` = `https://api.<your-domain>`
   - `TRACED_PROXY_SECRET` = (§9; type **Sensitive**)
2. **[Claude]** Copy `docs/deploy/vercel-middleware.example.ts` to `middleware.ts` at the repository root on `feature/traced-portal` and push. This triggers a preview build. Production is unaffected: production has no portal and no API variables, and `/api/v1/*` there answers 503.
3. Preview address: **https://tracedlife-git-feature-traced-portal-linus-bio-mena.vercel.app**.
   - Vercel Authentication protects previews; only members of the `linus-bio-mena` team can open them.
   - For testers without a Vercel account, use Vercel's protection-bypass **share link** for that deployment and revoke it after testing.
4. API origin setting: `APP_ORIGIN` = the preview address above for the preview stage. At launch it changes to the production site address (D-F).

## 9. Proxy secret **[Claude + You]**

1. **[Claude]** Generate a 32-byte random value straight into Vault as `traced-proxy-secret` (never printed). The API reads it as `TRUSTED_PROXY_SECRET`.
2. **[You]** Copy it from the Vault into Vercel. I will not type secrets into Vercel.
   - Console → Vault → `traced-vault` → Secrets → `traced-proxy-secret` → **Secret versions** → ⋮ → **View secret contents** → copy.
   - Paste it into Vercel env `TRACED_PROXY_SECRET` (Preview).
3. Effect: the API trusts the client IP in `X-Forwarded-For` only when the request carries this secret (two proxy hops: Vercel, then Caddy). Direct callers cannot spoof their IP, and rate limits stay per real client.
4. Rotation: create a new Vault version, update Vercel, then restart the API (`systemctl restart traced-api`).

## 10. First super administrators **[You → Claude]**

1. Tell me two named people and their work emails (D-G).
2. **[Claude]** After the API is up, run `deploy/oci/vm/vm_08_create_admin.sh <email>` through Run Command for each. Each person receives a **one-time setup link** by email, sets a password and must enrol two-step verification (MFA) before anything else.
3. They then invite staff (collection, laboratory, auditors) from the admin portal. The preview database is separate, so preview accounts do **not** carry over to production. Production admins are created the same way at launch, in `traced`.

## 11. Order and timing (as soon as you are ready; no need to wait for 29 Nov)

1. **[You]** §1 domain → **[Claude]** §2 reserved IP + NSG + `traced-proxy-secret` → **[You]** §3 DNS A record.
2. **[You]** §4–§6 Resend, domain verification, key in Vault, §7 sender. These can run in parallel with step 1.
3. **[Claude]**
   - `vm_02_migrate.sh <vault> <commit> traced_preview` (creates and migrates the preview database);
   - then `vm_07_api_install.sh … preview` (API + HTTPS + timers);
   - then health check over HTTPS.
4. **[You/Claude]** §8 Vercel variables + middleware → preview build → I verify cookies, CSRF, trusted proxy and the forged `X-Forwarded-For` check.
5. **[Claude]** §10 first admins → you sign in, set up MFA, invite test staff → full synthetic regression (launch plan §5) and device tests.

## 12. Blocker found while preparing: approved consent texts

In production mode the API serves only consent documents with status **approved**. The current texts are development placeholders marked "PROVISIONAL – NOT LEGALLY APPROVED", and production refuses them.
- **Customer registration in production is impossible until approved texts exist**, which also blocks a registration-only launch.
- **Needed (D-N):** legally approved privacy notice, sample-collection consent, accuracy declaration and guardian authorisation, each in **English and Arabic** (8 texts), with an approval reference.
- There is no admin screen for consent texts. I will add a small command that loads approved texts with their approval reference (a code task of about 1–2 hours, with tests) once the texts exist.
- The restricted preview works without them, because it uses development mode and shows the provisional texts clearly marked.
- Collection instructions **can** be approved in the admin portal (super admin publishes with an approval reference).
