import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { currentConsentDocuments } from '../src/modules/consents/consents.service.ts';
import { CONSENT_TYPES, type Manifest, planRelease, publishRelease, ReleaseError, validateRelease } from '../src/modules/consents/publish.ts';
import { customerWithRegistration } from './helpers/registration.ts';
import { setupTestApp, type TestEnv } from './helpers/test-app.ts';

// Phase 8E: approved consent publishing (server-side command). All texts here are SYNTHETIC test content:
// no legal or clinical wording and no real approval reference.

const run = promisify(execFile);
let t: TestEnv;
let superAdmin: { userId: string; email: string };
let admin: { email: string };
let appUrl: string;

beforeAll(async () => {
  t = await setupTestApp({ appRole: true });
  superAdmin = await t.staff(['super_admin']);
  admin = await t.staff(['admin']);
  await customerWithRegistration(t); // a real registration whose consent records point at the earlier (provisional) texts
  const base = inject('pgBaseUrl');
  const pw = createHash('sha256').update(`traced_app|${base}`).digest('hex').slice(0, 32);
  appUrl = `${base.replace(/\/\/[^@]+@/, `//traced_app:${pw}@`)}/${t.config.databaseUrl.split('/').pop()}`;
});
afterAll(async () => t.close());

const inFuture = () => new Date(Date.now() + 60_000).toISOString();

/** Writes a synthetic release folder and returns the manifest path. */
function release(opts: { version?: string; types?: readonly string[]; locales?: readonly string[]; mutate?: (m: Manifest) => void; bodies?: Record<string, string> } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'traced-consent-'));
  const types = opts.types ?? CONSENT_TYPES;
  const locales = opts.locales ?? ['en', 'ar'];
  const documents = [];
  for (const type of types) for (const locale of locales) {
    const file = `${type}.${locale}.txt`;
    const body = opts.bodies?.[`${type}/${locale}`]
      ?? (locale === 'en' ? `SYNTHETIC TEST TEXT for ${type}. Not legal wording.\nSecond paragraph.` : `نص اختبار اصطناعي (SYNTHETIC) للنوع ${type}. ليس صياغة قانونية.`);
    writeFileSync(path.join(dir, file), `﻿${body.replace(/\n/g, '\r\n')}`, 'utf8');
    documents.push({ type, locale, title: locale === 'en' ? `Synthetic ${type}` : `اختبار ${type}`, bodyFile: file });
  }
  const m: Manifest = { version: opts.version ?? '1.0', effectiveFrom: inFuture(), approvalReference: 'SYNTHETIC-REF-0001', documents };
  opts.mutate?.(m);
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2));
  return { dir, manifest: path.join(dir, 'manifest.json'), m };
}

const cli = (args: string[], url = appUrl) =>
  run(process.execPath, ['--import', 'tsx', 'server/src/cli/publish-consent.ts', ...args], { env: { ...process.env, DATABASE_URL: url } })
    .then((r) => ({ code: 0, out: r.stdout, err: r.stderr }))
    .catch((e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout, err: e.stderr }));

const counts = async () => {
  const docs = await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM consent_documents`);
  const aud = await t.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'consent.published'`);
  return { docs: docs.rows[0]!.n, audits: aud.rows[0]!.n };
};
const problems = (fn: () => unknown) => { try { fn(); } catch (e) { if (e instanceof ReleaseError) return e.problems.join('\n'); throw e; } return ''; };

