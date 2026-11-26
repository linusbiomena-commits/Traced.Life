# TRACED: Performance, connection budget and db-f1-micro review

## What was measured

`npm run test:perf` (`server/test/perf/load.perf.ts`) builds a throw-away PostgreSQL 18 cluster (temporary folder, random port; never the development database) with `max_connections=25`, `shared_buffers=128MB`, `work_mem=4MB` and `pg_stat_statements`, migrates it, and bulk-loads **12,000 registrations** (≈ 10 years at 100/month), 9,000 samples, 33,000 custody events, **240,000 audit entries** (through the real hash-chain trigger) and 24,000 emails. It then calls the main API paths in-process 40 times sequentially and 40 times with 10 concurrent requests, times the heavy integrity operations, and writes `results.md` (timings, slowest statements, sequential-scan counts).

**What it does not prove:** Cloud SQL latency. The run used a 16-thread laptop CPU with no network and no TLS. db-f1-micro is a *shared* vCPU with about 0.6 GB RAM; expect several times slower CPU-bound queries there, plus 1–5 ms network per query. Use the numbers to compare paths and catch bad query shapes, not as production response times. A staging measurement is in the Phase 8 plan.

## Findings and fixes (Phase 7)

| Finding (first run) | Fix | After |
|---|---|---|
| Operational CSV ran one correlated count per day × branch (~370 ms at 12k registrations, growing with data) | single-pass aggregation over the Riyadh date range + date indexes (migration 0011) | statement no longer in the top 12 (< ~13 ms); counts proved identical by a regression test |
| `customer_qr_tokens` scanned 2,222 times (lookups by registration without the active filter) | index `(registration_id, created_at DESC)` | 2 scans |
| Dashboard activity feed scanned back through customer audit entries | partial index on staff-side entries | out of the top list; dashboard stats 143 → 66 ms |
| Full integrity verification ≈ 2.5 s for 240k entries; would grow past the runtime role's 15 s statement timeout on a small instance over years | verification runs in one READ ONLY REPEATABLE READ snapshot with a 600 s per-transaction timeout; checkpoint signing 300 s | runs regardless of the role default |
| 10 concurrent registrations queue on the monthly tracking counter row (gapless IDs) | by design | irrelevant at expected volume (100/month); revisit only above ~10 registrations/second |

All other measured paths were 4–50 ms p50 sequentially (see `results.md`).

## Connection budget (Cloud Run 2 instances, db-f1-micro)

db-f1-micro's default `max_connections` is 25 (check on the instance with `SHOW max_connections`). Cloud SQL reserves a few for its own maintenance/superuser use.

| Consumer | Connections |
|---|---|
| Cloud Run instance 1, pool `DB_POOL_MAX=5` | 5 |
| Cloud Run instance 2 (maxScale 2) | 5 |
| Rollout overlap (old + new revision for a short time) | up to 10 |
| Migration job (owner, 1) | 1 |
| Human/support session (`traced_readonly` limit 5; normally 0–1) | 1 |
| Cloud SQL reserved | ~3 |
| **Worst case** | **25** |

Rules: keep `DB_POOL_MAX=5` and `maxScale=2` together; raising either needs db-g1-small (default 50) or Cloud SQL managed connection pooling. `traced_app` has `CONNECTION LIMIT 40` as a backstop and `idle_in_transaction_session_timeout=30s`. During deployments use a gradual traffic shift so overlap is short. Alert at 20 connections.

Concurrency: `containerConcurrency: 40` with a pool of 5 means requests wait for a connection rather than opening more; at 100 registrations/month the observed concurrency will be single digits.

## db-f1-micro review

| Aspect | Assessment |
|---|---|
| Capacity | Data volume after 10 years ≈ 136 MB in the test (well under 10 GB). Query load is tiny. CPU is the constraint for heavy jobs (verification, CSV), which are rare |
| Memory | 0.6 GB: shared_buffers small; working set at launch fits; watch cache hit ratio |
| Reliability | Shared core, **not covered by the Cloud SQL SLA**, no HA. Acceptable for a pilot with tested backups and alerts; not for a high-availability commitment |
| Upgrade trigger | CPU > 80% sustained, memory pressure, connections > 20, or an SLA requirement → db-g1-small or a dedicated-core tier |

Re-run: `npm run test:perf` (≈ 1–2 min; `PERF_REGISTRATIONS`, `PERF_AUDIT_PER_REGISTRATION`, `PERF_ITERATIONS` override the size).
