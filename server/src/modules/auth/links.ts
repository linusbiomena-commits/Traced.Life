import type { Locale } from '../mail/templates.ts';

// Tokens travel in the URL fragment (#token=...), which browsers never send to servers or in
// Referer headers, so they stay out of access logs. The pages that read them come in Phase 2/5.

type LinkKind = 'verify_email' | 'reset_password' | 'staff_setup' | 'admin_setup' | 'sign_in';

const PATHS: Record<LinkKind, string> = {
  verify_email: '/traced/account/verify-email/',
  reset_password: '/traced/account/reset-password/',
  staff_setup: '/traced/staff/accept-invite/',
  admin_setup: '/traced/admin/accept-invite/',
  sign_in: '/traced/account/sign-in/',
};

export function buildLink(appOrigin: string, kind: LinkKind, locale: Locale, token?: string): string {
  const prefix = locale === 'ar' ? '/ar' : '';
  return `${appOrigin}${prefix}${PATHS[kind]}${token ? `#token=${token}` : ''}`;
}
