import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetJwksCache, verifyGoogleIdToken } from '../src/lib/scheduler-auth.ts';
import { assignBranch, customerWithRegistration, decodeQrPng, getBinary } from './helpers/registration.ts';
import { setupTestApp, type TestEnv } from './helpers/test-app.ts';

// Phase 7 milestone 4: signed checkpoints, independent verification and tamper detection. Each
// tamper scenario runs on its own throw-away database (the test role is a superuser, standing in
// for someone with database-owner access who disables the append-only triggers).

const KEY = randomBytes(32).toString('base64');
const dirs: string[] = [];
const sinkDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'traced-cp-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function env(withKey = true) {
  const t = await setupTestApp();
  if (withKey) {
    t.config.auditCheckpointKey = KEY;
    t.config.auditCheckpointDir = sinkDir();
  }
  const sa = await t.mfaStaff(['super_admin']);
  return { t, sa };
}

/** Collect one sample so custody_events has a row (full Phase 4 flow, dev identity). */
async function oneCustodyEvent(t: TestEnv) {
  const { rows } = await t.db.query<{ id: string }>(`SELECT id FROM collection_branches WHERE code = 'DEV-RUH-01'`);
  const branchId = rows[0]!.id;
  const staff = await t.staff(['collection_staff']);
  await assignBranch(t, staff.userId, branchId);
  const cust = await customerWithRegistration(t, { branchId });
  const text = decodeQrPng((await getBinary(t, cust.c, `/me/registrations/${cust.registration.id}/qr.png`)).body)!;
  const v = (await staff.c.post('/staff/qr/validate', { code: text, branchId })).body;
  const ready = (await staff.c.post(`/staff/collection-sessions/${v.collectionSessionId}/identity/dev`, { outcome: 'verified' })).body;
  const res = await staff.c.post(`/staff/collection-sessions/${v.collectionSessionId}/collect`, {
    instructionsId: ready.collectionInstructions.id, checklist: ready.collectionInstructions.checklist.map((i: { id: string }) => i.id),
  });
  expect(res.status).toBe(200);
}

async function asOwner(t: TestEnv, table: string, sql: string, params: unknown[] = []) {
  const c = await t.db.connect();
  try {
    await c.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    await c.query(sql, params);
    await c.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  } finally {
    c.release();
  }
}

describe('checkpoints and verification (untampered)', () => {
  let t: TestEnv;
  let sa: Awaited<ReturnType<TestEnv['mfaStaff']>>;
  beforeAll(async () => ({ t, sa } = await env()));
  afterAll(async () => t.close());

  it('signs a checkpoint, writes the external copy, and verifies clean', async () => {
    await oneCustodyEvent(t);
    const cp = await sa.c.post('/admin/audit-integrity/checkpoint', {});
    expect(cp.status).toBe(200);
    expect(cp.body.checkpoint).toMatchObject({ sink: 'file', custodyCount: 1 });
    expect(cp.body.checkpoint.keyId).toMatch(/^[0-9a-f]{16}$/);
    const files = readdirSync(t.config.auditCheckpointDir!);
    expect(files).toHaveLength(1);
    const doc = readFileSync(path.join(t.config.auditCheckpointDir!, files[0]!), 'utf8');
    expect(doc).not.toContain(KEY);
    expect(doc).not.toMatch(/@|TRC-SA/); // hashes and counts only
    const v = await sa.c.post('/admin/audit-integrity/verify', {});
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ outcome: 'ok', firstBrokenSeq: null, checkpointsChecked: 1, findings: [] });
    const summary = await sa.c.get('/admin/audit-integrity');
    expect(summary.body.configuration).toMatchObject({ checkpointKeyConfigured: true, sink: 'file' });
    expect(summary.body.verifications[0].outcome).toBe('ok');
    expect(JSON.stringify(summary.body)).not.toContain(KEY);
  });

  it('auditors view and verify but cannot create checkpoints; admins cannot either', async () => {
    const auditor = await t.mfaStaff(['auditor']);
    const admin = await t.mfaStaff(['admin']);
    expect((await auditor.c.get('/admin/audit-integrity')).status).toBe(200);
    expect((await auditor.c.post('/admin/audit-integrity/verify', {})).status).toBe(200);
    expect((await auditor.c.post('/admin/audit-integrity/checkpoint', {})).status).toBe(403);
    expect((await admin.c.post('/admin/audit-integrity/checkpoint', {})).status).toBe(403);
    const lab = await t.mfaStaff(['lab_operator']);
    expect((await lab.c.get('/admin/audit-integrity')).status).toBe(403);
  });

  it('checkpoint and verification records are append-only', async () => {
    await expect(t.db.query('UPDATE audit_checkpoints SET custody_count = 0')).rejects.toThrow(/append-only/);
    await expect(t.db.query('DELETE FROM audit_verifications')).rejects.toThrow(/append-only/);
    await expect(t.db.query('TRUNCATE audit_checkpoints')).rejects.toThrow(/append-only/);
    await expect(t.db.query('TRUNCATE sample_label_prints')).rejects.toThrow(/append-only/);
  });

  it('range verification anchors on the previous row', async () => {
    const { rows } = await t.db.query<{ max: string }>('SELECT max(chain_seq) AS max FROM audit_logs');
    const max = Number(rows[0]!.max);
    expect((await t.db.query('SELECT audit_verify_chain_range(2, $1) AS r', [max])).rows[0].r).toBeNull();
    expect(Number((await t.db.query('SELECT audit_verify_chain_range(1, $1) AS r', [max + 5])).rows[0].r)).toBe(max + 1);
  });

  it('without a key the server refuses to create checkpoints', async () => {
    const key = t.config.auditCheckpointKey;
    t.config.auditCheckpointKey = undefined;
    try {
      const r = await sa.c.post('/admin/audit-integrity/checkpoint', {});
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('CHECKPOINT_KEY_MISSING');
    } finally {
      t.config.auditCheckpointKey = key;
    }
  });
});

