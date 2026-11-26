# TRACED: Monthly infrastructure cost estimate (Dammam, verified list prices)

Updated 27 Nov 2026 (replaces the Phase 7 range). **Planning estimate, not a quote.** Unit prices are Google Cloud **list prices in USD** read from the official SKU catalogue (cloud.google.com/skus) on 26–27 Nov 2026, for **me-central2 (Dammam)** where the SKU is regional. The company billing account may have negotiated prices, credits or other usage that consumes free allowances. Nothing was provisioned to check prices.

- **Exchange rate:** SAR 3.75 = USD 1 (official peg). If the billing account is in SAR, Google converts at its own rate.
- **VAT:** Saudi VAT is 15%. For a Saudi-registered company it is either added to the invoice or self-accounted (reverse charge), depending on how the billing account is contracted. **Finance to confirm.** Totals are shown with and without 15%.
- **Free allowances** are per billing account, not per project, and other company projects may already use them. **The totals below assume no free allowance for Cloud Run CPU/memory.** Small free tiers (Secret Manager, Scheduler, Artifact Registry, logging) are shown as a range.

## 1. Verified unit prices

| Service | SKU (official name) | Price |
|---|---|---|
| Cloud SQL instance | PostgreSQL: **Zonal – Micro instance in Dammam** (db-f1-micro) | **$0.0168 / hour** (≈ $12.26 / month) |
| | PostgreSQL: Regional (HA) – Micro instance in Dammam | $0.0336 / hour |
| | PostgreSQL: Zonal – Small instance in Dammam (db-g1-small) | $0.056 / hour (≈ $40.88 / month) |
| Cloud SQL storage | PostgreSQL: Zonal – Standard storage in Dammam (SSD) | **$0.272 / GiB-month** |
| Cloud SQL backups | Cloud SQL: Backups in Dammam | **$0.128 / GiB-month** |
| Cloud Run CPU | Services CPU **Tier 2** (Request-based billing), global SKU | $0.0000336 / vCPU-second |
| Cloud Run memory | Services Memory Tier 2 (Request-based billing) | $0.0000035 / GiB-second |
| Cloud Run requests | Cloud Run Requests | first 2 M / month free, then $0.40 / million |
| Secret Manager | secret version replica storage / access operations | 6 versions free, then $0.06 / version-month; 10,000 accesses free, then $0.03 / 10,000 |
| Cloud Scheduler | jobs | 3 jobs free per billing account, then $0.10 / job-month |
| Artifact Registry | storage | 0.5 GiB free, then $0.10 / GiB-month |
| Cloud Logging | log storage (ingestion) | 50 GiB / month free, then $0.50 / GiB |
| Internet egress | Network Internet Data Transfer Out from Dammam to Middle East (Premium tier) | $0.19 / GiB (first TiB) |

**Tier note:** Cloud Run lists request-based CPU as a global SKU with Tier 1 ($0.000024) and Tier 2 ($0.0000336) prices. The me-central2 tier assignment is shown on the Cloud Run pricing page, which could not be read automatically. Cloud Run functions in me-central2 charge the Tier 2 rate, so **Tier 2 is assumed** (the more expensive case).

## 2. Usage assumptions

| Driver | 100 reg/month | 500 reg/month | 1,000 reg/month |
|---|---|---|---|
| Billed Cloud Run CPU time (base: scheduler every 5 min ≈ 2,600 s, daily checkpoint, staff/admin/lab use ≈ 3,000 s; plus ≈ 25 vCPU-s per registration journey) | ≈ 8,500 vCPU-s | ≈ 18,500 | ≈ 31,000 |
| Memory (512 MiB) | ≈ 4,250 GiB-s | ≈ 9,250 | ≈ 15,500 |
| API requests | ≈ 60 k | ≈ 200 k | ≈ 400 k (all within 2 M free) |
| Egress (API JSON + QR images; static pages are served by Vercel) | ≈ 0.5 GiB | ≈ 2 GiB | ≈ 4 GiB |
| Database data | < 0.2 GiB | < 0.5 GiB | < 1 GiB |
| Emails (Resend) | ≈ 300 | ≈ 1,500 | ≈ 3,000 (free limit) |

## 3. Monthly estimate (USD)

