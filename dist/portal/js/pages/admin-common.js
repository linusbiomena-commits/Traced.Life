import { h, mount, nextId } from '../core/dom.js';
import { formatAge, formatDateTime, lang, t } from '../core/i18n.js';
import { alertBox, errorMessage, pageHeading, setBusy } from '../core/ui.js';
import { statusBadge } from './common.js';

// Shared building blocks for the admin portal. Everything renders through h() (textContent only);
// the server decides what each account may see and do, the UI only mirrors it.

export { statusBadge };

export function adminPage(title, lead, ...children) {
  return h('div', { class: 'p-wide' },
    h('p', { class: 'p-badge p-badge--muted' }, t('admin.portal')),
    h('div', { class: 'p-mt-s' }, pageHeading(title, lead)),
    h('div', { class: 'p-stack p-mt-m' }, children));
}

export const card = (titleText, ...children) => {
  const id = nextId('sec');
  return h('section', { class: 'p-card', 'aria-labelledby': id }, titleText ? h('h2', { class: 'p-h2', id }, titleText) : null, h('div', { class: titleText ? 'p-mt-m' : '' }, children));
};

/** Data table inside a horizontally scrollable wrapper (keeps the page itself from scrolling sideways). */
export function table(headers, rows, { caption, numeric = [] } = {}) {
  if (!rows.length) return h('p', { class: 'p-muted' }, t('admin.empty'));
  return h('div', { class: 'p-table-wrap', tabindex: '0', role: 'region', 'aria-label': caption || t('admin.table') },
    h('table', { class: 'p-table' },
      caption ? h('caption', { class: 'visually-hidden' }, caption) : null,
      h('thead', {}, h('tr', {}, headers.map((x, i) => h('th', { scope: 'col', class: numeric.includes(i) ? 'p-num' : undefined }, x)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((cell, i) => h('td', { class: numeric.includes(i) ? 'p-num' : undefined }, cell ?? '–')))))));
}

export function dl(pairs) {
  return h('dl', { class: 'p-dl' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v === null || v === undefined || v === '' ? '–' : v)]));
}

export const ltr = (text) => (text ? h('span', { class: 'p-ltr', dir: 'ltr' }, text) : '–');
export const when = (iso) => (iso ? formatDateTime(iso) : '–');
export const ageText = (age) => formatAge(age) || '–';
export const yesNo = (v) => t(v ? 'admin.yes' : 'admin.no');
export const roleLabel = (r) => t(`admin.role.${r}`);
export const branchText = (b) => (b ? (lang === 'ar' ? b.nameAr : b.nameEn) + (b.code ? ` (${b.code})` : '') : '–');
export const genderText = (g) => (g ? t(`reg.gender.${g}`) : '–');
export const relationshipText = (r) => t(`admin.relationship.${r}`);

/** Labelled control (input, select or textarea) that works with the rest of the portal styles. */
export function control(label, el, hint) {
  const id = el.id || nextId('c');
  el.id = id;
  const hintId = hint ? `${id}-hint` : null;
  if (hintId) el.setAttribute('aria-describedby', hintId);
  return h('div', { class: 'p-field' }, h('label', { class: 'p-label', for: id }, label), hint ? h('p', { class: 'p-hint', id: hintId }, hint) : null, el);
}
export const input = (attrs = {}) => h('input', { class: 'p-input', type: 'text', ...attrs });
export function select(options, value, attrs = {}) {
  const el = h('select', { class: 'p-select', ...attrs }, options.map(([v, label]) => h('option', { value: v, selected: v === value || undefined }, label)));
  return el;
}
export const textarea = (attrs = {}) => h('textarea', { class: 'p-textarea', ...attrs });
export function checkbox(label, checked = false, attrs = {}) {
  const box = h('input', { type: 'checkbox', checked: checked || undefined, ...attrs });
  return { box, wrap: h('label', { class: 'p-check' }, box, h('span', {}, label)) };
}

/**
 * An expandable administrative action with a mandatory reason. `fields` are extra controls;
 * `run(reason)` performs the request and returns what to show (or throws an ApiError).
 */
export function actionForm({ summary, intro, fields = [], submitLabel, reason = true, danger = false, run, confirmText }) {
  const status = h('div', { 'aria-live': 'polite' });
  const reasonEl = reason ? textarea({ maxlength: 500, rows: 3, required: true, 'aria-required': 'true' }) : null;
  const confirm = confirmText ? checkbox(confirmText) : null;
  const submit = h('button', { type: 'submit', class: `p-btn ${danger ? 'p-btn--dark' : 'p-btn--primary'}` }, submitLabel);
  const form = h('form', { novalidate: true, class: 'p-stack' },
    intro ? h('p', { class: 'p-muted p-small' }, intro) : null,
    fields,
    reasonEl ? control(t('admin.reason'), reasonEl, t('admin.reasonHint')) : null,
    confirm ? confirm.wrap : null,
    status,
    h('div', { class: 'p-actions' }, submit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(status);
    const text = reasonEl ? reasonEl.value.trim() : '';
    if (reasonEl && text.length < 5) {
      mount(status, alertBox('error', t('admin.reasonRequired')));
      reasonEl.focus();
      return;
    }
    if (confirm && !confirm.box.checked) {
      mount(status, alertBox('error', t('admin.confirmRequired')));
      return;
    }
    setBusy(submit, true);
    try {
      const message = await run(text);
      if (message !== false) mount(status, alertBox('success', message || t('admin.done')));
      if (reasonEl) reasonEl.value = '';
    } catch (err) {
      mount(status, alertBox('error', errorMessage(err)));
    } finally {
      setBusy(submit, false);
    }
  });
  return h('details', { class: 'p-details' }, h('summary', {}, summary), form);
}

/** Query-string helper for list endpoints (drops empty values). */
export function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export function loadError(host, err) {
  mount(host, alertBox('error', errorMessage(err)));
}

export const auditActionLabel = (a) => {
  const key = `admin.audit.action.${a}`;
  const text = t(key);
  return text === key ? a : text;
};
