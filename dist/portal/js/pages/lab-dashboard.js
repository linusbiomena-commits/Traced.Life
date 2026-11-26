import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { formatDateTime, t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { focusTitle, pageHeading } from '../core/ui.js';
import { table } from './admin-common.js';
import { branchShort, sampleBadge } from './sample-common.js';

// Laboratory dashboard: expected incoming samples (dispatched by branches), samples in the
// laboratory, today's figures. Operational data only: no patient identity, age or gender.
export default async function render({ app }) {
  const [me, d] = await Promise.all([api('GET', '/lab/me'), api('GET', '/lab/dashboard')]);
  const open = (s) => h('a', { href: pageUrl('lab-scan', { sample: s.sampleId }) }, h('span', { class: 'p-ltr', dir: 'ltr' }, s.sampleId));
  const stat = (n, label) => h('div', { class: 'p-card p-stat' }, h('p', { class: 'p-stat__value' }, String(n)), h('p', { class: 'p-muted p-small' }, label));
  mount(app, h('div', { class: 'p-wide' },
    h('div', { class: 'p-row p-row--between' },
      h('div', {}, h('p', { class: 'p-badge p-badge--muted' }, t('lab.portal')), h('div', { class: 'p-mt-s' }, pageHeading(me.operator.name ? t('staff.welcome', { name: me.operator.name.split(' ')[0] }) : t('lab.title'), t('lab.lead')))),
      h('a', { class: 'p-btn p-btn--dark p-btn--lg', href: pageUrl('lab-scan') }, t('lab.scanButton'))),
    h('div', { class: 'p-stack p-mt-m' },
      h('div', { class: 'p-grid p-grid--stats' }, stat(d.incoming.length, t('lab.stat.incoming')), stat(d.inLaboratory.length, t('lab.stat.inLab')),
        stat(d.today.received, t('lab.stat.receivedToday')), stat(d.today.reportsAvailable, t('lab.stat.reportsToday'))),
      h('section', { class: 'p-card', 'aria-labelledby': 'incoming' }, h('h2', { class: 'p-h2', id: 'incoming' }, t('lab.incoming')),
        h('p', { class: 'p-small p-muted p-mt-s' }, t('lab.incomingNote')),
        h('div', { class: 'p-mt-m' }, table([t('label.sampleId'), t('staff.trackingId'), t('admin.col.branch'), t('sample.courier'), t('sample.shipmentTracking'), t('admin.col.status'), t('lab.since')],
          d.incoming.map((s) => [open(s), h('span', { class: 'p-ltr', dir: 'ltr' }, s.trackingId), branchShort(s.branch), s.dispatch?.courier || '–', s.dispatch?.shipmentTrackingNumber ? h('span', { class: 'p-ltr', dir: 'ltr' }, s.dispatch.shipmentTrackingNumber) : '–', sampleBadge(s.status), formatDateTime(s.statusChangedAt)])))),
      h('section', { class: 'p-card', 'aria-labelledby': 'inlab' }, h('h2', { class: 'p-h2', id: 'inlab' }, t('lab.inLab')),
        h('div', { class: 'p-mt-m' }, table([t('label.sampleId'), t('staff.trackingId'), t('admin.col.status'), t('lab.since')],
          d.inLaboratory.map((s) => [open(s), h('span', { class: 'p-ltr', dir: 'ltr' }, s.trackingId), sampleBadge(s.status), formatDateTime(s.statusChangedAt)])))))));
  focusTitle();
}