describe('publish-consent command (runs as the least-privilege traced_app role)', () => {
  it('dry run validates and writes nothing', async () => {
    const before = await counts();
    const r = release({ version: '1.0' });
    const res = await cli(['--manifest', r.manifest, '--publisher', superAdmin.email, '--target', 'development', '--dry-run']);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain('DRY RUN (nothing is written)');
    expect(res.out).toMatch(/privacy_policy\s+en\s+v1\.0\s+sha256 [0-9a-f]{64}/);
    expect(await counts()).toEqual(before);
  });

  it('publishes all 8 documents as approved, immutable versions with reference, publisher, timestamps, checksum and audit', async () => {
    const before = await counts();
    const r = release({ version: '1.0' });
    const res = await cli(['--manifest', r.manifest, '--publisher', superAdmin.email, '--target', 'development', '--publish']);
    expect(res.code, res.err).toBe(0);
    expect(res.out).toContain('Published 8 approved consent documents');
    expect(await counts()).toEqual({ docs: before.docs + 8, audits: before.audits + 8 });

    const { rows } = await t.db.query(`SELECT doc_type, locale, version, title, body, status, approval_reference, published_by, approved_by,
             approved_at IS NOT NULL AS approved_at, effective_from > now() AS future, encode(content_sha256, 'hex') AS sha
        FROM consent_documents WHERE version = '1.0' ORDER BY doc_type, locale`);
    expect(rows).toHaveLength(8);
    for (const d of rows) {
      expect(d).toMatchObject({ status: 'approved', approval_reference: 'SYNTHETIC-REF-0001', published_by: superAdmin.userId, approved_by: superAdmin.userId, approved_at: true, future: true });
      expect(d.body).not.toMatch(/\r|﻿/); // line endings and BOM normalised
      expect(d.sha).toBe(createHash('sha256').update(`${d.title}\n\n${d.body}`, 'utf8').digest('hex'));
    }
    const audit = await t.db.query(`SELECT actor_user_id, target_type, metadata FROM audit_logs WHERE action = 'consent.published' ORDER BY chain_seq DESC LIMIT 8`);
    expect(audit.rows.every((a) => a.actor_user_id === superAdmin.userId && a.target_type === 'consent_document' && /^[0-9a-f]{64}$/.test(a.metadata.sha256) && a.metadata.approvalReference === 'SYNTHETIC-REF-0001')).toBe(true);
    expect(await t.db.query(`SELECT audit_verify_chain() AS broken`).then((x) => x.rows[0].broken)).toBeNull();

    // Effective in the future: not yet served; once effective, the approved set is what production serves.
    expect((await currentConsentDocuments(t.db, { env: 'production' })).length).toBe(0);
    await t.db.query(`ALTER TABLE consent_documents DISABLE TRIGGER consent_documents_freeze`);
    await t.db.query(`UPDATE consent_documents SET effective_from = now() - interval '1 second' WHERE version = '1.0'`);
    await t.db.query(`ALTER TABLE consent_documents ENABLE TRIGGER consent_documents_freeze`);
    const served = await currentConsentDocuments(t.db, { env: 'production' });
    expect(served.map((d) => `${d.type}/${d.locale}/${d.version}`).sort()).toEqual(CONSENT_TYPES.flatMap((ty) => [`${ty}/ar/1.0`, `${ty}/en/1.0`]).sort());
  });

  it('never overwrites an existing version (same or different text) and changes nothing', async () => {
    const before = await counts();
    for (const bodies of [undefined, { 'privacy_policy/en': 'SYNTHETIC TEST TEXT changed wording.' }]) {
      const r = release({ version: '1.0', bodies });
      const res = await cli(['--manifest', r.manifest, '--publisher', superAdmin.email, '--target', 'development', '--publish']);
      expect(res.code).toBe(1);
      expect(res.err).toMatch(/already exists .*never overwritten/);
    }
    expect(await counts()).toEqual(before);
  });

  it('refuses publishers without consent.manage, and production rules on a non-production database', async () => {
    const r = release({ version: '1.1' });
    const asAdmin = await cli(['--manifest', r.manifest, '--publisher', admin.email, '--target', 'development', '--publish']);
    expect(asAdmin.code).toBe(1);
    expect(asAdmin.err).toContain('not authorised to publish consent documents');
    const unknown = await cli(['--manifest', r.manifest, '--publisher', 'nobody@example.com', '--target', 'development', '--dry-run']);
    expect(unknown.err).toContain('publisher account does not exist');
    // Production target: synthetic content is refused before anything else...
    const prod = await cli(['--manifest', r.manifest, '--publisher', superAdmin.email, '--target', 'production', '--dry-run']);
    expect(prod.code).toBe(1);
    expect(prod.err).toContain('synthetic test content can never be published to production');
    // ...and the database checks require the real production database and an MFA-enrolled publisher.
    const rel = validateRelease(JSON.parse(JSON.stringify(r.m)), { baseDir: r.dir, target: 'development' });
    const dbChecks = await planRelease(t.db, rel, { publisherEmail: superAdmin.email, target: 'production' }).catch((e: ReleaseError) => e.problems.join(' | '));
    expect(dbChecks).toContain('requires the production database "traced"');
    expect(dbChecks).toContain('two-step verification enrolled');
    const noMode = await cli(['--manifest', r.manifest, '--publisher', superAdmin.email, '--target', 'development']);
    expect(noMode.code).toBe(2);
  });

  it('a suspended super admin cannot publish', async () => {
    const sa = await t.staff(['super_admin']);
    await t.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [sa.userId]);
    const r = release({ version: '1.2' });
    const plan = planRelease(t.db, validateRelease(JSON.parse(JSON.stringify(r.m)), { baseDir: r.dir, target: 'development' }), { publisherEmail: sa.email, target: 'development' });
    await expect(plan).rejects.toThrow(/not active/);
  });
});

