import { Hono } from 'hono';
import { z } from 'zod';
import { actorFrom, primaryRole, type AppContext, type AppEnv, type Deps, type SessionInfo } from '../../context.ts';
import { isUniqueViolation, withTx } from '../../db/pool.ts';
import { hmac } from '../../lib/crypto.ts';
import { AppError, Errors } from '../../lib/errors.ts';
import { burnPasswordCheck, hashPassword, passwordProblem, verifyPassword } from '../../lib/password.ts';
import { emailField, localeField, parseBody, passwordField, tokenField } from '../../lib/validate.ts';
import { enforceRateLimit, enforceRateLimits } from '../../middleware/rate-limit.ts';
import { requireSession } from '../../middleware/rbac.ts';
import { audit, auditSafe } from '../audit/audit.service.ts';
import { sendMailInBackground } from '../mail/send.ts';
import type { RoleKey } from '../rbac/catalogue.ts';
import { buildLink } from './links.ts';
import {
  claimTotpStep, consumeRecoveryCode, decryptSecret, encryptSecret, matchTotp, newTotpSecret, otpauthUrl, regenerateRecoveryCodes,
} from './mfa.ts';
import {
  clearSessionCookie, createSession, csrfTokenFor, loadSession, revokeAllSessions, revokeSession, rotateSession, writeSessionCookie,
} from './sessions.ts';
import { consumeToken, issueToken } from './tokens.ts';

export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_SECONDS = 15 * 60;

/** The only shape of "current user" the API ever returns. */
export function serializeMe(s: SessionInfo) {
  return {
    id: s.userId,
    email: s.email,
    emailVerified: s.emailVerified,
    locale: s.locale,
    roles: [...s.roles].sort(),
    permissions: [...s.permissions].sort(),
    mfa: { required: s.requiresMfa, enrolled: s.mfaEnrolled, verified: s.mfaVerified },
  };
}

function weakPassword(reason: string) {
  return new AppError(422, 'WEAK_PASSWORD', 'Choose a stronger password (at least 12 characters, not containing your email).', { reason });
}

