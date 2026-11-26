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
  MAIL_TRANSPORT: z.enum(['dev', 'memory']).default('dev'),
  MAIL_DEV_DIR: z.string().default('.dev-mail'),
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
  mailTransport: 'dev' | 'memory';
  mailDevDir: string;
  serveStatic: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const e = parsed.data;
  if (e.NODE_ENV === 'production') {
    if (!e.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
    if (!e.APP_ORIGIN.startsWith('https://')) throw new Error('APP_ORIGIN must be https in production');
    // No real email provider exists until Phase 3, so production cannot start yet by design.
    if (e.MAIL_TRANSPORT === 'dev' || e.MAIL_TRANSPORT === 'memory') {
      throw new Error('A production email transport is required (added in Phase 3)');
    }
    if (e.SERVE_STATIC) throw new Error('SERVE_STATIC is for local development only');
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
    serveStatic: e.SERVE_STATIC,
  };
}