describe('tamper detection', () => {
  it('an edited audit row breaks the chain', async () => {
    const { t, sa } = await env();
    try {
      await sa.c.post('/admin/audit-integrity/checkpoint', {});
      await asOwner(t, 'audit_logs', `UPDATE audit_logs SET outcome = 'failure' WHERE chain_seq = 2`);
      const v = await sa.c.post('/admin/audit-integrity/verify', {});
      expect(v.body.outcome).toBe('failed');
      expect(v.body.firstBrokenSeq).toBe(2);
      expect(v.body.findings.map((f: { code: string }) => f.code)).toContain('chain_broken');
    } finally {
      await t.close();
    }
  });

  it('rows cut off the end of the chain are caught by the checkpoint', async () => {
    const { t, sa } = await env();
    try {
      const cp = (await sa.c.post('/admin/audit-integrity/checkpoint', {})).body.checkpoint;
      await asOwner(t, 'audit_logs', 'DELETE FROM audit_logs WHERE chain_seq >= $1', [cp.auditLastSeq]);
      // The remaining prefix still verifies on its own...
      expect((await t.db.query('SELECT audit_verify_chain() AS r')).rows[0].r).toBeNull();
      // ...but the signed checkpoint says more rows existed.
      const v = await sa.c.post('/admin/audit-integrity/verify', {});
      expect(v.body.outcome).toBe('failed');
      expect(v.body.findings.map((f: { code: string }) => f.code)).toContain('audit_rows_missing');
    } finally {
      await t.close();
    }
  });

  it('an edited custody event changes the custody digest', async () => {
    const { t, sa } = await env();
    try {
      await oneCustodyEvent(t);
      await sa.c.post('/admin/audit-integrity/checkpoint', {});
      await asOwner(t, 'custody_events', `UPDATE custody_events SET remarks = 'changed later'`);
      const v = await sa.c.post('/admin/audit-integrity/verify', {});
      expect(v.body.findings.map((f: { code: string }) => f.code)).toContain('custody_digest_mismatch');
    } finally {
      await t.close();
    }
  });

  it('a deleted or forged checkpoint row is caught by the external copy and the signature', async () => {
    const { t, sa } = await env();
    try {
      await sa.c.post('/admin/audit-integrity/checkpoint', {});
      await sa.c.post('/admin/audit-integrity/checkpoint', {});
      const { rows } = await t.db.query<{ id: string }>('SELECT id FROM audit_checkpoints ORDER BY id');
      await asOwner(t, 'audit_checkpoints', 'DELETE FROM audit_checkpoints WHERE id = $1', [rows[1]!.id]);
      await asOwner(t, 'audit_checkpoints', `UPDATE audit_checkpoints SET custody_count = custody_count + 1 WHERE id = $1`, [rows[0]!.id]);
      const codes = (await sa.c.post('/admin/audit-integrity/verify', {})).body.findings.map((f: { code: string }) => f.code);
      expect(codes).toContain('checkpoint_missing_in_database');
      expect(codes).toContain('checkpoint_signature_invalid');
      expect(codes).toContain('sink_copy_mismatch');
    } finally {
      await t.close();
    }
  });

  it('a checkpoint signed with another key is reported; a deleted sink file is reported', async () => {
    const { t, sa } = await env();
    try {
      await sa.c.post('/admin/audit-integrity/checkpoint', {});
      const f = readdirSync(t.config.auditCheckpointDir!)[0]!;
      rmSync(path.join(t.config.auditCheckpointDir!, f));
      t.config.auditCheckpointKey = randomBytes(32).toString('base64');
      const codes = (await sa.c.post('/admin/audit-integrity/verify', {})).body.findings.map((x: { code: string }) => x.code);
      expect(codes).toEqual(expect.arrayContaining(['checkpoint_unknown_key', 'sink_file_missing']));
    } finally {
      await t.close();
    }
  });

  it('a tampered sink copy is reported', async () => {
    const { t, sa } = await env();
    try {
      await sa.c.post('/admin/audit-integrity/checkpoint', {});
      const file = path.join(t.config.auditCheckpointDir!, readdirSync(t.config.auditCheckpointDir!)[0]!);
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, JSON.stringify({ ...doc, custodyCount: 99 }));
      const codes = (await sa.c.post('/admin/audit-integrity/verify', {})).body.findings.map((x: { code: string }) => x.code);
      expect(codes).toContain('sink_copy_mismatch');
    } finally {
      await t.close();
    }
  });
});