export function authRoutes(deps: Deps) {
  const { db, config } = deps;
  const r = new Hono<AppEnv>();

  const emailKey = (email: string) => hmac(config.tokenHmacKey, `rl:${email}`).toString('hex').slice(0, 32);
  const ipKey = (c: AppContext) => c.get('ip') ?? 'unknown';
  const session = (c: AppContext) => c.get('session')!;

  // ---- Sign-up (customers only; staff and admins are created by invitation) -----------------
  r.post('/sign-up', async (c) => {
    // Account holders must be adults (approved decision): the box must be ticked; recorded with a timestamp.
    const body = await parseBody(c, z.strictObject({ email: emailField, password: passwordField, locale: localeField.default('en'), confirmAdult: z.literal(true) }));
    await enforceRateLimits(db, [
      { key: `signup:ip:${ipKey(c)}`, limit: 10, windowSeconds: 3600 },
      { key: `signup:email:${emailKey(body.email)}`, limit: 3, windowSeconds: 3600 },
    ]);
    const problem = passwordProblem(body.password, body.email);
    if (problem) throw weakPassword(problem);
    const passwordHash = await hashPassword(body.password);
    const meta = actorFrom(c);

    let created: { userId: string; token: string } | null = null;
    try {
      created = await withTx(db, async (tx) => {
        const exists = await tx.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
        if (exists.rowCount) return null;
        const { rows } = await tx.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, locale, password_changed_at, adult_confirmed_at) VALUES ($1, $2, $3, now(), now()) RETURNING id`,
          [body.email, passwordHash, body.locale],
        );
        const userId = rows[0]!.id;
        await tx.query(`INSERT INTO user_roles (user_id, role_key) VALUES ($1, 'customer')`, [userId]);
        const token = await issueToken(tx, deps, userId, 'verify_email');
        await audit(tx, { ...meta, actorUserId: userId, actorRole: 'customer', action: 'auth.sign_up', outcome: 'success', targetType: 'user', targetId: userId });
        return { userId, token };
      });
    } catch (err) {
      if (!isUniqueViolation(err, 'users_email_key')) throw err; // lost a race with an identical sign-up
    }

    if (created) {
      sendMailInBackground(deps, {
        to: body.email, template: 'verify_email', locale: body.locale,
        data: { link: buildLink(config.appOrigin, 'verify_email', body.locale, created.token) },
      });
    } else {
      // Same response as success, so sign-up cannot be used to discover who has an account.
      const { rows } = await db.query<{ id: string; locale: 'en' | 'ar' }>('SELECT id, locale FROM users WHERE email = $1', [body.email]);
      const existing = rows[0];
      if (existing) {
        await auditSafe(db, { ...meta, action: 'auth.sign_up', outcome: 'failure', targetType: 'user', targetId: existing.id, metadata: { reason: 'email_exists' } });
        sendMailInBackground(deps, {
          to: body.email, template: 'account_exists', locale: existing.locale,
          data: { link: buildLink(config.appOrigin, 'sign_in', existing.locale) },
        });
      }
    }
    return c.json({ status: 'verification_sent' }, 202);
  });

  // ---- Email verification -------------------------------------------------------------------
  r.post('/verify-email', async (c) => {
    const { token } = await parseBody(c, z.strictObject({ token: tokenField }));
    await enforceRateLimit(db, { key: `verify:ip:${ipKey(c)}`, limit: 30, windowSeconds: 3600 });
    const userId = await withTx(db, async (tx) => {
      const uid = await consumeToken(tx, deps, token, 'verify_email');
      if (!uid) return null;
      await tx.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [uid]);
      await audit(tx, { ...actorFrom(c), actorUserId: uid, action: 'auth.email_verified', outcome: 'success', targetType: 'user', targetId: uid });
      return uid;
    });
    if (!userId) {
      await auditSafe(db, { ...actorFrom(c), action: 'auth.email_verified', outcome: 'failure', metadata: { reason: 'invalid_token' } });
      throw Errors.invalidToken();
    }
    return c.json({ status: 'verified' });
  });

  r.post('/verify-email/resend', requireSession, async (c) => {
    const s = session(c);
    if (s.emailVerified) return c.json({ status: 'already_verified' });
    await enforceRateLimit(db, { key: `verify_resend:user:${s.userId}`, limit: 3, windowSeconds: 3600 });
    const token = await issueToken(db, deps, s.userId, 'verify_email');
    sendMailInBackground(deps, {
      to: s.email, template: 'verify_email', locale: s.locale,
      data: { link: buildLink(config.appOrigin, 'verify_email', s.locale, token) },
    });
    await auditSafe(db, { ...actorFrom(c), action: 'auth.verification_resent', outcome: 'success', targetType: 'user', targetId: s.userId });
    return c.json({ status: 'verification_sent' }, 202);
  });

  // ---- Sign-in / sign-out -------------------------------------------------------------------
  r.post('/sign-in', async (c) => {
    const body = await parseBody(c, z.strictObject({ email: emailField, password: passwordField }));
    await enforceRateLimits(db, [
      { key: `signin:ip:${ipKey(c)}`, limit: 20, windowSeconds: 900 },
      // Above LOCKOUT_THRESHOLD on purpose: the audited account lockout is the per-account control;
      // this limit only caps password-hashing work aimed at one address.
      { key: `signin:email:${emailKey(body.email)}`, limit: 20, windowSeconds: 900 },
    ]);
    const meta = actorFrom(c);
    const { rows } = await db.query<{ id: string; password_hash: string | null; status: string; locked: boolean; roles: RoleKey[] }>(
      `SELECT u.id, u.password_hash, u.status, COALESCE(u.locked_until > now(), false) AS locked,
              COALESCE(array_agg(ur.role_key) FILTER (WHERE ur.role_key IS NOT NULL), '{}') AS roles
         FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id
        WHERE u.email = $1 GROUP BY u.id`,
      [body.email],
    );
    const user = rows[0];
    const fail = async (reason: string, userId?: string) => {
      await auditSafe(db, { ...meta, action: 'auth.sign_in', outcome: 'failure', targetType: userId ? 'user' : null, targetId: userId ?? null, metadata: { reason } });
      return Errors.invalidCredentials(); // one generic answer for every failure reason
    };

    if (!user || !user.password_hash) {
      await burnPasswordCheck(body.password);
      throw await fail(user ? 'no_password_set' : 'unknown_email', user?.id);
    }
    if (user.locked) {
      await burnPasswordCheck(body.password);
      throw await fail('locked', user.id);
    }
    if (!(await verifyPassword(user.password_hash, body.password))) {
      const { rows: lock } = await db.query<{ locked_now: boolean }>(
        `UPDATE users SET
           locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(secs => $3) ELSE locked_until END,
           failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END
         WHERE id = $1
         RETURNING locked_until > now() AS locked_now`,
        [user.id, LOCKOUT_THRESHOLD, LOCKOUT_SECONDS],
      );
      if (lock[0]?.locked_now) await auditSafe(db, { ...meta, action: 'auth.account_locked', outcome: 'success', targetType: 'user', targetId: user.id });
      throw await fail('bad_password', user.id);
    }
    if (user.status !== 'active') throw await fail(`status_${user.status}`, user.id);

    const created = await withTx(db, async (tx) => {
      await tx.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
      const s = await createSession(tx, deps, { userId: user.id, roles: user.roles, mfaVerified: false, ip: meta.ip, userAgent: meta.userAgent });
      await audit(tx, { ...meta, actorUserId: user.id, actorRole: primaryRole(user.roles), action: 'auth.sign_in', outcome: 'success', targetType: 'user', targetId: user.id });
      return s;
    });
    writeSessionCookie(c, deps, created.token, created.maxAgeSeconds);
    const loaded = (await loadSession(db, deps, created.token))!;
    return c.json({ user: serializeMe(loaded), csrfToken: csrfTokenFor(deps, created.token) });
  });

  r.post('/sign-out', requireSession, async (c) => {
    const s = session(c);
    await revokeSession(db, s.sessionId, 'sign_out');
    clearSessionCookie(c, deps);
    await auditSafe(db, { ...actorFrom(c), action: 'auth.sign_out', outcome: 'success', targetType: 'user', targetId: s.userId });
    return c.body(null, 204);
  });

  r.get('/me', async (c) => {
    const s = c.get('session');
    if (!s) {
      clearSessionCookie(c, deps); // drop stale cookies
      throw Errors.unauthenticated();
    }
    return c.json({ user: serializeMe(s), csrfToken: csrfTokenFor(deps, c.get('sessionToken')!) });
  });

  // ---- Passwords ----------------------------------------------------------------------------
  r.post('/password/forgot', async (c) => {
    const body = await parseBody(c, z.strictObject({ email: emailField }));
    await enforceRateLimits(db, [
      { key: `forgot:ip:${ipKey(c)}`, limit: 10, windowSeconds: 3600 },
      { key: `forgot:email:${emailKey(body.email)}`, limit: 3, windowSeconds: 3600 },
    ]);
    const { rows } = await db.query<{ id: string; locale: 'en' | 'ar'; status: string }>('SELECT id, locale, status FROM users WHERE email = $1', [body.email]);
    const user = rows[0];
    if (user && user.status === 'active') {
      const token = await issueToken(db, deps, user.id, 'reset_password');
      sendMailInBackground(deps, {
        to: body.email, template: 'reset_password', locale: user.locale,
        data: { link: buildLink(config.appOrigin, 'reset_password', user.locale, token) },
      });
      await auditSafe(db, { ...actorFrom(c), action: 'auth.password_reset_requested', outcome: 'success', targetType: 'user', targetId: user.id });
    } else {
      await auditSafe(db, { ...actorFrom(c), action: 'auth.password_reset_requested', outcome: 'failure', targetType: user ? 'user' : null, targetId: user?.id ?? null, metadata: { reason: user ? `status_${user.status}` : 'unknown_email' } });
    }
    return c.json({ status: 'reset_email_sent_if_account_exists' }, 202);
  });

  /** Shared by password reset and invited-account setup: consume token, check policy, set password. */
  async function setPasswordWithToken(c: AppContext, purpose: 'reset_password' | 'account_setup', token: string, password: string) {
    await enforceRateLimit(db, { key: `${purpose}:ip:${ipKey(c)}`, limit: 20, windowSeconds: 3600 });
    const passwordHash = await hashPassword(password);
    return withTx(db, async (tx) => {
      const userId = await consumeToken(tx, deps, token, purpose);
      if (!userId) throw Errors.invalidToken();
      const { rows } = await tx.query<{ email: string; locale: 'en' | 'ar' }>('SELECT email, locale FROM users WHERE id = $1', [userId]);
      const user = rows[0]!;
      const problem = passwordProblem(password, user.email);
      if (problem) throw weakPassword(problem); // rolls back, so the token stays usable
      await tx.query(
        `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_login_count = 0, locked_until = NULL,
                email_verified_at = COALESCE(email_verified_at, now())  -- the link proved inbox control
          WHERE id = $1`,
        [userId, passwordHash],
      );
      await revokeAllSessions(tx, userId, purpose);
      await audit(tx, {
        ...actorFrom(c), actorUserId: userId,
        action: purpose === 'reset_password' ? 'auth.password_reset' : 'auth.account_setup',
        outcome: 'success', targetType: 'user', targetId: userId,
      });
      return { userId, ...user };
    });
  }

  r.post('/password/reset', async (c) => {
    const body = await parseBody(c, z.strictObject({ token: tokenField, password: passwordField }));
    const user = await setPasswordWithToken(c, 'reset_password', body.token, body.password);
    sendMailInBackground(deps, { to: user.email, template: 'password_changed', locale: user.locale, data: {} });
    return c.json({ status: 'password_reset' });
  });

  r.post('/account-setup', async (c) => {
    const body = await parseBody(c, z.strictObject({ token: tokenField, password: passwordField }));
    await setPasswordWithToken(c, 'account_setup', body.token, body.password);
    return c.json({ status: 'account_ready' });
  });

  r.post('/password/change', requireSession, async (c) => {
    const s = session(c);
    const body = await parseBody(c, z.strictObject({ currentPassword: passwordField, newPassword: passwordField }));
    await enforceRateLimit(db, { key: `pwchange:user:${s.userId}`, limit: 10, windowSeconds: 3600 });
    const { rows } = await db.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [s.userId]);
    const current = rows[0]?.password_hash;
    if (!current || !(await verifyPassword(current, body.currentPassword))) {
      await auditSafe(db, { ...actorFrom(c), action: 'auth.password_change', outcome: 'failure', targetType: 'user', targetId: s.userId, metadata: { reason: 'bad_current_password' } });
      throw Errors.invalidCredentials();
    }
    const problem = passwordProblem(body.newPassword, s.email);
    if (problem) throw weakPassword(problem);
    const passwordHash = await hashPassword(body.newPassword);
    await withTx(db, async (tx) => {
      await tx.query('UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [s.userId, passwordHash]);
      await revokeAllSessions(tx, s.userId, 'password_change', s.sessionId);
      await audit(tx, { ...actorFrom(c), action: 'auth.password_change', outcome: 'success', targetType: 'user', targetId: s.userId });
    });
    sendMailInBackground(deps, { to: s.email, template: 'password_changed', locale: s.locale, data: {} });
    return c.json({ status: 'password_changed' });
  });

  // ---- Two-step verification (TOTP); required for admin, super admin, lab operator, auditor --
  r.post('/mfa/setup', requireSession, async (c) => {
    const s = session(c);
    if (s.mfaEnrolled) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-step verification is already set up.');
    await enforceRateLimit(db, { key: `mfa_setup:user:${s.userId}`, limit: 10, windowSeconds: 3600 });
    const secret = newTotpSecret();
    await db.query('UPDATE users SET mfa_pending_secret_enc = $2 WHERE id = $1', [s.userId, encryptSecret(deps, s.userId, secret, 'pending')]);
    await auditSafe(db, { ...actorFrom(c), action: 'auth.mfa_setup_started', outcome: 'success', targetType: 'user', targetId: s.userId });
    return c.json({ otpauthUrl: otpauthUrl(secret, s.email), secret });
  });

  r.post('/mfa/enable', requireSession, async (c) => {
    const s = session(c);
    const { code } = await parseBody(c, z.strictObject({ code: z.string().trim().max(10) }));
    if (s.mfaEnrolled) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-step verification is already set up.');
    await enforceRateLimit(db, { key: `mfa_enable:user:${s.userId}`, limit: 10, windowSeconds: 900 });
    const { rows } = await db.query<{ pending: string | null }>('SELECT mfa_pending_secret_enc AS pending FROM users WHERE id = $1', [s.userId]);
    const pending = rows[0]?.pending;
    if (!pending) throw new AppError(409, 'MFA_SETUP_NOT_STARTED', 'Start two-step verification setup first.');
    const secret = decryptSecret(deps, s.userId, pending, 'pending');
    const step = matchTotp(secret, code);
    if (step === null) {
      await auditSafe(db, { ...actorFrom(c), action: 'auth.mfa_enable', outcome: 'failure', targetType: 'user', targetId: s.userId });
      throw Errors.invalidMfaCode();
    }
    const result = await withTx(db, async (tx) => {
      const upd = await tx.query(
        `UPDATE users SET mfa_totp_secret_enc = $2, mfa_pending_secret_enc = NULL, mfa_enabled_at = now(), mfa_last_used_step = $3
          WHERE id = $1 AND mfa_enabled_at IS NULL`,
        [s.userId, encryptSecret(deps, s.userId, secret, 'active'), step],
      );
      if (upd.rowCount !== 1) throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-step verification is already set up.');
      const recoveryCodes = await regenerateRecoveryCodes(tx, deps, s.userId);
      await audit(tx, { ...actorFrom(c), action: 'auth.mfa_enabled', outcome: 'success', targetType: 'user', targetId: s.userId });
      await revokeAllSessions(tx, s.userId, 'mfa_enabled', s.sessionId);
      const csrfToken = await rotateSession(c, tx, deps, s, { mfaVerified: true });
      return { recoveryCodes, csrfToken };
    });
    return c.json(result);
  });

  r.post('/mfa/verify', requireSession, async (c) => {
    const s = session(c);
    const body = await parseBody(
      c,
      z.strictObject({ code: z.string().trim().max(10).optional(), recoveryCode: z.string().trim().max(20).optional() })
        .refine((b) => (b.code === undefined) !== (b.recoveryCode === undefined), { message: 'Send exactly one of code or recoveryCode' }),
    );
    if (!s.mfaEnrolled) throw new AppError(409, 'MFA_NOT_ENABLED', 'Two-step verification is not set up.');
    await enforceRateLimits(db, [
      { key: `mfa_verify:user:${s.userId}`, limit: 5, windowSeconds: 300 },
      { key: `mfa_verify:ip:${ipKey(c)}`, limit: 30, windowSeconds: 300 },
    ]);

    let ok = false;
    const method = body.code !== undefined ? 'totp' : 'recovery_code';
    if (body.code !== undefined) {
      const { rows } = await db.query<{ enc: string }>('SELECT mfa_totp_secret_enc AS enc FROM users WHERE id = $1', [s.userId]);
      const step = matchTotp(decryptSecret(deps, s.userId, rows[0]!.enc, 'active'), body.code);
      ok = step !== null && (await claimTotpStep(db, s.userId, step));
    } else {
      ok = await consumeRecoveryCode(db, deps, s.userId, body.recoveryCode!);
    }
    if (!ok) {
      await auditSafe(db, { ...actorFrom(c), action: 'auth.mfa_verify', outcome: 'failure', targetType: 'user', targetId: s.userId, metadata: { method } });
      throw Errors.invalidMfaCode();
    }
    const csrfToken = await withTx(db, async (tx) => {
      await audit(tx, { ...actorFrom(c), action: 'auth.mfa_verify', outcome: 'success', targetType: 'user', targetId: s.userId, metadata: { method } });
      return rotateSession(c, tx, deps, s, { mfaVerified: true });
    });
    return c.json({ status: 'verified', csrfToken });
  });

  return r;
}
