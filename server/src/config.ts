import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const key32 = (name: string) =>
  z
    .string({ error: `${name} is required (run: npm run gen-keys)` })
    .transform((v) => Buffer.from(v, 'base64'))
    .refine((b) => b.length === 32, `${name} must be 32 bytes, base64-encoded (run: npm run gen-keys)`);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  APP_ORIGIN: z.url().transform((u) => new URL(u).origin),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TOKEN_HMAC_KEY: key32('TOKEN_HMAC_KEY'),
  DATA_ENCRYPTION_KEY: key32('DATA_ENCRYPTION_KEY'),
  COOKIE_SECURE: bool.default(true),
  TRUST_PROXY: bool.default(false),
  MAIL_TRANSPORT: z.enum(['dev', 'memory', 'resend']).default('dev'),
  MAIL_DEV_DIR: z.string().default('.dev-mail'),
  MAIL_FROM: z.string().max(200).optional(),
  MAIL_REPLY_TO: z.email().optional(),
  RESEND_API_KEY: z.string().regex(/^re_[A-Za-z0-9_]+$/, 'RESEND_API_KEY looks invalid').optional(),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().min(1000).default(15000),
  // Development/test only: lets staff simulate identity-verification outcomes. Refused in production.
  DEV_IDENTITY_VERIFICATION: bool.default(false),
  // Cloud Run: keep the per-instance pool small (Cloud SQL f1-micro allows few connections).
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  // Shared secret for the scheduled outbox run (Cloud Scheduler → /api/v1/internal/outbox/run).
  INTERNAL_CRON_SECRET: z.string().min(32).optional(),
  SERVE_STATIC: bool.default(false),
});

export type Config = {
  env: 'development' | 'test' | 'production';
  port: number;
  appOrigin: string;
  databaseUrl: string;
  tokenHmacKey: Buffer;
  dataEncryptionKey: Buffer;
  cookieSecure: boolean;
  trustProxy: boolean;
  mailTransport: 'dev' | 'memory' | 'resend';
  mailDevDir: string;
  mailFrom?: string;
  mailReplyTo?: string;
  resendApiKey?: string;
  outboxIntervalMs?: number;
  devIdentityVerification?: boolean;
  dbPoolMax?: number;
  internalCronSecret?: string;
  serveStatic: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const e = parsed.data;
  if (e.MAIL_TRANSPORT === 'resend' && (!e.RESEND_API_KEY || !e.MAIL_FROM)) {
    throw new Error('MAIL_TRANSPORT=resend requires RESEND_API_KEY and MAIL_FROM');
  }
  if (e.NODE_ENV === 'production') {
    if (!e.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
    if (!e.APP_ORIGIN.startsWith('https://')) throw new Error('APP_ORIGIN must be https in production');
    // Production must use a real provider; local capture transports are refused.
    if (e.MAIL_TRANSPORT !== 'resend') throw new Error('MAIL_TRANSPORT must be resend in production');
    if (e.SERVE_STATIC) throw new Error('SERVE_STATIC is for local development only');
    if (e.DEV_IDENTITY_VERIFICATION) throw new Error('DEV_IDENTITY_VERIFICATION must never be enabled in production');
  }
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    appOrigin: e.APP_ORIGIN,
    databaseUrl: e.DATABASE_URL,
    tokenHmacKey: e.TOKEN_HMAC_KEY,
    dataEncryptionKey: e.DATA_ENCRYPTION_KEY,
    cookieSecure: e.COOKIE_SECURE,
    trustProxy: e.TRUST_PROXY,
    mailTransport: e.MAIL_TRANSPORT,
    mailDevDir: e.MAIL_DEV_DIR,
    mailFrom: e.MAIL_FROM,
    mailReplyTo: e.MAIL_REPLY_TO,
    resendApiKey: e.RESEND_API_KEY,
    outboxIntervalMs: e.OUTBOX_INTERVAL_MS,
    devIdentityVerification: e.NODE_ENV !== 'production' && e.DEV_IDENTITY_VERIFICATION,
    dbPoolMax: e.DB_POOL_MAX,
    internalCronSecret: e.INTERNAL_CRON_SECRET,
    serveStatic: e.SERVE_STATIC,
  };
}