describe('scheduled checkpoint endpoint and scheduler authentication', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-kid', alg: 'RS256', use: 'sig' };
  const AUD = 'https://traced-api.example.run.app';
  const SA = 'scheduler@traced-test.iam.gserviceaccount.com';
  const token = (claims: Record<string, unknown>, kid = 'test-kid') => {
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url');
    const p = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: AUD, email: SA, email_verified: true, iat: now, exp: now + 3600, ...claims })).toString('base64url');
    return `${h}.${p}.${sign('RSA-SHA256', Buffer.from(`${h}.${p}`), privateKey).toString('base64url')}`;
  };
  const fetchJwks = async () => ({ keys: [jwk] });

  let t: TestEnv;
  beforeAll(async () => {
    ({ t } = await env());
    t.config.schedulerOidcAudience = AUD;
    t.config.schedulerOidcServiceAccount = SA;
    t.deps.schedulerJwks = fetchJwks;
    resetJwksCache();
  });
  afterAll(async () => t.close());

  it('accepts the shared secret and a valid Google-signed token; signs a checkpoint and verifies', async () => {
    const c = t.client();
    const bySecret = await c.request('POST', '/internal/audit/checkpoint', undefined, { headers: { authorization: `Bearer ${t.config.internalCronSecret}` } });
    expect(bySecret.status).toBe(200);
    expect(bySecret.body).toMatchObject({ via: 'secret', verification: { outcome: 'ok' } });
    const byOidc = await c.request('POST', '/internal/audit/checkpoint', undefined, { headers: { authorization: `Bearer ${token({})}` } });
    expect(byOidc.status).toBe(200);
    expect(byOidc.body.via).toBe('oidc');
    const audits = await t.db.query(`SELECT actor_role FROM audit_logs WHERE action = 'audit.checkpoint_created' AND actor_user_id IS NULL`);
    expect(audits.rows.every((r) => r.actor_role === 'scheduler')).toBe(true);
  });

  it('rejects wrong audience, wrong account, unverified email, expiry, unknown key, bad signature and none', async () => {
    const c = t.client();
    const bad = [
      token({ aud: 'https://other.example' }), token({ email: 'someone@else.iam.gserviceaccount.com' }), token({ email_verified: false }),
      token({ exp: Math.floor(Date.now() / 1000) - 600 }), token({ iss: 'https://evil.example' }), token({}, 'unknown-kid'),
      `${token({}).slice(0, -6)}AAAAAA`, 'not-a-token', '',
    ];
    for (const b of bad) {
      const r = await c.request('POST', '/internal/outbox/run', undefined, { headers: { authorization: `Bearer ${b}` } });
      expect(r.status, b.slice(0, 30)).toBe(401);
    }
    // alg=none is refused outright.
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'test-kid' })).toString('base64url')}.${token({}).split('.')[1]}.`;
    expect(await verifyGoogleIdToken(none, { audience: AUD, email: SA, fetchJwks })).toBe(false);
  });

  it('is disabled (404) when no scheduler credential is configured', async () => {
    const saved = { s: t.config.internalCronSecret, a: t.config.schedulerOidcAudience };
    t.config.internalCronSecret = undefined;
    t.config.schedulerOidcAudience = undefined;
    try {
      expect((await t.client().request('POST', '/internal/audit/checkpoint', undefined, { headers: { authorization: 'Bearer x' } })).status).toBe(404);
    } finally {
      t.config.internalCronSecret = saved.s;
      t.config.schedulerOidcAudience = saved.a;
    }
  });
});
