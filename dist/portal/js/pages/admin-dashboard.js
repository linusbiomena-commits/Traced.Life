import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { statusLabel, t } from '../core/i18n.js';
import { can } from '../core/app.js';
import { pageUrl } from '../core/paths.js';
import { loading } from '../core/ui.js';
import { adminPage, auditActionLabel, branchText, card, control, input, loadError, qs, roleLabel, table, when } from './admin-common.js';

// Admin dashboard: every figure is a live database aggregate from GET /admin/stats (no personal
// data). Days and months follow Asia/Riyadh.
export default async function render({ app, session }) {
  const from = input({ type: 'date', name: 'from' });
  const to = input({ type: 'date', name: 'to' });
  const apply = h('button', { type: 'submit', class: 'p-btn p-btn--ghost' }, t('admin.filter.apply'));
  const exportLink = h('a', { class: 'p-btn p-btn--ghost', href: '#', download: '' }, t('admin.dash.export'));
  const body = h('div', { class: 'p-stack' }, loading());
  const filters = h('form', { class: 'p-filter-grid', novalidate: true }, control(t('admin.filter.from'), from), control(t('admin.filter.to'), to),
    h('div', { class: 'p-actions' }, apply, can(session, 'report.export') ? exportLink : null));

  const stat = (value, label, href) => h('div', { class: 'p-card p-stat' },
    h('p', { class: 'p-stat__value' }, String(value)), h('p', { class: 'p-muted p-small' }, href ? h('a', { href }, label) : label));

  const draw = async () => {
    mount(body, loading());
    let d;
    try {
      d = await api('GET', `/admin/stats${qs({ from: from.value, to: to.value })}`);
    } catch (err) {
      return loadError(body, err);
    }
    if (!from.value) from.value = d.range.from;
    if (!to.value) to.value = d.range.to;
    exportLink.href = `/api/v1/admin/reports/operational.csv${qs({ from: d.range.from, to: d.range.to })}`;
    const regs = can(session, 'registration.read_full');
    const max = Math.max(1, ...d.statusDistribution.map((s) => s.count));
    const bar = (n) => {
      const fill = h('div', { class: 'p-bar__fill' });
      fill.style.width = `${Math.round((n / max) * 100)}%`; // CSSOM (allowed by the CSP), not an inline style attribute
      return h('div', { class: 'p-bar', 'aria-hidden': 'true' }, fill);
    };
    mount(body,
      h('div', { class: 'p-grid p-grid--stats' },
        stat(d.totals.customers, t('admin.dash.customers')),
        stat(d.totals.registrations, t('admin.dash.registrations'), regs ? pageUrl('admin-registrations') : null),
        stat(d.totals.awaitingCollection, t('admin.dash.awaiting')),
        stat(d.totals.samplesCollected, t('admin.dash.collected')),
        stat(d.totals.activeStaff, t('admin.dash.activeStaff')),
        stat(d.totals.activeBranches, t('admin.dash.activeBranches')),
        stat(d.totals.emailFailures, t('admin.dash.emailFailures'), can(session, 'email.manage') ? `${pageUrl('admin-emails')}?status=failed` : null)),
      card(t('admin.dash.periods'), table(
        [t('admin.dash.period'), t('admin.dash.registrations'), t('admin.dash.collections')],
        [
          [t('admin.dash.today'), String(d.todayCounts.registrations), String(d.todayCounts.collections)],
          [t('admin.dash.thisMonth'), String(d.monthCounts.registrations), String(d.monthCounts.collections)],
          [t('admin.dash.selectedRange', { from: d.range.from, to: d.range.to }), String(d.rangeCounts.registrations), String(d.rangeCounts.collections)],
        ], { numeric: [1, 2], caption: t('admin.dash.periods') })),
      card(t('admin.dash.statuses'), d.statusDistribution.length
        ? table([t('admin.col.status'), t('admin.col.count'), ''], d.statusDistribution.map((s) => [statusLabel(s.status), String(s.count), bar(s.count)]), { numeric: [1] })
        : h('p', { class: 'p-muted' }, t('admin.empty'))),
      card(t('admin.dash.byBranch'), table(
        [t('admin.col.branch'), t('admin.col.active'), t('admin.dash.registrations'), t('admin.dash.awaiting'), t('admin.dash.collected'), t('admin.dash.collectedRange')],
        d.byBranch.map((b) => [branchText(b), t(b.active ? 'admin.yes' : 'admin.no'), String(b.registrations), String(b.awaiting), String(b.collected), String(b.collectedInRange)]),
        { numeric: [2, 3, 4, 5] })),
      d.recentActivity ? card(t('admin.dash.activity'), table(
        [t('admin.col.time'), t('admin.col.event'), t('admin.col.role'), t('admin.col.outcome')],
        d.recentActivity.map((a) => [when(a.occurredAt), auditActionLabel(a.action), a.actorRole ? roleLabel(a.actorRole) : '–', t(`admin.outcome.${a.outcome}`)])),
        can(session, 'audit.read') ? h('p', { class: 'p-mt-s' }, h('a', { href: pageUrl('admin-audit') }, t('admin.dash.fullAudit'))) : null) : null,
      h('p', { class: 'p-small p-muted' }, t('admin.dash.generated', { time: when(d.generatedAt) })));
  };
  filters.addEventListener('submit', (e) => {
    e.preventDefault();
    draw();
  });

  mount(app, adminPage(t('admin.dash.title'), t('admin.dash.lead'), h('div', { class: 'p-card' }, filters), body));
  await draw();
}
