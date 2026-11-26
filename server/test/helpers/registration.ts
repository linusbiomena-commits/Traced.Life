import { randomUUID } from 'node:crypto';
import jsQRModule from 'jsqr';
import { PNG } from 'pngjs';
import { riyadhToday } from '../../src/modules/registrations/rules.ts';
import type { TestClient, TestEnv } from './test-app.ts';

export function yearsAgo(years: number, extraDays = 0): string {
  const [y, m, d] = riyadhToday().split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y - years, m - 1, d - extraDays)).toISOString().slice(0, 10);
}

/** A valid registration body for the given relationship (defaults: a 7-year-old child). */
export async function registrationBody(c: TestClient, overrides: Record<string, unknown> = {}) {
  const f = (await c.get('/me/registration-form?locale=en')).body as { branches: { id: string }[]; consents: { id: string; type: string }[] };
  const relationship = (overrides.relationship as string) ?? 'child';
  const types = relationship === 'self'
    ? ['privacy_policy', 'sample_collection_consent', 'accuracy_declaration']
    : ['privacy_policy', 'sample_collection_consent', 'accuracy_declaration', 'guardian_authorization'];
  return {
    relationship,
    patient: { firstName: 'Layla', lastName: 'Al-Harbi', dateOfBirth: yearsAgo(7, 40), gender: 'female' },
    contact: { fullName: 'Fatimah Al-Harbi', phone: '0551234567' },
    branchId: f.branches[0]!.id,
    consentDocumentIds: f.consents.filter((d) => types.includes(d.type)).map((d) => d.id),
    ...overrides,
  };
}

export async function register(c: TestClient, overrides: Record<string, unknown> = {}, key: string = randomUUID()) {
  return c.post('/me/registrations', await registrationBody(c, overrides), { headers: { 'idempotency-key': key } });
}

/** Creates a verified customer with one registration; returns everything a test needs. */
export async function customerWithRegistration(t: TestEnv, overrides: Record<string, unknown> = {}) {
  const cust = await t.customer();
  const res = await register(cust.c, overrides);
  if (res.status !== 201) throw new Error(`registration failed: ${JSON.stringify(res.body)}`);
  return { ...cust, registration: res.body.registration };
}

/** Decodes a QR code from a PNG buffer. */
// jsqr is CommonJS; under NodeNext its default export arrives as the module object.
type JsQr = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const jsQR: JsQr = ((jsQRModule as unknown as { default?: JsQr }).default ?? (jsQRModule as unknown as JsQr));

export function decodeQrPng(buf: Buffer): string | null {
  const png = PNG.sync.read(buf);
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
}

/** Raw binary response (for image downloads) using the client's cookie. */
export async function getBinary(t: TestEnv, c: TestClient, path: string) {
  const res = await t.app.request(`/api/v1${path}`, { headers: c.cookie ? { cookie: c.cookie, origin: 'http://localhost:8787' } : {} });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

export async function assignBranch(t: TestEnv, userId: string, branchId: string) {
  await t.db.query('INSERT INTO staff_branch_assignments (user_id, branch_id) VALUES ($1, $2)', [userId, branchId]);
}