| Item | Type | 100 reg | 500 reg | 1,000 reg | Notes |
|---|---|---|---|---|---|
| Cloud SQL db-f1-micro (zonal) | fixed | 12.26 | 12.26 | 12.26 | runs 24/7 |
| Cloud SQL SSD 10 GiB | fixed | 2.72 | 2.72 | 2.72 | auto-increase capped at 30 GiB |
| Cloud SQL backups + PITR logs (≈ 2–5 GiB) | fixed-ish | 0.50 | 0.55 | 0.65 | 30 daily backups, 7 days of logs |
| Secret Manager (7 versions) | fixed | 0.06–0.42 | 0.06–0.42 | 0.06–0.42 | range = free tier available or not |
| Cloud Scheduler (2 jobs) | fixed | 0.00–0.20 | 0.00–0.20 | 0.00–0.20 | |
| Artifact Registry (~1 GiB, keep last 5) | fixed | 0.05–0.10 | 0.05–0.10 | 0.05–0.10 | |
| Checkpoint bucket (separate project) | fixed | < 0.01 | < 0.01 | < 0.01 | KB per day |
| Monitoring, uptime checks, budgets | fixed | 0.00 | 0.00 | 0.00 | within free allotments for this volume |
| **Fixed subtotal** | | **15.6–16.2** | **15.6–16.3** | **15.7–16.4** | |
| Cloud Run CPU + memory | usage | 0.30 | 0.65 | 1.10 | no free tier assumed (would be ≈ $0) |
| Cloud Run requests | usage | 0.00 | 0.00 | 0.00 | under 2 M |
| Egress | usage | 0.10 | 0.38 | 0.76 | |
| Logging | usage | 0.00 | 0.00 | 0.00 | well under 50 GiB |
| **Usage subtotal** | | **0.40** | **1.05** | **1.90** | |
| **Total (ex VAT), USD** | | **≈ 16.6** | **≈ 17.3** | **≈ 18.3** | |
| **Total (ex VAT), SAR** | | **≈ 62** | **≈ 65** | **≈ 69** | |
| **Total incl. 15% VAT, SAR** | | **≈ 72** | **≈ 75** | **≈ 79** | |
| Resend | outside Google | 0 | 0 (watch 100/day) | **paid plan likely** (price to confirm on resend.com) | |

**Higher-usage scenario** (1,000 registrations, Cloud Run usage 5× the estimate, 10 GiB egress, 60 GiB logs): about **$29 ex VAT ≈ SAR 125 incl. VAT**, above the SAR 110 budget mainly because of logs and egress. Alerts are set to catch that early.

## 4. Reconciliation with earlier estimates

| Estimate | Range | Status |
|---|---|---|
| Original budget | SAR 60–110 / month | **Holds** for 100–1,000 registrations: ≈ SAR 62–69 ex VAT, ≈ SAR 72–79 incl. VAT |
| Phase 7 report | USD 10–40 (≈ SAR 38–150) | superseded. That range used US prices for Cloud SQL ($0.0105/h); Dammam is **$0.0168/h (+60%)** and SSD is $0.272 vs ≈ $0.17 |
| This estimate | ≈ USD 16.6–18.3 ex VAT | Cloud SQL is ~90% of the bill; usage is almost negligible at this volume |

## 5. Alternatives (not selected)

| Option | Monthly (ex VAT) | Incl. VAT, SAR | Why not now |
|---|---|---|---|
| db-g1-small zonal | ≈ $47 | ≈ SAR 200 | above budget; only if f1-micro shows CPU/memory/connection pressure |
| db-f1-micro **regional (HA)** | ≈ $29 | ≈ SAR 125 | above budget; still no SLA for shared-core |
| Separate staging project running all the time | + ≈ $16 | + ≈ SAR 69 | run staging only during Stage 8C, then delete it (D13) |
| HTTPS load balancer for the API (D2 alternative) | + fixed forwarding-rule charge (not verified) | — | only if legal requires no Vercel transit |

## 6. Possible unexpected charges

- Setting **min instances > 0**: Tier 2 idle CPU $0.0000035/s ≈ $9/month per vCPU, plus memory.
- **Log floods** (debug logging, attacks) above 50 GiB at $0.50/GiB. Mitigation: log exclusions and alerts.
- **Egress abuse** (scraping QR images, DDoS) at $0.19/GiB. Mitigation: rate limits, maximum 2 instances, alerts.
- Storage **auto-increase** (capped at 30 GiB ≈ $8 max).
- **Artifact Registry** image build-up without a cleanup policy.
- Accidentally creating Cloud SQL **Enterprise Plus** (no shared-core; much more expensive). Mitigation: `--edition=ENTERPRISE` in the command.
- A VPC connector (if private IP were chosen with a connector instead of Direct VPC egress).
- Leaving a **staging** project or restore-test instance running.
- **Resend** above the free plan.
- **Currency conversion** differences and VAT handling.
