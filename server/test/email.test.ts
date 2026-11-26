import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { MailSendError, ResendMailer, type MailMessage } from '../src/modules/mail/mailer.ts';
import { enqueueEmail, processOutbox } from '../src/modules/mail/outbox.ts';
import { renderTemplate } from '../src/modules/mail/templates.ts';
import { extractCustomerToken } from '../src/modules/qr/qr.service.ts';
import { customerWithRegistration, decodeQrPng, register } from './helpers/registration.ts';
import { setupTestApp, type TestEnv } from './helpers/test-app.ts';

let t: TestEnv;
beforeAll(async () => {
  t = await setupTestApp();
});
afterAll(async () => {
  await t.close();
});

const outboxFor = async (registrationId: string) =>
  (await t.db.query(`SELECT kind, status, attempts, provider, provider_message_id, payload_enc, last_error, next_attempt_at > now() AS later
                       FROM email_outbox WHERE registration_id = $1 ORDER BY created_at`, [registrationId])).rows;

describe('registration confirmation email', () => {
  it('is generated automatically once, with tracking ID, scannable QR, branch, instructions, link and support; no patient data', async () => {
    const { registration, email } = await customerWithRegistration(t);
    const mail = await t.waitForMail(email, 'registration_confirmation');
    expect(mail.subject).toBe(`Your TRACED registration is confirmed – ${registration.trackingId}`);
    expect(mail.html).toContain(registration.trackingId);
    expect(mail.html).toContain('Dear Fatimah Al-Harbi,'); // the account holder / guardian
    expect(mail.html).toContain('[DEV] Riyadh sample branch');
    expect(mail.html).toContain('Collection instructions');
    expect(mail.html).toContain(`/traced/account/registration/?id=${registration.id}`);
    expect(mail.html).toContain('LinusBio@karama.tech');
    expect(mail.html).toContain('src="cid:traced-qr"');
    // Patient name, date of birth and phone number never appear in the email.
    for (const pii of ['Layla', registration.patient.dateOfBirth, '551234567', '055 123 4567']) {
      expect(mail.html, pii).not.toContain(pii);
      expect(mail.text, pii).not.toContain(pii);
    }
    const qr = mail.attachments!.find((a) => a.contentId === 'traced-qr')!;
    expect(qr.contentType).toBe('image/png');
    const token = extractCustomerToken(decodeQrPng(qr.content)!);
    expect(token).toMatch(/^c1_/);

    const rows = await outboxFor(registration.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'registration_confirmation', status: 'sent', attempts: 1, provider: 'memory', payload_enc: null });
    expect(rows[0]!.provider_message_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('duplicate automatic emails are suppressed (dedupe key), including on retried submissions', async () => {
    const { c, registration, email } = await customerWithRegistration(t);
    expect(await enqueueEmail(t.db, t.deps, { kind: 'registration_confirmation', locale: 'en', to: email, registrationId: registration.id, dedupeKey: `registration_confirmation:${registration.id}` })).toBeNull();
    const key = randomUUID();
    await register(c, {}, key);
    await register(c, {}, key); // retry
    await t.settleMail();
    const n = await t.db.query(`SELECT count(*)::int AS n FROM email_outbox WHERE user_id = (SELECT account_user_id FROM registrations WHERE id = $1) AND kind = 'registration_confirmation'`, [registration.id]);
    expect(n.rows[0]!.n).toBe(2); // one per registration, not per request
  });

  it('Arabic customers receive the Arabic, right-to-left template', async () => {
    const cust = await t.customer();
    await cust.c.request('PATCH', '/me/profile', { locale: 'ar' });
    const reg = (await register(cust.c)).body.registration;
    const mail = await t.waitForMail(cust.email, 'registration_confirmation');
    expect(mail.locale).toBe('ar');
    expect(mail.html).toContain('dir="rtl"');
    expect(mail.subject).toContain('تم تأكيد تسجيلك في TRACED');
    expect(mail.html).toContain(`<div dir="ltr" style="font:600 22px`);
    expect(mail.html).toContain(reg.trackingId);
    expect(mail.html).toContain('[تجريبي] فرع الرياض');
    expect(mail.html).toContain('/ar/traced/account/registration/');
  });
});

describe('delivery reliability', () => {
  afterEach(() => {
    t.mailer.failNext = 0;
  });

  it('registration succeeds while the provider is down; delivery retries with backoff and then succeeds', async () => {
    const cu = await t.customer();
    t.mailer.failNext = 2; // provider down for the next two sends
    const res = await register(cu.c);
    expect(res.status).toBe(201); // registration does not depend on email delivery
    const registration = res.body.registration;
    await t.settleMail();
    let rows = await outboxFor(registration.id);
    expect(rows[0]).toMatchObject({ status: 'queued', attempts: 1, later: true });
    expect(rows[0]!.last_error).toContain('simulated provider outage');

    await t.db.query(`UPDATE email_outbox SET next_attempt_at = now() WHERE registration_id = $1`, [registration.id]);
    await processOutbox(t.deps);
    rows = await outboxFor(registration.id);
    expect(rows[0]).toMatchObject({ status: 'queued', attempts: 2 });

    await t.db.query(`UPDATE email_outbox SET next_attempt_at = now() WHERE registration_id = $1`, [registration.id]);
    await processOutbox(t.deps);
    rows = await outboxFor(registration.id);
    expect(rows[0]).toMatchObject({ status: 'sent', attempts: 3, last_error: null });
  });

  it('gives up after the maximum attempts, and immediately on permanent errors', async () => {
    const cu = await t.customer();
    t.mailer.failNext = 100;
    const registration = (await register(cu.c)).body.registration;
    await t.settleMail();
    await t.db.query(`UPDATE email_outbox SET max_attempts = 2, next_attempt_at = now() WHERE registration_id = $1`, [registration.id]);
    await processOutbox(t.deps);
    expect((await outboxFor(registration.id))[0]).toMatchObject({ status: 'failed', attempts: 2 });
    t.mailer.failNext = 0;

    const permanent = { ...t.deps, mailer: { send: async () => { throw new MailSendError('resend 422 validation_error', false); } } };
    const id = await enqueueEmail(t.db, t.deps, { kind: 'password_changed', locale: 'en', to: 'bounce@example.com', data: {} });
    await processOutbox(permanent);
    const row = (await t.db.query('SELECT status, attempts FROM email_outbox WHERE id = $1', [id])).rows[0];
    expect(row).toEqual({ status: 'failed', attempts: 1 });

  });

  it('a crashed sender’s claimed email is picked up again after its lock expires', async () => {
    const id = await enqueueEmail(t.db, t.deps, { kind: 'password_changed', locale: 'en', to: 'stuck@example.com', data: {} });
    await t.db.query(`UPDATE email_outbox SET status = 'sending', locked_until = now() - interval '1 second', attempts = 1 WHERE id = $1`, [id]);
    await processOutbox(t.deps);
    expect((await t.db.query('SELECT status FROM email_outbox WHERE id = $1', [id])).rows[0]!.status).toBe('sent');
  });

  it('account emails also go through the outbox, with one-time links encrypted and erased after sending', async () => {
    const email = `outbox.${randomBytes(3).toString('hex')}@example.com`;
    await t.client().post('/auth/sign-up', { confirmAdult: true, email, password: 'correct horse battery staple' });
    const token = await t.tokenFromMail(email, 'verify_email');
    const row = (await t.db.query(`SELECT status, payload_enc FROM email_outbox WHERE to_email = $1 AND kind = 'verify_email'`, [email])).rows[0]!;
    expect(row).toEqual({ status: 'sent', payload_enc: null });
    const queued = await enqueueEmail(t.db, t.deps, { kind: 'reset_password', locale: 'en', to: email, data: { link: `http://x/#token=${token}` } });
    const enc = (await t.db.query('SELECT payload_enc FROM email_outbox WHERE id = $1', [queued])).rows[0]!.payload_enc as string;
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).not.toContain(token);
  });
});

describe('customer resend', () => {
  it('sends the QR again, is rate limited (3 per hour), and only for the owner', async () => {
    const { c, registration, email } = await customerWithRegistration(t);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await c.post(`/me/registrations/${registration.id}/resend-email`, {})).status);
    expect(statuses).toEqual([202, 202, 202, 429]);
    const mail = await t.waitForMail(email, 'registration_qr_resend');
    expect(mail.subject).toBe(`Your TRACED QR code – ${registration.trackingId}`);
    expect(mail.attachments![0]!.contentId).toBe('traced-qr');
    const other = await t.customer();
    expect((await other.c.post(`/me/registrations/${registration.id}/resend-email`, {})).status).toBe(404);
    const staff = await t.staff(['collection_staff']);
    expect((await staff.c.post(`/me/registrations/${registration.id}/resend-email`, {})).status).toBe(403);
    const detail = (await c.get(`/me/registrations/${registration.id}`)).body.registration;
    expect(detail.email.status).toBe('sent');
  });
});

