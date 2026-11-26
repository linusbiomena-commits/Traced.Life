import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** An error that is safe to show to the client: fixed code + generic message, no internals. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.'),
  invalidCredentials: () => new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.'),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'You do not have permission to do this.'),
  emailNotVerified: () => new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address to continue.'),
  mfaSetupRequired: () => new AppError(403, 'MFA_SETUP_REQUIRED', 'Set up two-step verification to continue.'),
  mfaRequired: () => new AppError(403, 'MFA_REQUIRED', 'Enter your two-step verification code to continue.'),
  csrf: () => new AppError(403, 'CSRF_REJECTED', 'The request could not be verified. Reload the page and try again.'),
  invalidToken: () => new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'This link is invalid or has expired.'),
  invalidMfaCode: () => new AppError(401, 'INVALID_MFA_CODE', 'The verification code is incorrect or has already been used.'),
  notFound: () => new AppError(404, 'NOT_FOUND', 'Not found.'),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.', undefined, {
      'Retry-After': String(retryAfterSeconds),
    }),
};
