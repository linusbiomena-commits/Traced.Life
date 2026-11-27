// TRACED deployed end-to-end journey against the RESTRICTED PREVIEW API (database traced_preview only).
// Runs inside a container on the server (deploy/oci/vm/vm_13_e2e.sh). Synthetic accounts only, at the
// captured domain @preview.tracedmena.test (emails are written to files, never sent). Prints no secrets.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes } from 'node:crypto';

const BASE = process.env.BASE;            // http://traced-api:8080/api/v1
const ORIGIN = process.env.ORIGIN;        // the preview origin (APP_ORIGIN)
const MAILDIR = process.env.MAILDIR;      // captured mail folder (read-only)
const RUN = process.env.RUN_ID;           // unique per run
const DOMAIN = 'preview.tracedmena.test';
const req = createRequire('/tmp/q/');
const jsQR = req('jsqr'); const { PNG } = req('pngjs');
const OTPAuth = createRequire('/app/')('otpauth');

const results = [];
const ok = (name, cond, detail = '') => { results.push({ name, pass: !!cond, detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const pw = () => `${randomBytes(18).toString('base64url')}Aa1!`;
const email = (who) => `${who}-${RUN}@${DOMAIN}`;
const totp = (secret) => new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date());
const dob = (years) => { const [y, m, d] = today.split('-').map(Number); return new Date(Date.UTC(y - years, m - 1, d - 40)).toISOString().slice(0, 10); };

class Client {
  cookie = null; csrf = null;
  async req(method, path, body, headers = {}) {
    const h = { origin: ORIGIN, 'x-forwarded-for': '203.0.113.10', ...headers };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf && method !== 'GET') h['x-csrf-token'] = this.csrf;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = res.headers.getSetCookie?.() ?? [];
    for (const c of sc) { const v = c.split(';')[0]; if (/=$/.test(v) || /Max-Age=0/i.test(c)) this.cookie = null; else this.cookie = v; }
    const type = res.headers.get('content-type') ?? '';
    const out = { status: res.status, headers: res.headers };
    if (type.includes('json')) { out.body = await res.json(); if (typeof out.body?.csrfToken === 'string') this.csrf = out.body.csrfToken; }
    else out.buf = Buffer.from(await res.arrayBuffer());
    return out;
  }
  get(p, h) { return this.req('GET', p, undefined, h); }
  post(p, b, h) { return this.req('POST', p, b ?? {}, h); }
  put(p, b) { return this.req('PUT', p, b ?? {}); }
}

async function mail(to, template, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const files = readdirSync(MAILDIR).filter((f) => f.endsWith('.txt') && f.includes(`-${template}-`)).sort().reverse();
    for (const f of files) {
      const t = readFileSync(`${MAILDIR}/${f}`, 'utf8');
      if (t.startsWith(`To: ${to}\n`)) return { text: t, subject: t.split('\n')[1].replace(/^Subject: /, ''), token: t.match(/#token=([A-Za-z0-9_-]+)/)?.[1] ?? null };
    }
    await sleep(1000);
  }
  throw new Error(`no ${template} email for ${to}`);
}
const qrText = (buf) => { const png = PNG.sync.read(buf); return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null; };

async function staffFromInvite(addr, mfa) {
  const c = new Client(); const password = pw();
  const m = await mail(addr, 'account_setup');
  ok(`invitation email received (${addr.split('-')[0]})`, !!m.token);
  ok(`account setup (${addr.split('-')[0]})`, (await c.post('/auth/account-setup', { token: m.token, password })).status === 200);
  const s = await c.post('/auth/sign-in', { email: addr, password });
  ok(`sign-in (${addr.split('-')[0]})`, s.status === 200, `status ${s.status}`);
  let secret = null;
  if (mfa) {
    const setup = await c.post('/auth/mfa/setup'); secret = setup.body?.secret;
    const en = await c.post('/auth/mfa/enable', { code: totp(secret) });
    ok(`two-step verification enrolled (${addr.split('-')[0]})`, en.status === 200 && Array.isArray(en.body?.recoveryCodes));
  }
  return { c, secret, password, addr };
}

async function main() {
  const anon = new Client();
  ok('health', (await anon.get('/health')).status === 200);
  ok('unauthenticated /auth/me is refused', (await anon.get('/auth/me')).status === 401);

  // 1. Super administrator (invited with the CLI by the wrapper script), MFA enforced.
  const sa = await staffFromInvite(email('superadmin'), true);
  const branches = (await sa.c.get('/admin/branches')).body?.items ?? [];
  const ruh = branches.find((b) => b.code === 'DEV-RUH-01');
  ok('admin sees seeded synthetic branches', !!ruh, `${branches.length} branches`);

  // 2. Admin invites collection staff, laboratory operator and auditor.
  for (const [who, roles, extra] of [['collector', ['collection_staff'], { branchIds: [ruh.id] }], ['lab', ['lab_operator'], {}], ['auditor', ['auditor'], {}]]) {
    const r = await sa.c.post('/admin/staff', { email: email(who), fullName: `Preview ${who}`, roles, ...extra });
    ok(`admin invites ${who}`, r.status === 201 || r.status === 200, `status ${r.status}`);
  }
  const staff = await staffFromInvite(email('collector'), false);
  const lab = await staffFromInvite(email('lab'), true);
  const auditor = await staffFromInvite(email('auditor'), true);

  // 3. Customer sign-up, email verification, sign-in.
  const cust = new Client(); const custPw = pw(); const custEmail = email('customer');
  ok('customer sign-up', (await cust.post('/auth/sign-up', { email: custEmail, password: custPw, locale: 'en', confirmAdult: true })).status === 202);
  const v = await mail(custEmail, 'verify_email');
  ok('verification email has a link', !!v.token);
  ok('email verified', (await cust.post('/auth/verify-email', { token: v.token })).status === 200);
  ok('customer sign-in', (await cust.post('/auth/sign-in', { email: custEmail, password: custPw })).status === 200);

  // 4. Registration (child) and QR.
  const form = (await cust.get('/me/registration-form?locale=en')).body;
  const consentIds = (form?.consents ?? []).map((d) => d.id);
  const regBody = (relationship) => ({ relationship, patient: { firstName: 'Preview', lastName: 'Child', dateOfBirth: dob(7), gender: 'female' },
    contact: { fullName: 'Preview Parent', phone: '0551234567' }, branchId: ruh.id, consentDocumentIds: consentIds });
  const reg = await cust.post('/me/registrations', regBody('child'), { 'idempotency-key': randomUUID() });
  ok('patient registration created', reg.status === 201, `status ${reg.status}${reg.body?.error ? ' ' + reg.body.error.code : ''}`);
  const regId = reg.body?.registration?.id;
  const qr1 = await cust.get(`/me/registrations/${regId}/qr.png`);
  const code1 = qrText(qr1.buf);
  ok('customer QR code generated and decodable', qr1.status === 200 && !!code1);

  // 5. Collection staff: scan, development identity check (PREVIEW ONLY), collect, label.
  const val = await staff.c.post('/staff/qr/validate', { code: code1, branchId: ruh.id });
  ok('staff QR validation', val.status === 200 && val.body?.qrValid === true);
  ok('staff see age and gender only (no name)', val.body && !JSON.stringify(val.body).includes('Preview Child'));
  const ready = (await staff.c.post(`/staff/collection-sessions/${val.body.collectionSessionId}/identity/dev`, { outcome: 'verified' })).body;
  const instr = ready?.collectionInstructions;
  const col = await staff.c.post(`/staff/collection-sessions/${val.body.collectionSessionId}/collect`, { instructionsId: instr?.id, checklist: (instr?.checklist ?? []).map((i) => i.id) });
  ok('sample collected', col.status === 200, `status ${col.status}`);
  const sampleId = col.body?.collection?.sample?.id;
  ok('physical sample label printed', (await staff.c.post(`/staff/samples/${sampleId}/label-print`, { size: '50x30' })).status === 200);
  const scode = qrText((await staff.c.get(`/staff/samples/${sampleId}/qr.png`)).buf);
  ok('sample label QR decodable', !!scode);
  const act = (c, side, code, action, expectedStatus, extra = {}) => c.post(`/${side}/samples/action`, { code, action, expectedStatus, idempotencyKey: randomUUID(), ...extra });

  // 6. Chain of custody and laboratory.
  ok('packaged', (await act(staff.c, 'staff', scode, 'package', 'collected')).status === 200);
  ok('ready for dispatch', (await act(staff.c, 'staff', scode, 'ready_for_dispatch', 'packaged')).status === 200);
  ok('courier dispatch', (await act(staff.c, 'staff', scode, 'dispatch', 'ready_for_dispatch', { courier: 'SMSA Express', shipmentTrackingNumber: `PREVIEW-${RUN}` })).status === 200);
  ok('laboratory receipt', (await act(lab.c, 'lab', scode, 'receive', 'dispatched', { condition: 'intact' })).status === 200);
  ok('analysis started', (await act(lab.c, 'lab', scode, 'start_analysis', 'received_by_laboratory')).status === 200);
  ok('analysis completed', (await act(lab.c, 'lab', scode, 'complete_analysis', 'analysis_in_progress')).status === 200);
  ok('report availability status set (status only)', (await act(lab.c, 'lab', scode, 'report_available', 'analysis_completed', { reportDeliveryConfirmed: true })).body?.status === 'report_available');
  const custView = await cust.get(`/me/registrations/${regId}`);
  ok('customer sees progress', custView.status === 200 && JSON.stringify(custView.body).includes('report_available'));

  // 7. Rejection and admin-authorised recollection.
  const reg2 = await cust.post('/me/registrations', regBody('child'), { 'idempotency-key': randomUUID() });
  const reg2Id = reg2.body?.registration?.id;
  const c2 = qrText((await cust.get(`/me/registrations/${reg2Id}/qr.png`)).buf);
  const v2 = (await staff.c.post('/staff/qr/validate', { code: c2, branchId: ruh.id })).body;
  const r2 = (await staff.c.post(`/staff/collection-sessions/${v2.collectionSessionId}/identity/dev`, { outcome: 'verified' })).body;
  const col2 = await staff.c.post(`/staff/collection-sessions/${v2.collectionSessionId}/collect`, { instructionsId: r2.collectionInstructions.id, checklist: r2.collectionInstructions.checklist.map((i) => i.id) });
  const s2 = col2.body.collection.sample.id; const sc2 = qrText((await staff.c.get(`/staff/samples/${s2}/qr.png`)).buf);
  await act(staff.c, 'staff', sc2, 'package', 'collected'); await act(staff.c, 'staff', sc2, 'ready_for_dispatch', 'packaged');
  await act(staff.c, 'staff', sc2, 'dispatch', 'ready_for_dispatch', { courier: 'SMSA Express', shipmentTrackingNumber: `PREVIEW2-${RUN}` });
  const rej = await act(lab.c, 'lab', sc2, 'reject', 'dispatched', { reasonCategory: 'damaged_packaging', condition: 'damaged', remarks: 'Preview test: tube cracked' });
  ok('laboratory rejection', rej.status === 200 && rej.body?.status === 'rejected');
  ok('recollection refused for laboratory role', (await lab.c.post(`/admin/registrations/${reg2Id}/recollection`, { reason: 'x' })).status === 403);
  ok('admin authorises recollection', (await sa.c.post(`/admin/registrations/${reg2Id}/recollection`, { reason: 'Preview test: packaging damaged; recollect' })).status === 200);
  const c2new = qrText((await cust.get(`/me/registrations/${reg2Id}/qr.png`)).buf);
  ok('new QR issued after recollection', !!c2new && c2new !== c2);
  const v3 = (await staff.c.post('/staff/qr/validate', { code: c2new, branchId: ruh.id })).body;
  const r3 = (await staff.c.post(`/staff/collection-sessions/${v3.collectionSessionId}/identity/dev`, { outcome: 'verified' })).body;
  const col3 = await staff.c.post(`/staff/collection-sessions/${v3.collectionSessionId}/collect`, { instructionsId: r3.collectionInstructions.id, checklist: r3.collectionInstructions.checklist.map((i) => i.id) });
  ok('recollected sample gets the -S02 suffix', col3.status === 200 && /-S02$/.test(col3.body?.collection?.sample?.sampleId ?? ''), col3.body?.collection?.sample?.sampleId ?? '');

  // 8. Admin, auditor, audit integrity, personal-data export, MFA reset.
  ok('admin registrations list', (await sa.c.get('/admin/registrations')).status === 200);
  ok('admin audit log', (await sa.c.get('/admin/audit-logs')).status === 200);
  ok('operational CSV report', (await sa.c.get('/admin/reports/operational.csv')).status === 200);
  ok('audit checkpoint signed', (await sa.c.post('/admin/audit-integrity/checkpoint', {})).status === 200);
  const ver = await sa.c.post('/admin/audit-integrity/verify', {});
  ok('audit integrity verifies', ver.body?.outcome === 'ok', JSON.stringify(ver.body?.findings ?? []));
  ok('auditor can read the audit log', (await auditor.c.get('/admin/audit-logs')).status === 200);
  ok('auditor cannot invite staff', (await auditor.c.post('/admin/staff', { email: email('nope'), fullName: 'No', roles: ['collection_staff'] })).status === 403);
  await sleep(31000); // fresh TOTP step for the export
  const exp = await sa.c.post('/admin/exports/personal-data', { from: today, to: today, reason: 'Preview end-to-end test of the export function', code: totp(sa.secret), fields: ['patient_name', 'contact_phone'] });
  ok('personal-data export (fresh code, reason, CSV, no-store)', exp.status === 200 && (exp.headers.get('cache-control') ?? '').includes('no-store'));
  ok('super admin resets lab MFA', (await sa.c.post(`/admin/staff/${(await sa.c.get('/admin/staff')).body?.items?.find((s) => s.email === lab.addr)?.id}/mfa-reset`, { reason: 'Preview test: lost phone, identity confirmed' })).status === 200);

  // 9. Unauthorised access.
  ok('customer cannot use the admin API', (await cust.get('/admin/registrations')).status === 403);
  ok('collection staff cannot use the laboratory API', (await act(staff.c, 'lab', sc2, 'receive', 'dispatched', { condition: 'intact' })).status === 403);
  ok('customer cannot open another customer\'s registration', (await new Client().get(`/me/registrations/${regId}`)).status === 401);

  // 10. Password reset and Arabic emails.
  ok('password reset requested', (await anon.post('/auth/password/forgot', { email: custEmail })).status === 202);
  const rs = await mail(custEmail, 'reset_password');
  const newPw = pw();
  ok('password reset with the emailed link', (await anon.post('/auth/password/reset', { token: rs.token, password: newPw })).status === 200);
  ok('sign-in with the new password', (await new Client().post('/auth/sign-in', { email: custEmail, password: newPw })).status === 200);
  const arEmail = email('arabic');
  await new Client().post('/auth/sign-up', { email: arEmail, password: pw(), locale: 'ar', confirmAdult: true });
  ok('Arabic verification email', /[؀-ۿ]/.test((await mail(arEmail, 'verify_email')).subject));

  const failed = results.filter((r) => !r.pass);
  console.log(`\nRESULT: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.log(`ERROR  ${e.message}`); console.log(`\nRESULT: ${results.filter((r) => r.pass).length}/${results.length} passed before the error`); process.exit(1); });
