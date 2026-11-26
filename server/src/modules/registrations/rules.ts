// Business rules for registrations. The browser has a matching copy (dist/portal/js/core/rules.js)
// for instant feedback; the server is authoritative and a test keeps both in agreement.

export const AGE_OF_MAJORITY = 18;
export const MAX_AGE_YEARS = 120;
export const MIN_DATE_OF_BIRTH = '1900-01-01';

export type Relationship = 'self' | 'child' | 'authorized_dependent';
export type Gender = 'male' | 'female';

/** Today's calendar date in Saudi Arabia (YYYY-MM-DD). */
export function riyadhToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Completed years and months between a date of birth and `today`; null if born after today. */
export function ageParts(dateOfBirth: string, today: string): { years: number; months: number; totalMonths: number } | null {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  let total = (ty - by) * 12 + (tm - bm);
  if (td < bd) total -= 1;
  if (total < 0 || (total === 0 && dateOfBirth > today)) return null;
  return { years: Math.floor(total / 12), months: total % 12, totalMonths: total };
}

export type DobProblem = 'INVALID_DATE' | 'FUTURE_DATE' | 'TOO_OLD' | 'CHILD_MUST_BE_UNDER_18' | 'SELF_MUST_BE_ADULT';

export function dateOfBirthProblem(dateOfBirth: string, relationship: Relationship, today: string): DobProblem | null {
  if (!isValidIsoDate(dateOfBirth) || dateOfBirth < MIN_DATE_OF_BIRTH) return 'INVALID_DATE';
  if (dateOfBirth > today) return 'FUTURE_DATE';
  const age = ageParts(dateOfBirth, today);
  if (!age) return 'FUTURE_DATE';
  if (age.years > MAX_AGE_YEARS) return 'TOO_OLD';
  if (relationship === 'child' && age.years >= AGE_OF_MAJORITY) return 'CHILD_MUST_BE_UNDER_18';
  if (relationship === 'self' && age.years < AGE_OF_MAJORITY) return 'SELF_MUST_BE_ADULT';
  return null;
}

const DIGIT_MAP: Record<string, string> = {};
'٠١٢٣٤٥٦٧٨٩'.split('').forEach((ch, i) => (DIGIT_MAP[ch] = String(i))); // Arabic-Indic
'۰۱۲۳۴۵۶۷۸۹'.split('').forEach((ch, i) => (DIGIT_MAP[ch] = String(i))); // Extended (Persian/Urdu)

export function toAsciiDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (ch) => DIGIT_MAP[ch] ?? ch);
}

/** Normalises a Saudi mobile number to E.164 (+9665XXXXXXXX), or returns null if it isn't one. */
export function normaliseSaudiMobile(input: string): string | null {
  const compact = toAsciiDigits(input).replace(/[\s\-().]/g, '');
  const m = /^(?:\+966|00966|966)?0?(5\d{8})$/.exec(compact);
  return m ? `+966${m[1]}` : null;
}

/** Letters from any script, with spaces, hyphens, apostrophes and dots between them. */
const NAME_RE = /^[\p{L}\p{M}](?:[\p{L}\p{M}'’. -]*[\p{L}\p{M}.])?$/u;

export function normaliseName(input: string): string {
  return input.normalize('NFC').trim().replace(/\s+/g, ' ');
}

export function isValidName(name: string, max = 100): boolean {
  return name.length >= 1 && name.length <= max && NAME_RE.test(name);
}

export const REQUIRED_CONSENTS = ['privacy_policy', 'sample_collection_consent', 'accuracy_declaration'] as const;
export type ConsentType = (typeof REQUIRED_CONSENTS)[number] | 'guardian_authorization';

export function requiredConsentTypes(relationship: Relationship): ConsentType[] {
  return relationship === 'self' ? [...REQUIRED_CONSENTS] : [...REQUIRED_CONSENTS, 'guardian_authorization'];
}
