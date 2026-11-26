import { Hono } from 'hono';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { actorFrom, type AppContext, type AppEnv, type Deps } from '../../context.ts';
import { withTx } from '../../db/pool.ts';
import { enqueueEmail, kickOutbox } from '../mail/outbox.ts';
import { activeCustomerToken, qrUrl, renderQrPng, renderQrSvg, revokeAndReissueCustomerQr } from '../qr/qr.service.ts';
import { trackingIdForFilename } from '../tracking/tracking.ts';
import { AppError, Errors } from '../../lib/errors.ts';
import { check, parseBody } from '../../lib/validate.ts';
import { enforceRateLimit, enforceRateLimits } from '../../middleware/rate-limit.ts';
import { requirePermission, requireSession, requireVerifiedEmail } from '../../middleware/rbac.ts';
import { audit } from '../audit/audit.service.ts';
import { currentConsentDocuments } from '../consents/consents.service.ts';
import { getOwnRegistration, listActiveBranches, listOwnRegistrations } from './registrations.repo.ts';
import { correctPatientForRegistration, createRegistration } from './registrations.service.ts';
import { AGE_OF_MAJORITY, isValidName, MIN_DATE_OF_BIRTH, normaliseName, normaliseSaudiMobile, riyadhToday } from './rules.ts';

const name = (max: number) =>
  z.string().max(max * 2).transform(normaliseName).refine((v) => isValidName(v, max), { message: 'INVALID_NAME' });
const phone = z.string().max(40).transform((v, ctx) => {
  const n = normaliseSaudiMobile(v);
  if (!n) {
    ctx.addIssue({ code: 'custom', message: 'INVALID_SAUDI_MOBILE' });
    return z.NEVER;
  }
  return n;
});

const registrationBody = z.strictObject({
  relationship: z.enum(['self', 'child', 'authorized_dependent']),
  patient: z.strictObject({
    firstName: name(100),
    lastName: name(100),
    dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    gender: z.enum(['male', 'female']),
  }),
  contact: z.strictObject({ fullName: name(200), phone }),
  branchId: z.uuid(),
  consentDocumentIds: z.array(z.uuid()).min(1).max(10),
  saveToProfile: z.boolean().default(true),
});

const profileBody = z
  .strictObject({ fullName: name(200).nullable().optional(), phone: phone.nullable().optional(), locale: z.enum(['en', 'ar']).optional() })
  .refine((b) => Object.keys(b).length > 0, { message: 'EMPTY_UPDATE' });

