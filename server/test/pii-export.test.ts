import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { riyadhToday } from '../src/modules/registrations/rules.ts';
import { customerWithRegistration } from './helpers/registration.ts';
import { setupTestApp, totpCode, type TestEnv } from './helpers/test-app.ts';

// Phase 7 milestone 5: super-admin personal-data export (step-up MFA, reason, limits,
// minimisation, CSV safety, no caching, audit without content).

let t: TestEnv;
let regA: Awaited<ReturnType<typeof customerWithRegistration>>;
let regB: Awaited<ReturnType<typeof customerWithRegistration>>;
const today = riyadhToday();
const reason = 'Monthly reconciliation requested by LinusBio operations';

beforeAll(async () => {
  t = await setupTestApp();
  regA = await customerWithRegistration(t);
  regB = await customerWithRegistration(t);
  // Hostile spreadsheet content and Arabic text, set directly (the forms would normalise them).
  await t.db.query(`UPDATE patients SET first_name = '=HYPERLINK("http://x")', last_name = 'محمد' WHERE id = (SELECT patient_id FROM registrations WHERE id = $1)`, [regA.registration.id]);
});
afterAll(async () => t.close());

/** A fresh super admin per successful export: each authenticator step can be used only once. */
async function superAdmin() {
  const sa = await t.mfaStaff(['super_admin']);
  return { ...sa, code: () => totpCode(sa.secret, 1) };
}
const exportCsv = (c: Awaited<ReturnType<typeof superAdmin>>['c'], body: Record<string, unknown>) => c.post('/admin/exports/personal-data', body);
async function rawExport(sa: Awaited<ReturnType<typeof superAdmin>>, body: Record<string, unknown>) {
  return t.app.request('/api/v1/admin/exports/personal-data', {
    method: 'POST', body: JSON.stringify(body),
    headers: { cookie: sa.c.cookie!, 'x-csrf-token': sa.c.csrf!, 'content-type': 'application/json', origin: 'http://localhost:8787', 'x-forwarded-for': '198.51.100.250' },
  });
}

describe('personal-data export', () => {
  it('returns only the chosen columns, CSV-safe, UTF-8 with BOM, no-store, and audits without content', async () => {
    const sa = await superAdmin();
    const res = await rawExport(sa, { from: today, to: today, reason, code: sa.code(), fields: ['patient_name', 'contact_phone'] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="traced-personal-data-/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('tracking_id,registered_date_riyadh,status,branch_code,current_sample_id,patient_first_name,patient_last_name,contact_phone');
    expect(lines).toHaveLength(3);
    expect(text).toContain(regA.registration.trackingId);
    expect(text).toContain(`"'=HYPERLINK(""http://x"")"`); // neutralised formula
    expect(text).toContain('محمد');
    expect(text).not.toMatch(/@example\.com/); // email not requested
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2},.*\d{4}-\d{2}-\d{2}/); // no date of birth column
    const sha = createHash('sha256').update(buf).digest('hex');
    expect(res.headers.get('x-export-sha256')).toBe(sha);
    const audit = await t.db.query(`SELECT fields_accessed, metadata FROM audit_logs WHERE action = 'report.exported_pii' AND outcome = 'success' AND actor_user_id = $1`, [sa.userId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].fields_accessed).toEqual(['patient_name', 'contact_phone']);
    expect(audit.rows[0].metadata).toMatchObject({ reason, rows: 2, sha256: sha, personalData: true });
    expect(JSON.stringify(audit.rows[0])).not.toContain('محمد');
    expect(JSON.stringify(audit.rows[0])).not.toContain(regA.registration.trackingId);
  });

  it('needs a fresh authenticator code every time; a reused or wrong code is refused and audited', async () => {
    const sa = await superAdmin();
    const code = sa.code();
    expect((await exportCsv(sa.c, { from: today, to: today, reason, code, fields: ['gender'] })).status).toBe(200);
    expect((await exportCsv(sa.c, { from: today, to: today, reason, code, fields: ['gender'] })).status).toBe(401);
    expect((await exportCsv(sa.c, { from: today, to: today, reason, code: '000000', fields: ['gender'] })).status).toBe(401);
    expect((await exportCsv(sa.c, { from: today, to: today, reason, code: sa.recoveryCodes[0], fields: ['gender'] })).status).toBe(401);
    const failures = await t.db.query(`SELECT 1 FROM audit_logs WHERE action = 'report.exported_pii' AND outcome = 'failure' AND actor_user_id = $1`, [sa.userId]);
    expect(failures.rowCount).toBe(3);
  });

  it('is super-admin only', async () => {
    const admin = await t.mfaStaff(['admin']);
    const auditor = await t.mfaStaff(['auditor']);
    for (const s of [admin, auditor]) {
      expect((await s.c.post('/admin/exports/personal-data', { from: today, to: today, reason, code: totpCode(s.secret, 1), fields: ['gender'] })).status).toBe(403);
    }
    expect((await regA.c.post('/admin/exports/personal-data', { from: today, to: today, reason, code: '123456', fields: ['gender'] })).status).toBe(403);
  });

  it('validates reason, columns and the date range; refuses (not truncates) oversized exports', async () => {
    const sa = await superAdmin();
    const ok = { from: today, to: today, reason, code: '123456', fields: ['gender'] };
    expect((await exportCsv(sa.c, { ...ok, reason: '' })).status).toBe(422);
    expect((await exportCsv(sa.c, { ...ok, fields: [] })).status).toBe(422);
    expect((await exportCsv(sa.c, { ...ok, fields: ['national_id'] })).status).toBe(422);
    expect((await exportCsv(sa.c, { ...ok, fields: ['p.password_hash'] })).status).toBe(422);
    expect((await exportCsv(sa.c, { ...ok, from: '2026-01-01', to: '2026-12-31' })).status).toBe(422);
    expect((await exportCsv(sa.c, { ...ok, to: '2000-01-01' })).status).toBe(422);
    t.config.exportPiiMaxRows = 1;
    try {
      const r = await exportCsv(sa.c, { ...ok, code: sa.code() });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('EXPORT_TOO_LARGE');
    } finally {
      t.config.exportPiiMaxRows = 2000;
    }
    expect(regB).toBeDefined();
  });
});
