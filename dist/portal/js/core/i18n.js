import ar from '../i18n/ar.js';
import en from '../i18n/en.js';
import { isArabicPath } from './paths.js';

export const lang = isArabicPath() ? 'ar' : 'en';
const dict = lang === 'ar' ? ar : en;

/** Translate a key, filling {placeholders}. Missing keys fall back to English, then the key. */
export function t(key, params) {
  let text = dict[key] ?? en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) text = text.split(`{${k}}`).join(String(v));
  return text;
}

const dateFmt = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Riyadh' });
const dateTimeFmt = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' });

export function formatDate(iso) {
  if (!iso) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00+03:00`) : new Date(iso);
  return dateFmt.format(d);
}

export function formatDateTime(iso) {
  return iso ? dateTimeFmt.format(new Date(iso)) : '';
}

const arPlural = new Intl.PluralRules('ar');
const AR_UNITS = {
  year: { zero: '{n} سنة', one: 'سنة واحدة', two: 'سنتان', few: '{n} سنوات', many: '{n} سنة', other: '{n} سنة' },
  month: { zero: '{n} شهر', one: 'شهر واحد', two: 'شهران', few: '{n} أشهر', many: '{n} شهرًا', other: '{n} شهر' },
};

function unit(n, kind) {
  if (lang === 'ar') return AR_UNITS[kind][arPlural.select(n)].replace('{n}', String(n));
  return `${n} ${kind}${n === 1 ? '' : 's'}`;
}

/** "7 years, 3 months" / "5 months" / "30 years" (months shown for children under 18). */
export function formatAge(age) {
  if (!age) return '';
  const { years, months } = age;
  if (years === 0) return unit(months, 'month');
  if (years >= 18 || months === 0) return unit(years, 'year');
  return lang === 'ar' ? `${unit(years, 'year')} و${unit(months, 'month')}` : `${unit(years, 'year')}, ${unit(months, 'month')}`;
}

export function statusLabel(status) {
  return t(`status.${status}`);
}
