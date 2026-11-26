# TRACED: Monthly cost estimate (planning only)

**Not a quote.** Figures are public list prices found on 26 Nov 2026, mostly published for US regions. **me-central2 (Dammam) prices are typically higher and were not confirmed**, and db-f1-micro availability in me-central2 was not confirmed. Re-check every line in the Google Cloud pricing calculator for the chosen region before approval. Taxes (Saudi VAT) excluded.

## Assumptions

- About 100 registrations/month at launch; a few hundred API requests per registration journey; staff and admin use during working hours; well under 100 emails/day.
- Cloud Run: scale 0–2, 1 vCPU / 512 MiB, CPU allocated only during requests.
- Cloud SQL: db-f1-micro (shared core, about 0.6 GB RAM), 10 GB SSD, daily backups kept 30 days, PITR on. **No HA** (db-f1-micro is shared-core and not covered by the Cloud SQL SLA).

## Estimate

| Item | Basis | US list price reference | Expected monthly (Dammam unknown → range) |
|---|---|---|---|
| Cloud SQL db-f1-micro | listed at $0.0105/hour (region not stated on the page) | ≈ $7.70 | **$8 – $15** |
| Cloud SQL storage 10 GB SSD + backups + PITR logs | per GB-month | ≈ $2 – $4 | **$2 – $6** |
| Cloud Run | free tier ~180k–240k vCPU-s and 360k–450k GiB-s per month (depends on region tier); launch volume fits inside or near it | ≈ $0 – $5 | **$0 – $10** |
| Cloud Scheduler | 3 free jobs per billing account; 2 jobs planned | $0 | **$0 – $1** |
| Secret Manager | 7 secrets, few accesses | < $1 | **< $2** |
| Cloud Storage (checkpoint bucket) | KB-sized objects | < $0.10 | **< $1** |
| Artifact Registry | ~1–2 GB images | < $1 | **< $1** |
| Logging / monitoring | within free allotments at this volume | $0 | **$0 – $5** |
| Resend | free plan: 3,000/month, 100/day | $0 | **$0** (paid plan if volume grows) |
| Vercel | existing public site plan, unchanged | — | **no change expected** (confirm plan limits for rewrites/bandwidth) |
| **Total** | | | **≈ $10 – $40 / month** |

## Upgrade paths and their effect

| Change | Why | Approximate effect |
|---|---|---|
| db-f1-micro → db-g1-small (1.7 GB) | CPU/memory alerts, more connections (default 50) | + ~$15–25/month |
| Dedicated-core instance + HA | SLA, failover | + ~$100+/month |
| Cloud Run min instances = 1 | no cold starts | + ~$10–40/month depending on CPU allocation |
| Resend paid plan | > 100 emails/day | from ~$20/month |

Sources: [Cloud SQL pricing](https://cloud.google.com/sql/pricing), [Cloud Run pricing](https://cloud.google.com/run/pricing), [Exodus: smallest Cloud SQL instances](https://exodus.elim.io/blog/cloud-sql-smallest-instances-and-what-they-cost), [Bytebase Cloud SQL pricing](https://www.bytebase.com/dbcost/cloudsql-pricing/).
