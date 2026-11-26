import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, errorMessage, loading } from '../core/ui.js';
import { adminPage, branchText, control, input, ltr, qs, select, table, when } from './admin-common.js';
import { sampleBadge } from './sample-common.js';

const STATUSES = ['collected', 'packaged', 'ready_for_dispatch', 'dispatched', 'in_transit', 'received_by_laboratory', 'analysis_in_progress', 'analysis_completed', 'report_available', 'rejected'];

// Physical samples (chain of custody) for authorised administrators.
export default async function render({ app }) {
  const params = new URLSearchParams(location.search);
  const q = input({ type: 'search', maxlength: 60, dir: 'ltr', value: params.get('q') || '', autocomplete: 'off' });
  const status = select([['', t('admin.filter.any')], ...STATUSES.map((s) => [s, t(`admin.sampleStatus.${s}`)])], params.get('status') || '');
  const branch = select([['', t('admin.filter.any')]], '');
  const from = input({ type: 'date' });
  const to = input({ type: 'date' });
  const counts = h('div', { class: 'p-grid p-grid--stats' });
  const list = h('div', {}, loading());
  try {
    for (const b of (await api('GET', '/admin/stats')).byBranch) branch.append(h('option', { value: b.id }, branchText(b)));
  } catch { /* filter stays empty */ }
  const load = async () => {
    mount(list, loading());
    try {
      const res = await api('GET', `/admin/samples${qs({ q: q.value.trim(), status: status.value, branchId: branch.value, from: from.value, to: to.value })}`);
      mount(counts, ['collected', 'dispatched', 'received_by_laboratory', 'report_available', 'rejected'].map((s) =>
        h('div', { class: 'p-card p-stat' }, h('p', { class: 'p-stat__value' }, String(res.counts[s] || 0)), h('p', { class: 'p-muted p-small' }, t(`admin.sampleStatus.${s}`)))));
      mount(list, table([t('label.sampleId'), t('admin.col.trackingId'), t('admin.col.branch'), t('admin.col.status'), t('staff.collectedAt'), t('lab.since')],
        res.items.map((s) => [h('a', { href: pageUrl('admin-sample', { id: s.id }) }, ltr(s.sampleId)), h('a', { href: pageUrl('admin-registration', { id: s.registrationId }) }, ltr(s.trackingId)),
          branchText(s.branch), sampleBadge(s.status), when(s.collectedAt), when(s.statusChangedAt)]), { caption: t('admin.samples.title') }));
    } catch (err) {
      mount(list, alertBox('error', errorMessage(err)));
    }
  };
  const form = h('form', { class: 'p-filter-grid', novalidate: true }, control(t('admin.samples.search'), q, t('admin.samples.searchHint')), control(t('admin.col.status'), status),
    control(t('admin.col.branch'), branch), control(t('admin.filter.from'), from), control(t('admin.filter.to'), to),
    h('div', { class: 'p-actions' }, h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('admin.search.submit'))));
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  mount(app, adminPage(t('admin.samples.title'), t('admin.samples.lead'), counts, h('div', { class: 'p-card' }, form), list));
  await load();
}
