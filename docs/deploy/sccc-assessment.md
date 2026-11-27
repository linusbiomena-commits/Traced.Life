# SCCC by stc as a backup host: assessment (27 Nov 2026)

Desk research only. No account was created and nothing was purchased. Items marked **unverified** need confirmation from SCCC (920010911 or https://sccc.sa/en/contact).

| Question | Finding | Source |
|---|---|---|
| Account activation | Enterprise (SAR 5,000 voucher) and Individual (SAR 1,000 voucher) accounts. Business details and a payment method are required; billed in SAR, payable within 30 days. CR verification via WATHQ and Nafath for individuals are described only by a third-party portal case study (**unverified**). Activation time and whether a sales contact is needed: **unverified** | sccc.sa/auth/register; sccc.sa/subscription-agreement §2.6, §4.1 |
| Saudi region | Riyadh, two availability zones; data stays in KSA. Alibaba Cloud region ID `me-central-1` (zones a/b) | sccc.sa/en; alibabacloud.com ECS regions |
| Immediate compute | ECS is listed in the catalogue; self-service right after sign-up is **unverified** | third-party summary |
| 4 GB server, 50 GB SSD | **No official Riyadh price list found.** Comparable 2 vCPU / 4 GiB ECS elsewhere: about USD 16–19 a month on subscription, USD 23–29 on demand | mofcloud price tracker (other regions) |
| Public IP | Riyadh EIP: USD 0.17 per Mbps per day (1–5 Mbps) or USD 0.097/GB | alibabacloud.com EIP pricing |
| PostgreSQL | RDS endpoint exists for me-central-1; PostgreSQL engine and price **unverified**. Docker on a Linux ECS works, so the current self-managed design would carry over | alibabacloud.com RDS endpoints |
| Backup storage | OSS available in me-central-1 (USD 0.0204/GB-month, 5 GB free, Riyadh rate **unverified**). Retention/WORM in Riyadh **unverified** | alibabacloud.com OSS |
| Secrets | KMS is available in Riyadh, but **secrets need a KMS instance (USD 500 a month) plus USD 50 per 100 secrets**, which would break the budget. A cheaper pattern (encrypt with a KMS key, store ciphertext) would need code and script changes | alibabacloud.com KMS billing |
| IAM / CLI / API | Alibaba RAM, `aliyun` CLI, Terraform `alicloud` provider exist; whether they work with SCCC accounts is **unverified** | alibabacloud.com docs |
| Remote management | Cloud Assistant `RunCommand` replaces OCI Run Command; may return `RegionId.ApiNotSupported`, so it needs testing | help.aliyun.com |
| VAT | Prices exclude VAT; 15% added | subscription agreement §2.3 |

## Monthly estimate (USD × 3.75 = SAR; compute and disk are assumptions)

| Item | USD |
|---|---|
| ECS 2 vCPU / 4 GiB (assumed, on demand) | 25.00 |
| 50 GB SSD (assumed) | 3.50 |
| Public IP 1 Mbps (0.17 × 30) | 5.10 |
| OSS 20 GB (15 billable × 0.0204) | 0.31 |
| **Total without KMS secrets** | **33.91 ≈ SAR 127 ex VAT ≈ SAR 146 incl. VAT** (over the SAR 110 budget) |
| With a KMS secrets instance | + USD 550, about SAR 2,518 incl. VAT a month |

## Changes needed to move TRACED from Oracle to SCCC

- **Credentials and secrets:** instance principal becomes an ECS RAM role. OCI Vault becomes KMS, or an alternative to its secrets instance; either way the secret-fetch functions in `deploy/oci/vm/*` and `vm_07` must be rewritten.
- **Backups:** OCI Object Storage becomes OSS; the backup and checkpoint-upload scripts would use `ossutil` or the S3-compatible API.
- **Management and access:** Run Command becomes Cloud Assistant, and the IAM policies would be rewritten in RAM syntax.
- **Unchanged:** the application, migrations, Docker images and the PostgreSQL layout.

## Recommendation

- **Keep Oracle.** The Riyadh server, database and backups are running and verified, and the expected cost is EUR 0 (worst case about SAR 64 incl. VAT).
- **Why not SCCC now:** it is over budget on compute alone, its secrets service is far too expensive, and key facts (prices, PostgreSQL, CLI/IAM for SCCC accounts, activation time) are unverified.
- **If you still want SCCC as a backup:** ask SCCC for the items marked unverified. There is no need to open an account before 28 Nov.