describe('release validation', () => {
  const v = (r: ReturnType<typeof release>, extra: { target?: 'production' | 'development'; partial?: boolean } = {}) =>
    problems(() => validateRelease(JSON.parse(JSON.stringify(r.m)), { baseDir: r.dir, target: extra.target ?? 'development', partial: extra.partial }));

  it('requires every field and both languages; refuses incomplete sets', () => {
    expect(v(release({ mutate: (m) => { delete m.approvalReference; } }))).toContain('approvalReference is required');
    expect(v(release({ mutate: (m) => { delete m.version; } }))).toContain('version is required');
    expect(v(release({ mutate: (m) => { m.effectiveFrom = '2026-12-01'; } }))).toContain('effectiveFrom is required');
    expect(v(release({ mutate: (m) => { m.effectiveFrom = '2020-01-01T00:00:00Z'; } }))).toContain('in the past');
    expect(v(release({ mutate: (m) => { m.documents![0]!.title = '  '; } }))).toContain('title is required');
    expect(v(release({ bodies: { 'privacy_policy/en': '   ' } }))).toContain('body text is required');
    expect(v(release({ locales: ['en'] }))).toContain('Arabic version is missing');
    expect(v(release({ types: ['privacy_policy'] }))).toContain('sample_collection_consent: missing from the release');
    expect(v(release({ mutate: (m) => { m.documents![1]!.version = '2.0'; } }))).toContain('same version');
    expect(v(release({ mutate: (m) => { m.documents!.push({ ...m.documents![0]! }); } }))).toContain('duplicate privacy_policy/en');
    expect(v(release({ mutate: (m) => { m.documents![0]!.type = 'marketing'; } }))).toContain('type must be one of');
    expect(v(release({ mutate: (m) => { m.documents![0]!.bodyFile = '../outside.txt'; } }))).toContain('inside the release folder');
  });

  it('refuses provisional or placeholder wording, provisional versions, and wrong-language texts', () => {
    expect(v(release({ version: '0.1-provisional' }))).toContain('looks provisional');
    expect(v(release({ bodies: { 'privacy_policy/en': '[PROVISIONAL DRAFT – NOT LEGALLY APPROVED] text' } }))).toContain('provisional/placeholder wording');
    expect(v(release({ bodies: { 'privacy_policy/en': 'Lorem ipsum dolor sit amet' } }))).toContain('provisional/placeholder wording');
    expect(v(release({ bodies: { 'privacy_policy/ar': 'English only text' } }))).toContain('Arabic document contains no Arabic text');
    expect(v(release())).toBe('');
  });

  it('partial releases are allowed only when the rest of the approved set already exists', async () => {
    const r = release({ version: '1.3', types: ['privacy_policy'] });
    const rel = validateRelease(JSON.parse(JSON.stringify(r.m)), { baseDir: r.dir, target: 'development', partial: true });
    // The 1.0 set from the first suite exists but is effective only now (moved above), so this succeeds.
    const plan = await planRelease(t.db, rel, { publisherEmail: superAdmin.email, target: 'development', partial: true });
    expect(plan.documents).toHaveLength(2);
    // On a database without an approved set the same partial release is refused.
    const fresh = await setupTestApp();
    try {
      const sa = await fresh.staff(['super_admin']);
      await expect(planRelease(fresh.db, rel, { publisherEmail: sa.email, target: 'development', partial: true })).rejects.toThrow(/approved set would be incomplete/);
    } finally {
      await fresh.close();
    }
  });
});