describe('templates', () => {
  it('English and Arabic templates render for every email type and escape all values', () => {
    const data = { link: 'https://x.test/a?b=1&c=<2>', name: '<script>alert(1)</script>', trackingId: 'TRC-SA-11/26-00001', branchName: 'Branch & Co', branchCity: 'Riyadh', branchAddress: 'Street' };
    for (const name of ['verify_email', 'account_exists', 'reset_password', 'password_changed', 'account_setup', 'registration_confirmation', 'registration_qr_resend'] as const) {
      for (const locale of ['en', 'ar'] as const) {
        const r = renderTemplate(name, locale, data);
        expect(r.subject.length, `${name}/${locale}`).toBeGreaterThan(5);
        expect(r.html).toContain(locale === 'ar' ? 'dir="rtl"' : 'dir="ltr"');
        expect(r.html).not.toContain('<script>alert');
        expect(r.html).not.toContain('c=<2>');
        if (locale === 'ar') expect(r.subject).toMatch(/[؀-ۿ]/);
      }
    }
  });
});

describe('Resend transport', () => {
  const message: MailMessage = {
    to: 'person@example.com', template: 'registration_confirmation', locale: 'en', idempotencyKey: 'traced-email/abc',
    data: { name: 'Fatimah', trackingId: 'TRC-SA-11/26-00001', branchName: 'B', branchCity: 'C', branchAddress: '', link: 'https://x.test/r?id=1' },
    attachments: [{ filename: 'TRACED-TRC-SA-11-26-00001.png', contentType: 'image/png', content: Buffer.from('png'), contentId: 'traced-qr' }],
  };

  it('sends the documented request: endpoint, auth, User-Agent, Idempotency-Key, inline image', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ id: 'msg_123' }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await new ResendMailer('re_testkey', 'TRACED <no-reply@example.sa>', undefined, fake).send(message);
    expect(result).toEqual({ provider: 'resend', messageId: 'msg_123' });
    expect(captured!.url).toBe('https://api.resend.com/emails');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_testkey');
    expect(headers['Idempotency-Key']).toBe('traced-email/abc');
    expect(headers['User-Agent']).toMatch(/^traced-platform\//);
    const body = JSON.parse(captured!.init.body as string);
    expect(body).toMatchObject({ from: 'TRACED <no-reply@example.sa>', to: ['person@example.com'] });
    expect(body.attachments[0]).toEqual({ filename: 'TRACED-TRC-SA-11-26-00001.png', content: Buffer.from('png').toString('base64'), content_type: 'image/png', content_id: 'traced-qr' });
  });

  it('classifies failures: 429/5xx/network are retried, other 4xx are permanent', async () => {
    const respond = (status: number) => (async () => new Response(JSON.stringify({ name: 'x' }), { status })) as unknown as typeof fetch;
    await expect(new ResendMailer('re_k', 'a@b.c', undefined, respond(500)).send(message)).rejects.toMatchObject({ retryable: true });
    await expect(new ResendMailer('re_k', 'a@b.c', undefined, respond(429)).send(message)).rejects.toMatchObject({ retryable: true });
    await expect(new ResendMailer('re_k', 'a@b.c', undefined, respond(422)).send(message)).rejects.toMatchObject({ retryable: false });
    const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(new ResendMailer('re_k', 'a@b.c', undefined, offline).send(message)).rejects.toMatchObject({ retryable: true });
  });

  it('configuration: Resend needs a key and sender; production refuses local capture transports', () => {
    const base = { APP_ORIGIN: 'https://t.example.sa', DATABASE_URL: 'postgres://x', TOKEN_HMAC_KEY: randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
    expect(() => loadConfig({ ...base, MAIL_TRANSPORT: 'resend' })).toThrow(/RESEND_API_KEY and MAIL_FROM/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', MAIL_TRANSPORT: 'dev' })).toThrow(/must be resend/);
    expect(loadConfig({ ...base, MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_abc123', MAIL_FROM: 'TRACED <a@b.sa>' }).mailTransport).toBe('resend');
  });
});
