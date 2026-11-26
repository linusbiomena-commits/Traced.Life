import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { AppError } from './errors.ts';
import { PASSWORD_MAX } from './password.ts';

/** Parses the JSON body against a strict schema. Unknown fields are rejected, not ignored. */
export async function parseBody<T extends z.ZodType>(c: AppContext, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
  return check(schema, json);
}

export function check<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AppError(422, 'VALIDATION_FAILED', 'Some fields are missing or invalid.', {
      fields: r.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code })),
    });
  }
  return r.data;
}

export const emailField = z.string().trim().toLowerCase().max(254).pipe(z.email());
/** Length only; policy (min length, not containing the email) is checked in the handler. */
export const passwordField = z.string().min(1).max(PASSWORD_MAX * 4);
export const tokenField = z.string().regex(/^[A-Za-z0-9_-]{20,128}$/);
export const localeField = z.enum(['en', 'ar']);