describe('database protections (migration 0012)', () => {
  it('approved documents and their approval details are immutable; provisional can never become approved', async () => {
    const id = (await t.db.query(`SELECT id FROM consent_documents WHERE version = '1.0' LIMIT 1`)).rows[0].id;
    for (const sql of [
      `UPDATE consent_documents SET body = 'changed' WHERE id = $1`,
      `UPDATE consent_documents SET approval_reference = 'OTHER-REF' WHERE id = $1`,
      `UPDATE consent_documents SET effective_from = now() + interval '1 day' WHERE id = $1`,
      `UPDATE consent_documents SET status = 'provisional' WHERE id = $1`,
    ]) await expect(t.db.query(sql, [id])).rejects.toThrow(/immutable|not allowed/);
    const prov = (await t.db.query(`SELECT id FROM consent_documents WHERE status = 'provisional' LIMIT 1`)).rows[0].id;
    await expect(t.db.query(`UPDATE consent_documents SET status = 'approved', approved_at = now(), approval_reference = 'X-REF', published_by = $2 WHERE id = $1`, [prov, superAdmin.userId])).rejects.toThrow(/immutable|not allowed/);
    await expect(t.db.query(`DELETE FROM consent_documents WHERE id = $1`, [id])).rejects.toThrow(/append-only/);
    // Retiring stays possible (provisional or approved -> retired).
    await t.db.query(`UPDATE consent_documents SET status = 'retired' WHERE id = $1`, [prov]);
  });

  it('an approved row without approval reference or publisher is refused by the database', async () => {
    await expect(t.db.query(
      `INSERT INTO consent_documents (doc_type, version, locale, title, body, content_sha256, status, approved_at)
       VALUES ('privacy_policy', '9.9', 'en', 'x', 'x', '\\x00', 'approved', now())`)).rejects.toThrow(/consent_documents_approved_needs_reference/);
  });

  it('the runtime role cannot update or delete consent documents at all', async () => {
    await expect(t.appDb.query(`UPDATE consent_documents SET status = 'retired' WHERE false`)).rejects.toThrow(/permission denied/);
    await expect(t.appDb.query(`DELETE FROM consent_documents WHERE false`)).rejects.toThrow(/permission denied/);
  });

  it('customers\' historical consent records stay linked to the exact earlier version', async () => {
    const before = (await t.db.query(`SELECT c.id, d.version, d.status, encode(d.content_sha256,'hex') AS sha FROM consent_records c JOIN consent_documents d ON d.id = c.consent_document_id ORDER BY c.id`)).rows;
    expect(before.length).toBeGreaterThan(0);
    const r = release({ version: '2.0' });
    await publishRelease(t.db, await planRelease(t.db, validateRelease(JSON.parse(JSON.stringify(r.m)), { baseDir: r.dir, target: 'development' }), { publisherEmail: superAdmin.email, target: 'development' }));
    const after = (await t.db.query(`SELECT c.id, d.version, d.status, encode(d.content_sha256,'hex') AS sha FROM consent_records c JOIN consent_documents d ON d.id = c.consent_document_id ORDER BY c.id`)).rows;
    expect(after).toEqual(before);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM consent_documents WHERE version = '1.0'`)).rows[0].n).toBe(8); // earlier versions kept
  });
});
