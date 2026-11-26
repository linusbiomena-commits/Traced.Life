import { api } from '../core/api.js';
import { h, mount, nextId } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { alertBox, errorMessage, loading, pageHeading } from '../core/ui.js';
import { branchLabel, collectionItem, loadStaff } from './staff-common.js';

const STATUSES = ['sample_collected', 'sample_packaged', 'ready_for_dispatch', 'dispatched', 'in_transit', 'received_by_laboratory', 'analysis_in_progress', 'analysis_completed', 'report_available', 'rejected', 'cancelled'];

// Read-only history of collections at the staff member's assigned branches.
export default async function render({ app }) {
  const staff = await loadStaff();
  const results = h('div', { 'aria-live': 'polite' });
  const control = (label, el) => {
    const id = nextId('f');
    el.id = id;
    return h('div', { class: 'p-field' }, h('label', { class: 'p-label', for: id }, label), el);
  };
  const from = h('input', { class: 'p-input', type: 'date' });
  const to = h('input', { class: 'p-input', type: 'date' });
  const branch = h('select', { class: 'p-select' }, h('option', { value: '' }, t('history.allBranches')), staff.branches.map((b) => h('option', { value: b.id }, branchLabel(b))));
  const status = h('select', { class: 'p-select' }, h('option', { value: '' }, t('history.any')), STATUSES.map((s) => h('option', { value: s }, t(`status.${s}`))));
  const tracking = h('input', { class: 'p-input p-ltr', type: 'search', maxlength: 18, autocomplete: 'off', placeholder: 'TRC-SA-MM/YY-XXXXX', 'aria-describedby': 'trk-hint' });
  const form = h('form', { novalidate: true, class: 'p-filters' },
    control(t('history.from'), from), control(t('history.to'), to), control(t('staff.branch'), branch), control(t('history.status'), status),
    h('div', { class: 'p-field' }, h('label', { class: 'p-label', for: (tracking.id = nextId('trk')) }, t('history.tracking')), h('p', { class: 'p-hint', id: 'trk-hint' }, t('history.trackingHint')), tracking),
    h('div', { class: 'p-actions' }, h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('history.apply')),
      h('button', { type: 'reset', class: 'p-btn p-btn--ghost' }, t('history.clear'))));

  let items = [];
  const load = async (before) => {
    if (!before) mount(results, loading());
    const q = new URLSearchParams();
    if (from.value) q.set('from', from.value);
    if (to.value) q.set('to', to.value);
    if (branch.value) q.set('branchId', branch.value);
    if (status.value) q.set('status', status.value);
    if (tracking.value.trim()) q.set('trackingId', tracking.value.trim().toUpperCase());
    if (before) q.set('before', before);
    try {
      const res = await api('GET', `/staff/history?${q.toString()}`);
      items = before ? [...items, ...res.items] : res.items;
      const more = res.nextBefore ? h('button', { type: 'button', class: 'p-btn p-btn--ghost', onclick: () => load(res.nextBefore) }, t('history.more')) : null;
      mount(results, items.length ? h('ul', { class: 'p-list' }, items.map(collectionItem)) : h('p', { class: 'p-muted' }, t('history.empty')), more ? h('div', { class: 'p-actions' }, more) : null);
    } catch (err) {
      mount(results, alertBox('error', errorMessage(err)));
    }
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  form.addEventListener('reset', () => setTimeout(() => load(), 0));

  mount(app, h('div', { class: 'p-medium' },
    h('p', { class: 'p-badge p-badge--muted' }, t('staff.portal')),
    h('div', { class: 'p-mt-s' }, pageHeading(t('history.title'), t('history.lead'))),
    h('section', { class: 'p-card' }, form),
    h('section', { class: 'p-card p-mt-m', 'aria-label': t('history.title') }, results)));
  await load();
}
