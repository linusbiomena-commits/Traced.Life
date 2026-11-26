import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { createApp } from '../../src/app.ts';
import type { Config } from '../../src/config.ts';
import type { Deps } from '../../src/context.ts';
import { createPool, type Pool } from '../../src/db/pool.ts';
import { createStaffAccount } from '../../src/modules/accounts/accounts.service.ts';
import { matchTotp } from '../../src/modules/auth/mfa.ts';
import { seedDevData } from '../../src/modules/dev/seed.ts';
import { MemoryMailer } from '../../src/modules/mail/mailer.ts';
import { kickOutbox, processOutbox } from '../../src/modules/mail/outbox.ts';
import { flushBackgroundMail } from '../../src/modules/mail/send.ts';
import type { RoleKey } from '../../src/modules/rbac/catalogue.ts';
import { TOTP, Secret } from 'otpauth';

export const ORIGIN = 'http://localhost:8787';
export const GOOD_PASSWORD = 'correct horse battery staple';

type Res = { status: number; body: any; headers: Headers };

/** Browser-like client: keeps the session cookie and CSRF token, sends our Origin by default. */
export class TestClient {
  cookie: string | null = null;
  csrf: string | null = null;

  constructor(
    private readonly app: ReturnType<typeof createApp>,
    public ip = '203.0.113.10',
  ) {}

  async request(method: string, path: string, body?: unknown, opts: { headers?: Record<string, string>; csrf?: boolean; raw?: string } = {}): Promise<Res> {
    const headers: Record<string, string> = { origin: ORIGIN, 'x-forwarded-for': this.ip, 'user-agent': 'vitest' };
    if (body !== undefined || opts.raw !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.csrf && opts.csrf !== false) headers['x-csrf-token'] = this.csrf;
    Object.assign(headers, opts.headers);
    for (const [k, v] of Object.entries(headers)) if (v === '') delete headers[k];

    const res = await this.app.request(`/api/v1${path}`, {
      method,
      headers,
      body: opts.raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const [pair] = setCookie.split(';');
      const [name, value] = pair!.split('=');
      this.cookie = value && !/max-age=0/i.test(setCookie) ? `${name}=${value}` : null;
      if (!this.cookie) this.csrf = null;
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    if (json && typeof json === 'object' && typeof json.csrfToken === 'string') this.csrf = json.csrfToken;
    return { status: res.status, body: json, headers: res.headers };
  }

  get(path: string, opts?: { headers?: Record<string, string> }) {
    return this.request('GET', path, undefined, opts);
  }
  post(path: string, body?: unknown, opts?: { headers?: Record<string, string>; csrf?: boolean; raw?: string }) {
    return this.request('POST', path, body ?? {}, opts);
  }
  put(path: string, body?: unknown) {
    return this.request('PUT', path, body ?? {});
  }
  patch(path: string, body?: unknown) {
    return this.request('PATCH', path, body ?? {});
  }
}

export type TestEnv = Awaited<ReturnType<typeof setupTestApp>>;

/** A fresh database (cloned from the migrated template) and app instance per test file. */
export async function setupTestApp() {
  const base = inject('pgBaseUrl');
  const dbName = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.query(`CREATE DATABASE ${dbName} TEMPLATE traced_template`);
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
    }
  }
  await admin.end();

  const db: Pool = createPool(`${base}/${dbName}`, 20);
  await seedDevData(db, 'test');
  const config: Config = {
    env: 'test',
    port: 0,
    appOrigin: ORIGIN,
    databaseUrl: `${base}/${dbName}`,
    tokenHmacKey: randomBytes(32),
    dataEncryptionKey: randomBytes(32),
    cookieSecure: false,
    // Tests act as the one trusted proxy and send each client's address as X-Forwarded-For.
    trustedProxyHops: 1,
    mailTransport: 'memory',
    mailDevDir: '',
    serveStatic: false,
    devIdentityVerification: true,
    internalCronSecret: 'test-cron-secret-0123456789abcdef0123456789',
    customerStatusEmails: true, // Phase 6 status emails are exercised in tests
  };
  const mailer = new MemoryMailer();
  const deps: Deps = { config, db, mailer };
  const app = createApp(deps);

