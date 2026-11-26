import { Hono, type ErrorHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv, Deps } from './context.ts';
import { AppError } from './lib/errors.ts';
import { log } from './lib/logger.ts';
import { csrfProtection, requestContext, sessionLoader } from './middleware/request.ts';
import { adminRoutes } from './modules/admin/index.ts';
import { authRoutes } from './modules/auth/auth.routes.ts';
import { meRoutes } from './modules/registrations/me.routes.ts';
import { staffRoutes } from './modules/qr/staff.routes.ts';
import { internalRoutes } from './modules/mail/internal.routes.ts';

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId');
  if (err instanceof AppError) {
    for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
    return c.json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), requestId } }, err.status);
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: `HTTP_${err.status}`, message: err.message || 'Request failed.', requestId } }, err.status);
  }
  log.error('unhandled error', { requestId, path: c.req.path, error: err.message, stack: err.stack });
  return c.json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId } }, 500);
};

/** The TRACED API, mounted at /api/v1. Pure (no listening, no static files) so tests can drive it directly. */
export function createApi(deps: Deps): Hono<AppEnv> {
  const api = new Hono<AppEnv>();

  api.use('*', requestContext(deps));
  api.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      xFrameOptions: 'DENY',
      referrerPolicy: 'no-referrer',
      crossOriginResourcePolicy: 'same-origin',
    }),
  );
  api.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  api.use(
    '*',
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) => c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } }, 413),
    }),
  );
  api.use('*', sessionLoader(deps));
  api.use('*', csrfProtection(deps));

  api.get('/health', async (c) => {
    await deps.db.query('SELECT 1');
    return c.json({ status: 'ok' });
  });
  api.route('/auth', authRoutes(deps));
  api.route('/admin', adminRoutes(deps));
  api.route('/me', meRoutes(deps));
  api.route('/staff', staffRoutes(deps));
  api.route('/internal', internalRoutes(deps));

  api.onError(errorHandler);
  return api;
}

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route('/api/v1', createApi(deps));
  // Hono uses the top-level notFound for mounted apps.
  app.notFound((c) =>
    c.req.path.startsWith('/api/')
      ? c.json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      : c.text('Not found', 404),
  );
  app.onError(errorHandler);
  return app;
}
