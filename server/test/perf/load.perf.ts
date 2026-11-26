import { randomBytes, randomUUID } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assignBranch, customerWithRegistration, decodeQrPng, getBinary, registrationBody } from '../helpers/registration.ts';
import { setupTestApp, type TestClient, type TestEnv } from '../helpers/test-app.ts';

// Phase 7 milestone 6: synthetic-data performance run. Bulk-loads a database the size of about
// ten years at the expected volume (100 registrations/month → 12,000; override with
// PERF_REGISTRATIONS), then times the main API paths in-process (no network) sequentially and
// with 10 concurrent requests, records pg_stat_statements and generic plans, and writes
// docs/performance/results.md. This machine is NOT Cloud SQL db-f1-micro: the numbers show
// query shape and relative cost, not production latency (see docs/performance/README.md).

const N = Number(process.env.PERF_REGISTRATIONS ?? 12_000);
const AUDIT_PER_REG = Number(process.env.PERF_AUDIT_PER_REGISTRATION ?? 20);
const ITER = Number(process.env.PERF_ITERATIONS ?? 40);

let t: TestEnv;
let branchId: string;
let staff: Awaited<ReturnType<TestEnv['staff']>>;
let lab: Awaited<ReturnType<TestEnv['mfaStaff']>>;
let sa: Awaited<ReturnType<TestEnv['mfaStaff']>>;
let cust: Awaited<ReturnType<typeof customerWithRegistration>>;
const timings: { name: string; mode: string; n: number; p50: number; p95: number; max: number; errors: number }[] = [];
const loadSteps: [string, number][] = [];