/** Customer area: own profile and own registrations only. */
export function meRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono<AppEnv>();

  // ---- Profile (any signed-in account) ---------------------------------------------------
  r.get('/profile', requireSession, async (c) => {
    const s = c.get('session')!;
    const { rows } = await db.query<{ full_name: string | null; phone: string | null }>('SELECT full_name, phone FROM users WHERE id = $1', [s.userId]);
    return c.json({ profile: { email: s.email, emailVerified: s.emailVerified, fullName: rows[0]?.full_name ?? null, phone: rows[0]?.phone ?? null, locale: s.locale } });
  });

  r.patch('/profile', requireSession, async (c) => {
    const s = c.get('session')!;
    const body = await parseBody(c, profileBody);
    await enforceRateLimit(db, { key: `profile:user:${s.userId}`, limit: 30, windowSeconds: 3600 });
    const sets: string[] = [];
    const params: unknown[] = [s.userId];
    const changed: string[] = [];
    for (const [field, column] of [['fullName', 'full_name'], ['phone', 'phone'], ['locale', 'locale']] as const) {
      if (body[field] !== undefined) {
        params.push(body[field]);
        sets.push(`${column} = $${params.length}`);
        changed.push(column);
      }
    }
    await db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
    await audit(db, { ...actorFrom(c), action: 'account.profile_updated', outcome: 'success', targetType: 'user', targetId: s.userId, fieldsAccessed: changed });
    return c.json({ status: 'updated' });
  });

  // ---- Registration (verified customers) ------------------------------------------------
  const canCreate = [requireVerifiedEmail, requirePermission(deps, 'registration.create_own')] as const;
  const canRead = [requireVerifiedEmail, requirePermission(deps, 'registration.read_own')] as const;

  r.get('/registration-form', ...canCreate, async (c) => {
    const { locale } = check(z.strictObject({ locale: z.enum(['en', 'ar']).default('en') }), c.req.query());
    const s = c.get('session')!;
    const [branches, documents, profile] = await Promise.all([
      listActiveBranches(db),
      currentConsentDocuments(db, deps.config),
      db.query<{ full_name: string | null; phone: string | null }>('SELECT full_name, phone FROM users WHERE id = $1', [s.userId]),
    ]);
    const forLocale = documents.filter((d) => d.locale === locale);
    if (forLocale.length < 4) {
      throw new AppError(503, 'CONSENT_NOT_CONFIGURED', 'Registration is not available yet. Please try again later.');
    }
    return c.json({
      product: { code: 'traced', sampleType: 'hair', collectionCountry: 'SA' },
      branches,
      consents: forLocale.map(({ id, type, version, title, body, status }) => ({ id, type, version, title, body, provisional: status !== 'approved' })),
      profile: { email: s.email, fullName: profile.rows[0]?.full_name ?? null, phone: profile.rows[0]?.phone ?? null },
      rules: { today: riyadhToday(), minDateOfBirth: MIN_DATE_OF_BIRTH, ageOfMajority: AGE_OF_MAJORITY },
    });
  });

  r.post('/registrations', ...canCreate, async (c) => {
    const s = c.get('session')!;
    const key = c.req.header('idempotency-key') ?? '';
    if (!z.uuid().safeParse(key).success) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Missing or invalid Idempotency-Key header.');
    }
    const body = await parseBody(c, registrationBody);
    await enforceRateLimit(db, { key: `registration:user:${s.userId}`, limit: 20, windowSeconds: 3600 });
    const result = await createRegistration(deps, { userId: s.userId, email: s.email, locale: s.locale }, key, body, actorFrom(c));
    if (!result.replayed) void kickOutbox(deps); // deliver the confirmation email now (retries run in the background)
    const registration = await getOwnRegistration(db, s.userId, result.id);
    return c.json({ registration, replayed: result.replayed }, result.replayed ? 200 : 201);
  });

  r.get('/registrations', ...canRead, async (c) => {
    return c.json({ items: await listOwnRegistrations(db, c.get('session')!.userId) });
  });

  r.get('/registrations/:id', ...canRead, async (c) => {
    const id = c.req.param('id');
    if (!z.uuid().safeParse(id).success) throw Errors.notFound();
    const registration = await getOwnRegistration(db, c.get('session')!.userId, id);
    if (!registration) throw Errors.notFound(); // someone else's id looks exactly like a missing one
    return c.json({ registration });
  });

  // ---- QR codes, emails and corrections for one of the customer's own registrations -------
  /** Loads the caller's own registration (tracking ID, status, locale needs) or 404s. */
  async function ownRegistration(c: AppContext) {
    const id = c.req.param('id') ?? '';
    if (!z.uuid().safeParse(id).success) throw Errors.notFound();
    const { rows } = await db.query<{ id: string; tracking_id: string | null; status: string }>(
      'SELECT id, tracking_id, status FROM registrations WHERE id = $1 AND account_user_id = $2',
      [id, c.get('session')!.userId],
    );
    if (!rows[0]) throw Errors.notFound(); // someone else's registration looks exactly like a missing one
    return rows[0];
  }

  async function qrImage(c: AppContext, format: 'png' | 'svg') {
    const reg = await ownRegistration(c);
    if (!reg.tracking_id || reg.status === 'cancelled' || reg.status === 'rejected') throw Errors.notFound();
    const token = await activeCustomerToken(db, deps, reg.id);
    if (!token) throw Errors.notFound();
    const url = qrUrl(deps.config.appOrigin, c.get('session')!.locale, token);
    const download = c.req.query('download') === '1';
    const filename = `TRACED-${trackingIdForFilename(reg.tracking_id)}.${format}`;
    c.header('Cache-Control', 'no-store, private');
    c.header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${filename}"`);
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    if (format === 'png') {
      c.header('Content-Type', 'image/png');
      return c.body(new Uint8Array(await renderQrPng(url)));
    }
    c.header('Content-Type', 'image/svg+xml; charset=utf-8');
    return c.body(await renderQrSvg(url));
  }

  r.get('/registrations/:id/qr.png', ...canRead, (c) => qrImage(c, 'png'));
  r.get('/registrations/:id/qr.svg', ...canRead, (c) => qrImage(c, 'svg'));

  r.post('/registrations/:id/resend-email', ...canRead, async (c) => {
    const s = c.get('session')!;
    const reg = await ownRegistration(c);
    if (!reg.tracking_id || reg.status === 'cancelled' || reg.status === 'rejected') throw new AppError(409, 'QR_NOT_AVAILABLE', 'There is no active QR code for this registration.');
    await enforceRateLimits(db, [
      { key: `qr_resend:registration:${reg.id}`, limit: 3, windowSeconds: 3600 },
      { key: `qr_resend:user:${s.userId}`, limit: 10, windowSeconds: 86_400 },
    ]);
    await enqueueEmail(db, deps, {
      kind: 'registration_qr_resend', locale: s.locale, to: s.email, userId: s.userId, registrationId: reg.id,
      dedupeKey: `registration_qr_resend:${reg.id}:${randomUUID()}`,
    });
    await audit(db, { ...actorFrom(c), action: 'registration.email_resent', outcome: 'success', targetType: 'registration', targetId: reg.id });
    void kickOutbox(deps);
    return c.json({ status: 'email_queued' }, 202);
  });

  r.post('/registrations/:id/qr/regenerate', ...canRead, async (c) => {
    const s = c.get('session')!;
    const reg = await ownRegistration(c);
    if (reg.status !== 'registration_completed' && reg.status !== 'awaiting_sample_collection') {
      throw new AppError(409, 'QR_LOCKED', 'The QR code can’t be replaced at this stage. Please contact support.');
    }
    await enforceRateLimit(db, { key: `qr_regenerate:registration:${reg.id}`, limit: 3, windowSeconds: 86_400 });
    await withTx(db, async (tx) => {
      await revokeAndReissueCustomerQr(tx, deps, reg.id, s.userId, 'customer_requested');
      await enqueueEmail(tx, deps, {
        kind: 'registration_qr_resend', locale: s.locale, to: s.email, userId: s.userId, registrationId: reg.id,
        dedupeKey: `registration_qr_regenerated:${reg.id}:${randomUUID()}`,
      });
      await audit(tx, { ...actorFrom(c), action: 'qr.regenerated', outcome: 'success', targetType: 'registration', targetId: reg.id, metadata: { reason: 'customer_requested' } });
    });
    void kickOutbox(deps);
    return c.json({ registration: await getOwnRegistration(db, s.userId, reg.id) });
  });

  r.patch('/registrations/:id/patient', ...canRead, async (c) => {
    const s = c.get('session')!;
    const reg = await ownRegistration(c);
    const body = await parseBody(c, z.strictObject({ patient: registrationBody.shape.patient, reason: z.string().trim().max(500).optional() }));
    await enforceRateLimit(db, { key: `patient_correct:user:${s.userId}`, limit: 20, windowSeconds: 3600 });
    const changed = await correctPatientForRegistration(deps, s.userId, reg.id, body.patient, body.reason ?? null, actorFrom(c));
    return c.json({ changed: changed ?? [], registration: await getOwnRegistration(db, s.userId, reg.id) });
  });

  return r;
}
