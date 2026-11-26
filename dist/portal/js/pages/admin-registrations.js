import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { statusLabel, t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, errorMessage, loading } from '../core/ui.js';
import { adminPage, ageText, branchText, control, genderText, input, ltr, qs, select, statusBadge, table, when } from './admin-common.js';

const STATUSES = ['registration_completed', 'awaiting_sample_collection', 'sample_collected', 'sample_packaged', 'ready_for_dispatch', 'dispatched',
  'in_transit', 'received_by_laboratory', 'analysis_in_progress', 'analysis_completed', 'report_available', 'rejected', 'cancelled'];

// Registration search for authorised administrators (registration.read_full). Every search is
// audited on the server by a keyed hash of the term, never the term itself.
export default async function render({ app }) {
  const params = new URLSearchParams(location.search);
  const q = input({ type: 'search', name: 'q', maxlength: 200, value: params.get('q') || '', autocomplete: 'off' });
  const type = select([['auto', t('admin.search.auto')], ['tracking', t('admin.search.tracking')], ['name', t('admin.search.name')], ['email', t('admin.search.email')], ['phone', t('admin.search.phone')]], 'auto');
  const status = select([['', t('admin.filter.any')], ...STATUSES.map((s) => [s, statusLabel(s)])], params.get('status') || '');
  const qr = select([['', t('admin.filter.any')], ['active', t('admin.qr.active')], ['revoked', t('admin.qr.revoked')], ['used', t('admin.qr.used')], ['none', t('admin.qr.none')]], '');
  const branch = select([['', t('admin.filter.any')]], '');
  const from = input({ type: 'date' });
  const to = input({ type: 'date' });
  const results = h('div', {}, loading());
  const more = h('button', { type: 'button', class: 'p-btn p-btn--ghost', hidden: true }, t('admin.loadMore'));
  let cursor = null;
  let rows = [];

  try {
    const stats = await api('GET', '/admin/stats');
    for (const b of stats.byBranch) branch.append(h('option', { value: b.id, selected: b.id === params.get('branchId') || undefined }, branchText(b)));
  } catch {
    /* branch filter simply stays empty */
  }

  const row = (r) => [
    h('a', { href: pageUrl('admin-registration', { id: r.id }) }, ltr(r.trackingId)),
    `${r.patient.firstName} ${r.patient.lastName}`,
    `${ageText(r.patient.age)} · ${genderText(r.patient.gender)}`,
    r.contactName,
    branchText(r.branch),
    statusBadge(r.status),
    t(`admin.qr.${r.qrStatus}`),
    when(r.createdAt),
  ];
  const headers = [t('admin.col.trackingId'), t('admin.col.patient'), t('admin.col.ageGender'), t('admin.col.contact'), t('admin.col.branch'), t('admin.col.status'), t('admin.col.qr'), t('admin.col.registered')];

  const run = async (append) => {
    if (!append) {
      cursor = null;
      rows = [];
      mount(results, loading());
    }
    try {
      const res = await api('GET', `/admin/registrations${qs({ q: q.value.trim(), type: type.value, status: status.value, qrStatus: qr.value, branchId: branch.value, from: from.value, to: to.value, cursor, limit: 25 })}`);
      rows = rows.concat(res.items);
      cursor = res.nextCursor;
      more.hidden = !cursor;
      mount(results, h('p', { class: 'p-small p-muted' }, t('admin.search.count', { n: rows.length })), table(headers, rows.map(row), { caption: t('admin.reg.title') }));
    } catch (err) {
      mount(results, alertBox('error', errorMessage(err)));
    }
  };
  more.addEventListener('click', () => run(true));
  const form = h('form', { novalidate: true, role: 'search', class: 'p-stack' },
    h('div', { class: 'p-filter-grid' },
      control(t('admin.search.label'), q, t('admin.search.hint')), control(t('admin.search.type'), type),
      control(t('admin.col.status'), status), control(t('admin.col.qr'), qr), control(t('admin.col.branch'), branch),
      control(t('admin.filter.from'), from), control(t('admin.filter.to'), to)),
    h('div', { class: 'p-actions' }, h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('admin.search.submit'))));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    run(false);
  });

  mount(app, adminPage(t('admin.reg.title'), t('admin.reg.lead'),
    h('div', { class: 'p-card' }, form),
    h('div', { class: 'p-alert p-alert--info', role: 'note' }, h('div', {}, h('p', {}, t('admin.privacyNote')))),
    results, h('div', { class: 'p-actions' }, more)));
  await run(false);
}
