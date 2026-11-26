import { api, apiDownload } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { alertBox, errorMessage, setBusy } from '../core/ui.js';
import { adminPage, branchText, card, checkbox, control, input, ltr, select, textarea } from './admin-common.js';

// Personal-data export (Phase 7, super administrators only: report.export_pii). Every export
// needs a reason, a short date range, the columns actually required and a current authenticator
// code. The file goes straight to the browser download; nothing is kept on the server, and the
// audit log records who, why, which columns, how many rows and a fingerprint of the file.
const FIELDS = ['patient_name', 'gender', 'age_at_registration', 'date_of_birth', 'contact_name', 'contact_email', 'contact_phone'];

export default async function render({ app }) {
  let branches = [];
  try {
    branches = (await api('GET', '/admin/branches')).items;
  } catch {
    branches = [];
  }
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(new Date()); // YYYY-MM-DD, Riyadh
  const from = input({ type: 'date', value: today, required: true });
  const to = input({ type: 'date', value: today, required: true });
  const branch = select([['', t('admin.filter.any')], ...branches.map((b) => [b.id, branchText(b)])], '');
  const boxes = FIELDS.map((f) => ({ f, ...checkbox(t(`admin.export.field.${f}`)) }));
  const reason = textarea({ maxlength: 500, rows: 3, required: true, 'aria-required': 'true' });
  const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]{6}', dir: 'ltr', required: true });
  const status = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('admin.export.submit'));
  const form = h('form', { novalidate: true, class: 'p-stack' },
    h('div', { class: 'p-filter-grid' }, control(t('admin.filter.from'), from), control(t('admin.filter.to'), to), control(t('admin.col.branch'), branch)),
    h('fieldset', { class: 'p-field' }, h('legend', { class: 'p-label' }, t('admin.export.fields')),
      h('p', { class: 'p-small p-muted' }, t('admin.export.fieldsHint')), h('div', { class: 'p-checks' }, boxes.map((b) => b.wrap))),
    control(t('admin.reason'), reason, t('admin.export.reasonHint')),
    control(t('admin.export.code'), code, t('admin.export.codeHint')),
    status,
    h('div', { class: 'p-actions' }, submit));
  form.addEventListener('input', () => mount(status)); // stale messages go as soon as the form changes
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(status);
    const fields = boxes.filter((b) => b.box.checked).map((b) => b.f);
    const problems = [
      !from.value || !to.value ? t('admin.export.needDates') : null,
      fields.length ? null : t('admin.export.needFields'),
      reason.value.trim().length < 5 ? t('admin.reasonRequired') : null,
      /^\d{6}$/.test(code.value.trim()) ? null : t('admin.export.needCode'),
    ].filter(Boolean);
    if (problems.length) {
      mount(status, alertBox('error', problems[0]));
      return;
    }
    setBusy(submit, true, t('admin.export.preparing'));
    try {
      const r = await apiDownload('/admin/exports/personal-data', {
        from: from.value, to: to.value, reason: reason.value.trim(), code: code.value.trim(), fields, ...(branch.value ? { branchId: branch.value } : {}),
      });
      mount(status, alertBox('success', t('admin.export.done', { rows: String(r.rows) }), null, h('p', { class: 'p-small' }, t('admin.export.fingerprint'), ' ', ltr(r.sha256.slice(0, 16)))));
      reason.value = '';
    } catch (err) {
      mount(status, alertBox('error', errorMessage(err)));
    } finally {
      code.value = '';
      setBusy(submit, false);
    }
  });
  mount(app, adminPage(t('admin.export.title'), t('admin.export.lead'),
    alertBox('info', t('admin.export.warning')),
    card(t('admin.export.formTitle'), form)));
}
