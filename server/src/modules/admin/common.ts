import { z } from 'zod';
import type { AppContext, Deps, SessionInfo } from '../../context.ts';
import { hmac } from '../../lib/crypto.ts';
import { AppError, Errors } from '../../lib/errors.ts';
import type { Permission, RoleKey } from '../rbac/catalogue.ts';

// Shared helpers for the admin API. Admin endpoints build every response from explicit field
// lists (never `SELECT *` passed through), and none of them is reachable by collection staff,
// lab operators or customers: requirePermission() checks the permission matrix and MFA first.

export const uuid = z.uuid();

/** Mandatory administrative reason (stored in domain tables; redacted from non-PII audit views). */
export const reasonField = z.string().trim().min(5, 'REASON_REQUIRED').max(500);

export function idParam(c: AppContext, name = 'id'): string {
  const id = c.req.param(name);
  if (!id || !uuid.safeParse(id).success) throw Errors.notFound();
  return id;
}

/** Statuses in which a registration still awaits collection and can be changed by admins. */
export const OPEN_STATUSES = ['registration_completed', 'awaiting_sample_collection'] as const;
export const isOpen = (status: string) => (OPEN_STATUSES as readonly string[]).includes(status);

/** f***@d***.sa: enough to recognise an address in operational lists without exposing it. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
}

/** Removes anything that looks like an email address from provider error text. */
export function scrubEmails(text: string | null): string | null {
  return text ? text.replace(/[^\s@<>"']+@[^\s@<>"']+/g, '[email]') : text;
}

/**
 * Admin searches may use personal data (name, email, phone). The audit log records only the
 * search type, a keyed hash of the normalised term (lets an investigator confirm "was X searched?"
 * without storing X) and the number of results. Never the readable term.
 */
export function searchTermHash(deps: Deps, term: string): string {
  return hmac(deps.config.tokenHmacKey, `admin_search:${term.trim().toLowerCase()}`).toString('hex').slice(0, 24);
}

/** Anything that carries a permission set: a request session, or authority re-read inside a transaction. */
export type Authority = Pick<SessionInfo, 'permissions'>;

export const has = (s: Authority, p: Permission) => s.permissions.has(p);

/** Roles an actor may grant or manage. `admin.manage` (super admin) covers every staff-side role. */
export function manageableRoles(s: Authority): RoleKey[] {
  if (has(s, 'admin.manage')) return ['collection_staff', 'lab_operator', 'admin', 'auditor', 'super_admin'];
  if (has(s, 'staff.manage')) return ['collection_staff', 'lab_operator'];
  return [];
}

export function assertCanManageRoles(s: Authority, roles: readonly RoleKey[]): void {
  const allowed = manageableRoles(s);
  if (roles.some((r) => !allowed.includes(r))) throw new AppError(403, 'ROLE_NOT_GRANTABLE', 'You can’t grant or manage this role.');
}

/** CSV cell safe against spreadsheet formula injection (OWASP): =, +, -, @, tab and CR are neutralised. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csv(rows: unknown[][]): string {
  return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`; // BOM: Arabic in Excel
}

/** Riyadh calendar date (YYYY-MM-DD) filters, inclusive. */
export const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
