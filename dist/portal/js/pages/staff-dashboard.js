import { api } from '../core/api.js';
import { h, icon, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, loading, pageHeading } from '../core/ui.js';
import { branchLabel, branchPicker, collectionItem, loadStaff } from './staff-common.js';

// Staff dashboard. Every number comes from the API for the selected, assigned branch.
export default async function render({ app }) {
  const staff = await loadStaff();
  const title = staff.staff.name ? t('staff.welcome', { name: staff.staff.name.split(' ')[0] }) : t('staff.welcomeNoName');
  if (!staff.branch) {
    mount(app, h('div', { class: 'p-medium' }, pageHeading(title), h('div', { class: 'p-card' }, alertBox('info', null, t('staff.noBranch')))));
    return;
  }

  const body = h('div', { class: 'p-stack p-mt-m' });
  const draw = async (branch) => {
    staff.branch = branch;
    mount(body, loading());
    const d = await api('GET', `/staff/dashboard?branchId=${encodeURIComponent(branch.id)}`);
    const stat = (value, label) => h('div', { class: 'p-card p-stat' }, h('p', { class: 'p-stat__value' }, String(value)), h('p', { class: 'p-muted p-small' }, label));
    mount(body,
      h('p', { class: 'p-muted' }, t('staff.dashLead', { branch: branchLabel(d.branch) })),
      h('div', { class: 'p-grid p-grid--stats' },
        stat(d.today.collectedAtBranch, t('staff.stat.atBranch')),
        stat(d.today.collectedByMe, t('staff.stat.byMe')),
        stat(d.today.awaitingAtBranch, t('staff.stat.awaiting'))),
      h('section', { class: 'p-card', 'aria-labelledby': 'recent-title' },
        h('div', { class: 'p-section-title' }, h('h2', { class: 'p-h2', id: 'recent-title' }, t('staff.recent')), h('a', { href: pageUrl('staff-history') }, t('staff.viewHistory'))),
        d.recent.length ? h('ul', { class: 'p-list' }, d.recent.map(collectionItem)) : h('p', { class: 'p-muted' }, t('staff.recentEmpty'))));
  };

  mount(app, h('div', { class: 'p-medium' },
    h('div', { class: 'p-row p-row--between' },
      h('div', {}, h('p', { class: 'p-badge p-badge--muted' }, t('staff.portal')), h('div', { class: 'p-mt-s' }, pageHeading(title))),
      h('a', { class: 'p-btn p-btn--dark p-btn--lg', href: pageUrl('staff-scan') }, icon('clipboard'), t('staff.scanButton'))),
    h('div', { class: 'p-card p-mt-m' }, branchPicker(staff, (b) => draw(b))),
    body));
  await draw(staff.branch);
}
