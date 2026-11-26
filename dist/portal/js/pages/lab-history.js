import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { formatDateTime, t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, errorMessage, focusTitle, loading, pageHeading } from '../core/ui.js';
import { control, input, qs, select, table } from './admin-common.js';
import { sampleBadge } from './sample-common.js';

const STATUSES = ['received_by_laboratory', 'analysis_in_progress', 'analysis_completed', 'report_available', 'rejected'];

// Samples the laboratory has handled (operational data only).
export default async function render({ app }) {
  const status = select([['', t('admin.filter.any')], ...STATUSES.map((s) => [s, t(`admin.sampleStatus.${s}`)])], '');
  const sampleId = input({ maxlength: 40, dir: 'ltr', autocomplete: 'off' });
  const list = h('div', {}, loading());
  const load = async () => {
    mount(list, loading());
    try {
      const { items } = await api('GET', `/lab/history${qs({ status: status.value, sampleId: sampleId.value.trim() })}`);
      mount(list, table([t('label.sampleId'), t('staff.trackingId'), t('admin.col.branch'), t('admin.col.status'), t('lab.lastEvent')],
        items.map((s) => [h('a', { href: pageUrl('lab-scan', { sample: s.sampleId }) }, h('span', { class: 'p-ltr', dir: 'ltr' }, s.sampleId)), h('span', { class: 'p-ltr', dir: 'ltr' }, s.trackingId), s.branchCode, sampleBadge(s.status), formatDateTime(s.lastLaboratoryEventAt)])));
    } catch (err) {
      mount(list, alertBox('error', errorMessage(err)));
    }
  };
  const form = h('form', { class: 'p-filter-grid', novalidate: true }, control(t('admin.col.status'), status), control(t('label.sampleId'), sampleId),
    h('div', { class: 'p-actions' }, h('button', { type: 'submit', class: 'p-btn p-btn--ghost' }, t('admin.filter.apply'))));
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  mount(app, h('div', { class: 'p-wide' }, h('p', { class: 'p-badge p-badge--muted' }, t('lab.portal')),
    h('div', { class: 'p-mt-s' }, pageHeading(t('lab.historyTitle'))), h('div', { class: 'p-stack p-mt-m' }, h('div', { class: 'p-card' }, form), list)));
  focusTitle();
  await load();
}