async function step(name: string, fn: () => Promise<unknown>) {
  const s = performance.now();
  await fn();
  loadSteps.push([name, Math.round(performance.now() - s)]);
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
async function measure(name: string, fn: () => Promise<{ status: number }>, okStatuses = [200, 201]) {
  for (const [mode, conc] of [['sequential', 1], ['10 concurrent', 10]] as const) {
    const xs: number[] = [];
    let errors = 0;
    for (let i = 0; i < ITER; i += conc) {
      await Promise.all(Array.from({ length: Math.min(conc, ITER - i) }, async () => {
        const s = performance.now();
        const r = await fn();
        xs.push(performance.now() - s);
        if (!okStatuses.includes(r.status)) errors++;
      }));
    }
    timings.push({ name, mode, n: xs.length, p50: Math.round(pct(xs, 50)), p95: Math.round(pct(xs, 95)), max: Math.round(Math.max(...xs)), errors });
  }
}

beforeAll(async () => {
  t = await setupTestApp();
  await t.db.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  branchId = (await t.db.query<{ id: string }>(`SELECT id FROM collection_branches WHERE code = 'DEV-RUH-01'`)).rows[0]!.id;
  staff = await t.staff(['collection_staff']);
  await assignBranch(t, staff.userId, branchId);
  lab = await t.mfaStaff(['lab_operator']);
  sa = await t.mfaStaff(['super_admin']);
  t.config.auditCheckpointKey = randomBytes(32).toString('base64');
  cust = await customerWithRegistration(t, { branchId });

  const db = t.db;
  const instr = (await db.query<{ id: string }>('SELECT id FROM collection_instructions ORDER BY created_at DESC LIMIT 1')).rows[0]!.id;
  const branches = (await db.query<{ id: string }>('SELECT id FROM collection_branches WHERE active')).rows.map((r) => r.id);
  await db.query('CREATE TEMP TABLE IF NOT EXISTS perf_params (k text PRIMARY KEY, v text)');
  // Synthetic customers (2 registrations each), patients and registrations over 120 months.
  await step(`customers (${N / 2})`, () => db.query(
    `INSERT INTO users (email, password_hash, email_verified_at, adult_confirmed_at, created_at)
     SELECT 'perf.' || g || '@example.com', 'x', now(), now(), now() - (g % 3650) * interval '1 day' FROM generate_series(1, $1) g`, [N / 2]));
  await db.query(`INSERT INTO user_roles (user_id, role_key) SELECT id, 'customer' FROM users WHERE email LIKE 'perf.%'`);
  await step(`patients (${N})`, () => db.query(
    `INSERT INTO patients (account_user_id, relationship, first_name, last_name, date_of_birth, gender)
     SELECT u.id, 'child', 'Perf' || g, 'Patient' || g, DATE '2015-01-01' + (g % 3000), CASE WHEN g % 2 = 0 THEN 'male' ELSE 'female' END
       FROM generate_series(1, $1) g JOIN users u ON u.email = 'perf.' || ((g + 1) / 2) || '@example.com'`, [N]));
  await step(`registrations (${N})`, () => db.query(
    `WITH p AS (SELECT p.id, p.account_user_id, row_number() OVER (ORDER BY p.created_at, p.id) AS g FROM patients p WHERE p.first_name LIKE 'Perf%'),
          x AS (SELECT p.*, (now() AT TIME ZONE 'Asia/Riyadh') - ((g - 1) / 100) * interval '1 month' AS at, ((g - 1) % 100) + 1 AS seq FROM p)
     INSERT INTO registrations (account_user_id, patient_id, branch_id, status, tracking_id, tracking_period, tracking_seq, contact_full_name, contact_email, contact_phone,
                                patient_age_months_at_registration, idempotency_key, request_fingerprint, created_at)
     SELECT account_user_id, id, ($1::uuid[])[1 + (g % array_length($1::uuid[], 1))],
            (ARRAY['registration_completed','sample_collected','sample_packaged','dispatched','received_by_laboratory','analysis_in_progress','report_available','cancelled'])[1 + (g % 8)],
            'TRC-SA-' || to_char(at, 'MM') || '/' || to_char(at, 'YY') || '-' || lpad((seq + 50000)::text, 5, '0'), to_char(at, 'YYMM'), seq + 50000,
            'Perf Guardian ' || g, 'perf.' || ((g + 1) / 2) || '@example.com', '+9665' || lpad((g % 100000000)::text, 8, '0'),
            60 + (g % 100), gen_random_uuid(), '\\x00', at AT TIME ZONE 'Asia/Riyadh'
       FROM x`, [branches]));
  await step('status history (3 per registration)', () => db.query(
    `INSERT INTO registration_status_history (registration_id, from_status, to_status, created_at)
     SELECT r.id, NULL, 'registration_completed', r.created_at FROM registrations r
     UNION ALL SELECT r.id, 'registration_completed', 'awaiting_sample_collection', r.created_at + interval '1 hour' FROM registrations r
     UNION ALL SELECT r.id, 'awaiting_sample_collection', r.status, r.created_at + interval '3 days' FROM registrations r`));
  await step('customer QR tokens', () => db.query(
    `INSERT INTO customer_qr_tokens (registration_id, token_hmac, token_enc, created_at)
     SELECT r.id, sha256(convert_to(r.id::text, 'UTF8')), 'synthetic', r.created_at FROM registrations r
      WHERE NOT EXISTS (SELECT 1 FROM customer_qr_tokens q WHERE q.registration_id = r.id)`));
  // Collected registrations: session, identity check, sample, 1–5 custody events.
  await step('collection sessions + identity checks + samples', async () => {
    await db.query(
      `INSERT INTO collection_sessions (registration_id, qr_token_id, staff_user_id, branch_id, created_at, expires_at, completed_at)
       SELECT r.id, q.id, $1, r.branch_id, r.created_at + interval '3 days', r.created_at + interval '3 days 15 minutes', r.created_at + interval '3 days 5 minutes'
         FROM registrations r JOIN customer_qr_tokens q ON q.registration_id = r.id
        WHERE r.status NOT IN ('registration_completed', 'cancelled') AND r.contact_full_name LIKE 'Perf%'`, [staff.userId]);
    await db.query(
      `INSERT INTO identity_verifications (collection_session_id, registration_id, patient_id, method, status, patient_version_at, performed_by, created_at)
       SELECT cs.id, cs.registration_id, r.patient_id, 'dev_simulated', 'verified', now(), $1, cs.created_at
         FROM collection_sessions cs JOIN registrations r ON r.id = cs.registration_id WHERE r.contact_full_name LIKE 'Perf%'`, [staff.userId]);
    await db.query(
      `INSERT INTO samples (registration_id, status, sample_code, sample_seq, branch_id, collected_by, collected_at, collection_session_id, identity_verification_id, instructions_id, checklist, status_changed_at)
       SELECT r.id,
              CASE r.status WHEN 'sample_collected' THEN 'collected' WHEN 'sample_packaged' THEN 'packaged' ELSE r.status END,
              r.tracking_id || '-S01', 1, r.branch_id, $1, cs.completed_at, cs.id, iv.id, $2, '[]'::jsonb, cs.completed_at + interval '1 day'
         FROM collection_sessions cs JOIN registrations r ON r.id = cs.registration_id JOIN identity_verifications iv ON iv.collection_session_id = cs.id
        WHERE r.contact_full_name LIKE 'Perf%'`, [staff.userId, instr]);
  });
  await step('custody events', () => db.query(
    `INSERT INTO custody_events (sample_id, registration_id, event_type, from_status, to_status, occurred_at, recorded_by, actor_role, location_type, branch_id, identified_by)
     SELECT s.id, s.registration_id, 'transition', st.from_s, st.to_s, s.collected_at + st.n * interval '1 day',
            CASE WHEN st.lab THEN $2::uuid ELSE $1::uuid END, CASE WHEN st.lab THEN 'lab_operator' ELSE 'collection_staff' END,
            CASE WHEN st.lab THEN 'laboratory' ELSE 'branch' END, CASE WHEN st.lab THEN NULL ELSE s.branch_id END, 'sample_qr'
       FROM samples s JOIN registrations r ON r.id = s.registration_id
       CROSS JOIN LATERAL (VALUES (0, NULL, 'collected', false), (1, 'collected', 'packaged', false), (2, 'packaged', 'ready_for_dispatch', false),
                                  (3, 'ready_for_dispatch', 'dispatched', false), (5, 'dispatched', 'received_by_laboratory', true)) AS st(n, from_s, to_s, lab)
      WHERE r.contact_full_name LIKE 'Perf%' AND st.n <= CASE s.status WHEN 'collected' THEN 0 WHEN 'packaged' THEN 1 WHEN 'dispatched' THEN 3 ELSE 5 END`, [staff.userId, lab.userId]));
  await step('email outbox (2 sent per registration)', () => db.query(
    `INSERT INTO email_outbox (kind, locale, to_email, registration_id, status, sent_at, attempts, created_at)
     SELECT k, 'en', r.contact_email, r.id, 'sent', r.created_at, 1, r.created_at FROM registrations r CROSS JOIN (VALUES ('registration_confirmation'), ('sample_received')) v(k)
      WHERE r.contact_full_name LIKE 'Perf%'`));
  await step(`audit log (${AUDIT_PER_REG} per registration, through the hash-chain trigger)`, async () => {
    for (let done = 0; done < N * AUDIT_PER_REG; done += 50_000) {
      await db.query(
        `INSERT INTO audit_logs (actor_user_id, actor_role, action, outcome, target_type, target_id, metadata, occurred_at)
         SELECT NULL, 'customer', (ARRAY['registration.viewed','qr.viewed','auth.sign_in','registration.created','custody.transition'])[1 + (g % 5)], 'success',
                'registration', g::text, '{}'::jsonb, now() - (($1::int - g) % 3650) * interval '1 day'
           FROM generate_series($2::int, $3::int) g`, [N * AUDIT_PER_REG, done + 1, Math.min(done + 50_000, N * AUDIT_PER_REG)]);
    }
  });
  await step('ANALYZE', () => db.query('ANALYZE'));
  await db.query('SELECT pg_stat_statements_reset()');
}, 1_800_000);
afterAll(async () => t?.close());

describe('performance on synthetic data', () => {
  it('times the main paths and records query plans', async () => {
    const counts = (await t.db.query(
      `SELECT (SELECT count(*) FROM registrations) AS registrations, (SELECT count(*) FROM samples) AS samples, (SELECT count(*) FROM custody_events) AS custody_events,
              (SELECT count(*) FROM audit_logs) AS audit_logs, (SELECT count(*) FROM email_outbox) AS emails, pg_size_pretty(pg_database_size(current_database())) AS size`)).rows[0];
    const scanText = decodeQrPng((await getBinary(t, cust.c, `/me/registrations/${cust.registration.id}/qr.png`)).body)!;
    // A fresh customer for the write path (each create is rate limited per account).
    const writer = await t.customer();
    const body = await registrationBody(writer.c, { branchId });
    const reg = (c: TestClient) => c.post('/me/registrations', body, { headers: { 'idempotency-key': randomUUID() } });

    await measure('customer: list own registrations', () => cust.c.get('/me/registrations'));
    await measure('customer: registration detail', () => cust.c.get(`/me/registrations/${cust.registration.id}`));
    await measure('customer: QR image (PNG)', () => cust.c.get(`/me/registrations/${cust.registration.id}/qr.png`));
    await measure('customer: create registration', () => reg(writer.c), [200, 201, 429]);
    await measure('staff: validate customer QR', () => staff.c.post('/staff/qr/validate', { code: scanText, branchId }), [200, 409, 429]);
    await measure('staff: samples needing branch steps', () => staff.c.get('/staff/samples'));
    await measure('lab: dashboard', () => lab.c.get('/lab/dashboard'));
    await measure('admin: dashboard stats', () => sa.c.get('/admin/stats'));
    await measure('admin: registrations, newest', () => sa.c.get('/admin/registrations'));
    await measure('admin: search by name', () => sa.c.get('/admin/registrations?q=Perf%20Guardian%201234&type=name'));
    await measure('admin: search by tracking ID', () => sa.c.get('/admin/registrations?q=TRC-SA-01&type=tracking'));
    await measure('admin: samples list', () => sa.c.get('/admin/samples'));
    await measure('admin: audit log page', () => sa.c.get('/admin/audit-logs?limit=50'));
    await measure('admin: operational CSV (1 month)', () => sa.c.get('/admin/reports/operational.csv'), [200, 429]); // 30 exports/hour per account

    // One-off heavy operations (timed once each; they scan everything).
    const once = async (name: string, fn: () => Promise<{ status: number }>) => {
      const s = performance.now();
      const r = await fn();
      timings.push({ name, mode: 'single run', n: 1, p50: Math.round(performance.now() - s), p95: Math.round(performance.now() - s), max: Math.round(performance.now() - s), errors: r.status === 200 ? 0 : 1 });
    };
    await once('audit: sign checkpoint (custody digest over all events)', () => sa.c.post('/admin/audit-integrity/checkpoint', {}));
    await once('audit: full verification (whole chain + checkpoints)', () => sa.c.post('/admin/audit-integrity/verify', {}));

    const top = (await t.db.query(
      `SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 160) AS query, calls, round(mean_exec_time::numeric, 2) AS mean_ms, round(max_exec_time::numeric, 2) AS max_ms,
              round(total_exec_time::numeric, 1) AS total_ms, shared_blks_read AS disk_blocks
         FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND query NOT ILIKE '%pg_stat_statements%' AND query NOT ILIKE 'EXPLAIN%'
        ORDER BY mean_exec_time DESC LIMIT 12`)).rows;
    const conns = (await t.db.query(`SELECT count(*)::int AS n, max(setting::int) FILTER (WHERE name IS NOT NULL) AS max FROM pg_stat_activity, (SELECT 'max_connections' AS name, setting FROM pg_settings WHERE name = 'max_connections') s WHERE datname IS NOT NULL`)).rows[0];
    const seqScans = (await t.db.query(
      `SELECT relname, seq_scan, idx_scan, n_live_tup FROM pg_stat_user_tables WHERE n_live_tup > 1000 ORDER BY seq_scan DESC LIMIT 10`)).rows;

    const md = [
      '# TRACED: Performance results (synthetic data)',
      '',
      `Generated by \`npm run test:perf\` on ${new Date().toISOString().slice(0, 10)}. **Local machine, not Cloud SQL:** ${cpus().length} logical CPUs (${cpus()[0]?.model.trim()}), ${Math.round(totalmem() / 2 ** 30)} GB RAM, Windows, embedded PostgreSQL 18 with max_connections 25, shared_buffers 128MB, work_mem 4MB. Requests run in-process (no network, no TLS). See \`docs/performance/README.md\` for how to read this.`,
      '',
      '## Data volume',
      '',
      `| registrations | samples | custody events | audit entries | emails | database size |`,
      `|---|---|---|---|---|---|`,
      `| ${counts.registrations} | ${counts.samples} | ${counts.custody_events} | ${counts.audit_logs} | ${counts.emails} | ${counts.size} |`,
      '',
      '## Bulk load (setup only, not an application path)',
      '',
      '| step | ms |', '|---|---|', ...loadSteps.map(([n, ms]) => `| ${n} | ${ms} |`),
      '',
      `## API timings (${ITER} requests per mode; milliseconds)`,
      '',
      '| path | mode | n | p50 | p95 | max | non-OK |', '|---|---|---|---|---|---|---|',
      ...timings.map((x) => `| ${x.name} | ${x.mode} | ${x.n} | ${x.p50} | ${x.p95} | ${x.max} | ${x.errors} |`),
      '',
      '"non-OK" counts responses outside the expected statuses; for the create, QR and CSV paths the per-account rate limits (429) and the already-open collection (409) are expected and counted as OK (the CSV export allows 30 per hour, so most of its timed requests measure the refusal).',
      '',
      '## Slowest statements by mean time (pg_stat_statements, during the timed run)',
      '',
      '| mean ms | max ms | calls | total ms | blocks read | statement (normalised, truncated) |', '|---|---|---|---|---|---|',
      ...top.map((q) => `| ${q.mean_ms} | ${q.max_ms} | ${q.calls} | ${q.total_ms} | ${q.disk_blocks} | \`${String(q.query).replace(/\|/g, '\\|')}\` |`),
      '',
      '## Sequential scans on larger tables (whole run, including bulk load)',
      '',
      '| table | seq scans | index scans | rows |', '|---|---|---|---|', ...seqScans.map((r) => `| ${r.relname} | ${r.seq_scan} | ${r.idx_scan ?? 0} | ${r.n_live_tup} |`),
      '',
      `Connections open at the end of the run: ${conns?.n ?? '?'} (server limit ${conns?.max ?? 25}; the test app pool allows 20).`,
      '',
    ];
    mkdirSync(path.resolve('docs/performance'), { recursive: true });
    writeFileSync(path.resolve('docs/performance/results.md'), `${md.join('\n')}\n`);
    expect(timings.length).toBeGreaterThan(20);
  });
});
