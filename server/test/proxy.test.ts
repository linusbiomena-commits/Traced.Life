import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { parseCidrs, resolveClientIp } from '../src/lib/client-ip.ts';
import { GOOD_PASSWORD, ORIGIN, setupTestApp, type TestEnv } from './helpers/test-app.ts';

const SECRET = 'proxy-secret-0123456789abcdef0123456789';

describe('client IP resolution (X-Forwarded-For)', () => {
  it('never trusts the client-written (leftmost) entries', () => {
    // Cloud Run direct: one proxy appends the address it saw.
    expect(resolveClientIp({ forwardedFor: '6.6.6.6, 203.0.113.7', peer: '169.254.1.1' }, { hops: 1 })).toBe('203.0.113.7');
    expect(resolveClientIp({ forwardedFor: '1.1.1.1, 2.2.2.2, 6.6.6.6, 203.0.113.7', peer: '169.254.1.1' }, { hops: 1 })).toBe('203.0.113.7');
    // Vercel → Cloud Run: Vercel writes the client, Cloud Run appends Vercel's egress address.
    expect(resolveClientIp({ forwardedFor: '6.6.6.6, 203.0.113.7, 76.76.21.1', peer: '169.254.1.1' }, { hops: 2 })).toBe('203.0.113.7');
  });

  it('ignores the header entirely with zero hops (direct connections)', () => {
    expect(resolveClientIp({ forwardedFor: '6.6.6.6', peer: '::ffff:192.0.2.5' }, { hops: 0 })).toBe('192.0.2.5');
  });

  it('falls back to an address written by a trusted hop, never to client input', () => {
    // Chain shorter than configured: use the farthest proxy-written address.
    expect(resolveClientIp({ forwardedFor: '203.0.113.7', peer: '10.0.0.1' }, { hops: 2 })).toBe('203.0.113.7');
    expect(resolveClientIp({ forwardedFor: '', peer: '10.0.0.1' }, { hops: 1 })).toBe('10.0.0.1');
    expect(resolveClientIp({ forwardedFor: undefined, peer: null }, { hops: 1 })).toBeNull();
    // Garbage in the selected slot: use the proxy's own address (one strict shared bucket).
    expect(resolveClientIp({ forwardedFor: 'not-an-ip', peer: '10.0.0.1' }, { hops: 1 })).toBe('10.0.0.1');
    expect(resolveClientIp({ forwardedFor: '203.0.113.7, <script>', peer: '10.0.0.1' }, { hops: 2 })).toBe('10.0.0.1');
  });

  it('normalises ports, brackets and IPv4-mapped IPv6', () => {
    expect(resolveClientIp({ forwardedFor: '203.0.113.7:51234', peer: '10.0.0.1' }, { hops: 1 })).toBe('203.0.113.7');
    expect(resolveClientIp({ forwardedFor: '[2001:DB8::1]:443', peer: '10.0.0.1' }, { hops: 1 })).toBe('2001:db8::1');
    expect(resolveClientIp({ forwardedFor: '::ffff:203.0.113.7', peer: '10.0.0.1' }, { hops: 1 })).toBe('203.0.113.7');
  });

  it('validates the chain: untrusted socket peers cannot supply forwarding headers', () => {
    const trustedPeers = parseCidrs('10.0.0.0/8, 2001:db8::/32');
    expect(resolveClientIp({ forwardedFor: '6.6.6.6', peer: '198.51.100.9' }, { hops: 1, trustedPeers })).toBe('198.51.100.9');
    expect(resolveClientIp({ forwardedFor: '203.0.113.7', peer: '10.2.3.4' }, { hops: 1, trustedPeers })).toBe('203.0.113.7');
    expect(() => parseCidrs('10.0.0.0/33')).toThrow(/invalid prefix/);
    expect(() => parseCidrs('nope')).toThrow(/invalid address/);
  });

  it('validates the chain: a request that bypassed the outer proxy loses that hop', () => {
    // Attacker calls the Cloud Run URL directly with a forged entry: only Cloud Run's own append counts.
    const forged = { forwardedFor: '6.6.6.6, 203.0.113.7', peer: '169.254.1.1' };
    expect(resolveClientIp(forged, { hops: 2, proxySecret: SECRET })).toBe('203.0.113.7');
    expect(resolveClientIp({ ...forged, proxyAuth: 'wrong' }, { hops: 2, proxySecret: SECRET })).toBe('203.0.113.7');
    // Through Vercel (which presents the secret): client = Vercel's entry.
    expect(resolveClientIp({ forwardedFor: '6.6.6.6, 203.0.113.7, 76.76.21.1', peer: '169.254.1.1', proxyAuth: SECRET }, { hops: 2, proxySecret: SECRET })).toBe('203.0.113.7');
  });

  it('bounds work on very long headers', () => {
    const long = `${'9.9.9.9, '.repeat(5000)}203.0.113.7`;
    // Only the right-hand 2 KB are parsed, which keeps the entries trusted proxies appended.
    expect(resolveClientIp({ forwardedFor: long, peer: '10.0.0.1' }, { hops: 1 })).toBe('203.0.113.7');
    expect(resolveClientIp({ forwardedFor: `${long}, 76.76.21.1`, peer: '10.0.0.1' }, { hops: 2 })).toBe('203.0.113.7');
  });
});

