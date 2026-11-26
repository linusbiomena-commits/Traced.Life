import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MailMessage, SendResult } from '../src/modules/mail/mailer.ts';
import { MailSendError } from '../src/modules/mail/mailer.ts';
import { enqueueEmail, processOutbox } from '../src/modules/mail/outbox.ts';
import { setupTestApp, type TestEnv } from './helpers/test-app.ts';

// Phase 7 milestone 7: outbox under concurrency (several Cloud Run instances / scheduler runs at
// once), stuck sends, idempotency keys and the scheduled endpoint.

let t: TestEnv;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => t.close());

const tag = () => randomBytes(4).toString('hex');
async function enqueueMany(n: number, prefix: string) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await enqueueEmail(t.db, t.deps, { kind: 'password_changed', locale: 'en', to: `${prefix}.${i}@example.com`, data: {} }))!);
  return ids;
}

/** Records every send; optionally slow, to widen race windows. */
function recordingMailer(delayMs = 0) {
  const keys: string[] = [];
  return {
    keys,
    send: async (m: MailMessage): Promise<SendResult> => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      keys.push(m.idempotencyKey!);
      return { provider: 'memory', messageId: m.idempotencyKey! };
    },
  };
}

describe('outbox reliability', () => {
  it('six concurrent workers deliver each of 60 emails exactly once', async () => {
    const prefix = `conc${tag()}`;
    const ids = await enqueueMany(60, prefix);
    const mailer = recordingMailer(5);
    const deps = { ...t.deps, mailer };
    const runs = await Promise.all(Array.from({ length: 6 }, () => processOutbox(deps, 25)));
    // A second round picks up anything not claimed in the first.
    runs.push(await processOutbox(deps, 100));
    const mine = mailer.keys.filter((k) => ids.some((id) => k.endsWith(id)));
    expect(mine).toHaveLength(60);
    expect(new Set(mine).size).toBe(60);
    const { rows } = await t.db.query(`SELECT status, count(*)::int AS n FROM email_outbox WHERE id = ANY($1::uuid[]) GROUP BY status`, [ids]);
    expect(rows).toEqual([{ status: 'sent', n: 60 }]);
  });

  it('the provider idempotency key is the same on every attempt of one email', async () => {
    const [id] = await enqueueMany(1, `idem${tag()}`);
    const keys: string[] = [];
    const flaky = { ...t.deps, mailer: { send: async (m: MailMessage): Promise<SendResult> => { keys.push(m.idempotencyKey!); if (keys.length < 3) throw new MailSendError('timeout', true); return { provider: 'memory', messageId: 'x' }; } } };
    for (let i = 0; i < 3; i++) {
      await t.db.query('UPDATE email_outbox SET next_attempt_at = now() WHERE id = $1', [id]);
      await processOutbox(flaky, 100);
    }
    const mine = keys.filter((k) => k.endsWith(id!));
    expect(mine).toEqual([`traced-email/${id}`, `traced-email/${id}`, `traced-email/${id}`]);
  });

  it('an email whose sender kept dying is failed at its attempt limit instead of retried forever', async () => {
    const [id] = await enqueueMany(1, `stuck${tag()}`);
    await t.db.query(`UPDATE email_outbox SET status = 'sending', locked_until = now() - interval '1 second', attempts = max_attempts WHERE id = $1`, [id]);
    const mailer = recordingMailer();
    await processOutbox({ ...t.deps, mailer }, 100);
    expect(mailer.keys.some((k) => k.endsWith(id!))).toBe(false);
    const row = (await t.db.query('SELECT status, last_error, payload_enc FROM email_outbox WHERE id = $1', [id])).rows[0];
    expect(row).toMatchObject({ status: 'failed', payload_enc: null });
    expect(row.last_error).toMatch(/gave up/);
  });

  it('a claim that is still locked is not taken by another worker', async () => {
    const [id] = await enqueueMany(1, `locked${tag()}`);
    await t.db.query(`UPDATE email_outbox SET status = 'sending', locked_until = now() + interval '1 minute', attempts = 1 WHERE id = $1`, [id]);
    const mailer = recordingMailer();
    await processOutbox({ ...t.deps, mailer }, 100);
    expect(mailer.keys.some((k) => k.endsWith(id!))).toBe(false);
  });

  it('the scheduled endpoint delivers queued email when no in-process worker runs', async () => {
    const ids = await enqueueMany(3, `sched${tag()}`);
    const res = await t.client().request('POST', '/internal/outbox/run', undefined, { headers: { authorization: `Bearer ${t.config.internalCronSecret}` } });
    expect(res.status).toBe(200);
    expect(res.body.sent).toBeGreaterThanOrEqual(3);
    const { rows } = await t.db.query(`SELECT count(*)::int AS n FROM email_outbox WHERE id = ANY($1::uuid[]) AND status = 'sent'`, [ids]);
    expect(rows[0].n).toBe(3);
  });
});
