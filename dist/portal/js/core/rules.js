// Browser copy of server/src/modules/registrations/rules.ts, for instant form feedback.
// The server re-checks everything; server/test/registrations.test.ts keeps the two in agreement.

export const AGE_OF_MAJORITY = 18;
export const MAX_AGE_YEARS = 120;
export const MIN_DATE_OF_BIRTH = '1900-01-01';

export function riyadhToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function ageParts(dateOfBirth, today) {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  let total = (ty - by) * 12 + (tm - bm);
  if (td < bd) total -= 1;
  if (total < 0 || (total === 0 && dateOfBirth > today)) return null;
  return { years: Math.floor(total / 12), months: total % 12, totalMonths: total };
}

export function dateOfBirthProblem(dateOfBirth, relationship, today) {
  if (!isValidIsoDate(dateOfBirth) || dateOfBirth < MIN_DATE_OF_BIRTH) return 'INVALID_DATE';
  if (dateOfBirth > today) return 'FUTURE_DATE';
  const age = ageParts(dateOfBirth, today);
  if (!age) return 'FUTURE_DATE';
  if (age.years > MAX_AGE_YEARS) return 'TOO_OLD';
  if (relationship === 'child' && age.years >= AGE_OF_MAJORITY) return 'CHILD_MUST_BE_UNDER_18';
  if (relationship === 'self' && age.years < AGE_OF_MAJORITY) return 'SELF_MUST_BE_ADULT';
  return null;
}

export function toAsciiDigits(value) {
  return value.replace(/[٠-٩]/g, (ch) => String(ch.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0));
}

export function normaliseSaudiMobile(input) {
  const compact = toAsciiDigits(input).replace(/[\s\-().]/g, '');
  const m = /^(?:\+966|00966|966)?0?(5\d{8})$/.exec(compact);
  return m ? `+966${m[1]}` : null;
}

const NAME_RE = /^[\p{L}\p{M}](?:[\p{L}\p{M}'’. -]*[\p{L}\p{M}.])?$/u;

export function normaliseName(input) {
  return input.normalize('NFC').trim().replace(/\s+/g, ' ');
}

export function isValidName(name, max = 100) {
  return name.length >= 1 && name.length <= max && NAME_RE.test(name);
}

export function requiredConsentTypes(relationship) {
  const base = ['privacy_policy', 'sample_collection_consent', 'accuracy_declaration'];
  return relationship === 'self' ? base : [...base, 'guardian_authorization'];
}

/** Local display of a +9665XXXXXXXX number as 05X XXX XXXX. */
export function formatSaudiMobile(e164) {
  const m = /^\+966(5\d)(\d{3})(\d{4})$/.exec(e164 || '');
  return m ? `0${m[1]} ${m[2]} ${m[3]}` : e164 || '';
}