describe('proxy configuration', () => {
  const base = { APP_ORIGIN: 'https://t.example.sa', DATABASE_URL: 'postgres://x', TOKEN_HMAC_KEY: randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
  const prod = { ...base, NODE_ENV: 'production', MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_abc', MAIL_FROM: 'a@b.sa' };

  it('defaults to trusting no forwarding header outside production', () => {
    expect(loadConfig(base).trustedProxyHops).toBe(0);
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).trustedProxyHops).toBe(1); // legacy switch = rightmost entry
    expect(loadConfig({ ...base, TRUST_PROXY: 'false' }).trustedProxyHops).toBe(0);
  });

  it('production must state the proxy chain explicitly and cannot use the legacy switch', () => {
    expect(() => loadConfig(prod)).toThrow(/TRUSTED_PROXY_HOPS must be set explicitly/);
    expect(() => loadConfig({ ...prod, TRUST_PROXY: 'true' })).toThrow(/TRUSTED_PROXY_HOPS must be set|not supported in production/);
    expect(() => loadConfig({ ...prod, TRUSTED_PROXY_HOPS: '2', TRUST_PROXY: 'true' })).toThrow(/not supported in production/);
    const c = loadConfig({ ...prod, TRUSTED_PROXY_HOPS: '2', TRUSTED_PROXY_SECRET: SECRET });
    expect(c.trustedProxyHops).toBe(2);
    expect(c.trustedProxySecret).toBe(SECRET);
  });

  it('rejects contradictory or unsafe settings', () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'true', TRUSTED_PROXY_HOPS: '1' })).toThrow(/not both/);
    expect(() => loadConfig({ ...base, TRUSTED_PROXY_HOPS: '6' })).toThrow();
    expect(() => loadConfig({ ...base, TRUSTED_PROXY_SECRET: SECRET })).toThrow(/need TRUSTED_PROXY_HOPS/);
    expect(() => loadConfig({ ...base, TRUSTED_PROXY_HOPS: '1', TRUSTED_PROXY_SECRET: 'short' })).toThrow();
    expect(() => loadConfig({ ...base, TRUSTED_PROXY_HOPS: '1', TRUSTED_PROXY_CIDRS: '10.0.0.0/99' })).toThrow(/invalid prefix/);
  });
});

describe('rate limits cannot be bypassed by forging X-Forwarded-For', () => {
  let t: TestEnv;
  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(async () => t.close());

  const signUp = (app: ReturnType<typeof createApp>, xff: string, i: number) =>
    app.request('/api/v1/auth/sign-up', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'x-forwarded-for': xff },
      body: JSON.stringify({ email: `spoof_${i}_${randomBytes(3).toString('hex')}@example.com`, password: GOOD_PASSWORD, confirmAdult: true }),
    });

  it('a different forged leftmost address on every request still hits the per-IP sign-up limit', async () => {
    // The harness is one trusted proxy (hops = 1) that appended 203.0.113.250 for this client.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await signUp(t.app, `100.64.${i}.${i + 1}, 203.0.113.250`, i)).status);
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses[10]).toBe(429);
    const { rows } = await t.db.query(`SELECT key FROM rate_limits WHERE key LIKE 'signup:ip:%'`);
    expect(rows.map((r) => r.key)).toContain('signup:ip:203.0.113.250');
    expect(rows.some((r) => r.key.startsWith('signup:ip:100.64.'))).toBe(false);
  });

  it('with zero trusted hops the header is ignored completely', async () => {
    const app = createApp({ ...t.deps, config: { ...t.config, trustedProxyHops: 0 } });
    const res = await signUp(app, '100.64.200.1', 99);
    expect(res.status).toBe(202);
    const { rows } = await t.db.query(`SELECT key FROM rate_limits WHERE key = 'signup:ip:100.64.200.1'`);
    expect(rows).toHaveLength(0);
  });
});