  let ipCounter = 0;
  const client = (ip?: string) => new TestClient(app, ip ?? `198.51.100.${(ipCounter++ % 250) + 1}`);

  /** Finishes every background enqueue and delivers everything due (deterministic for tests). */
  const settleMail = async () => {
    await flushBackgroundMail();
    await kickOutbox(deps);
    await processOutbox(deps);
  };

  /** Newest delivered email of a kind to an address, after all pending email has been processed. */
  const waitForMail = async (to: string, template: string) => {
    await settleMail();
    const mail = mailer.lastTo(to, template as never);
    if (!mail) throw new Error(`no ${template} email delivered to ${to}`);
    return mail;
  };

  /** Token from the most recent email of a given kind to an address. */
  const tokenFromMail = async (to: string, template: string): Promise<string> => {
    const mail = await waitForMail(to, template);
    const token = mail.data.link?.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
    if (!token) throw new Error(`no ${template} token mailed to ${to}`);
    return token;
  };

  /** Signs up, verifies email and signs in a customer. */
  const customer = async (email = `cust_${randomBytes(4).toString('hex')}@example.com`) => {
    const c = client();
    const up = await c.post('/auth/sign-up', { confirmAdult: true, email, password: GOOD_PASSWORD });
    if (up.status !== 202) throw new Error(`sign-up failed: ${JSON.stringify(up.body)}`);
    await c.post('/auth/verify-email', { token: await tokenFromMail(email, 'verify_email') });
    const signIn = await c.post('/auth/sign-in', { email, password: GOOD_PASSWORD });
    if (signIn.status !== 200) throw new Error(`sign-in failed: ${JSON.stringify(signIn.body)}`);
    return { c, email, userId: signIn.body.user.id as string };
  };

  /** Creates a staff-side account, sets its password and signs in (MFA not yet done). */
  const staff = async (roles: RoleKey[], email = `staff_${randomBytes(4).toString('hex')}@example.com`) => {
    const { userId, setupLink } = await createStaffAccount(deps, {
      email, roles, locale: 'en',
      meta: { actorUserId: null, actorRole: 'system_cli', ip: null, userAgent: null, requestId: null },
    });
    const token = setupLink.match(/#token=([A-Za-z0-9_-]+)/)![1]!;
    const c = client();
    const setup = await c.post('/auth/account-setup', { token, password: GOOD_PASSWORD });
    if (setup.status !== 200) throw new Error(`setup failed: ${JSON.stringify(setup.body)}`);
    const signIn = await c.post('/auth/sign-in', { email, password: GOOD_PASSWORD });
    if (signIn.status !== 200) throw new Error(`staff sign-in failed: ${JSON.stringify(signIn.body)}`);
    return { c, email, userId };
  };

  /** Staff account with MFA enrolled and verified in its session. Returns the TOTP secret. */
  const mfaStaff = async (roles: RoleKey[]) => {
    const s = await staff(roles);
    const setup = await s.c.post('/auth/mfa/setup');
    const secret: string = setup.body.secret;
    const enable = await s.c.post('/auth/mfa/enable', { code: totpCode(secret) });
    if (enable.status !== 200) throw new Error(`mfa enable failed: ${JSON.stringify(enable.body)}`);
    return { ...s, secret, recoveryCodes: enable.body.recoveryCodes as string[] };
  };

  const close = async () => {
    await db.end();
    const a = new pg.Client({ connectionString: `${base}/postgres` });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await a.end();
  };

  return { app, db, mailer, config, deps, client, tokenFromMail, waitForMail, settleMail, customer, staff, mfaStaff, close };
}

/** Current TOTP code, optionally offset by whole 30-second steps. */
export function totpCode(secretBase32: string, stepOffset = 0): string {
  const totp = new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secretBase32) });
  const code = totp.generate({ timestamp: Date.now() + stepOffset * 30_000 });
  if (matchTotp(secretBase32, code) === null && stepOffset === 0) throw new Error('totp self-check failed');
  return code;
}
