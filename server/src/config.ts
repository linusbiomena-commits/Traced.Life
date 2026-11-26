import type { BlockList } from 'node:net';
import { z } from 'zod';
import { parseCidrs } from './lib/client-ip.ts';

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
  // Legacy switch: true = one proxy hop (same as TRUSTED_PROXY_HOPS=1). Prefer TRUSTED_PROXY_HOPS.
  TRUST_PROXY: bool.optional(),
  // Number of reverse proxies in front of the API (Cloud Run direct = 1; Vercel → Cloud Run = 2).
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).optional(),
  // Optional: the socket peer must be inside these CIDRs before X-Forwarded-For is read.
  TRUSTED_PROXY_CIDRS: z.string().max(2000).optional(),
  // Optional: shared secret the outermost proxy sends as x-traced-proxy-auth (see lib/client-ip.ts).
  TRUSTED_PROXY_SECRET: z.string().min(32).optional(),
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
  /** Reverse proxies in front of the API; 0 = use the socket address only. */
  trustedProxyHops: number;
  trustedProxyCidrs?: BlockList | null;
  trustedProxySecret?: string;
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
    // Production must state its proxy chain explicitly; a guessed value either trusts forgeable
    // headers or puts every client into one rate-limit bucket.
    if (e.TRUSTED_PROXY_HOPS === undefined) throw new Error('TRUSTED_PROXY_HOPS must be set explicitly in production');
    if (e.TRUST_PROXY !== undefined) throw new Error('TRUST_PROXY is not supported in production; set TRUSTED_PROXY_HOPS');
  }
  if (e.TRUST_PROXY !== undefined && e.TRUSTED_PROXY_HOPS !== undefined) {
    throw new Error('Set either TRUSTED_PROXY_HOPS or the legacy TRUST_PROXY, not both');
  }
  const trustedProxyHops = e.TRUSTED_PROXY_HOPS ?? (e.TRUST_PROXY ? 1 : 0);
  if (trustedProxyHops === 0 && (e.TRUSTED_PROXY_CIDRS || e.TRUSTED_PROXY_SECRET)) {
    throw new Error('TRUSTED_PROXY_CIDRS / TRUSTED_PROXY_SECRET need TRUSTED_PROXY_HOPS >= 1');
  }
  const trustedProxyCidrs = parseCidrs(e.TRUSTED_PROXY_CIDRS);
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    appOrigin: e.APP_ORIGIN,
    databaseUrl: e.DATABASE_URL,
    tokenHmacKey: e.TOKEN_HMAC_KEY,
    dataEncryptionKey: e.DATA_ENCRYPTION_KEY,
    cookieSecure: e.COOKIE_SECURE,
    trustedProxyHops,
    trustedProxyCidrs,
    trustedProxySecret: e.TRUSTED_PROXY_SECRET,
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
