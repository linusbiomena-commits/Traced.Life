import { api } from '../core/api.js';
import { h, icon, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, pageHeading } from '../core/ui.js';
import { isCustomer, registrationItem } from './common.js';

export default async function render({ app, session }) {
  if (!isCustomer(session)) {
    mount(app, alertBox('info', t('dash.staffTitle'), t('dash.staffBody')));
    return;
  }
  const { items } = await api('GET', '/me/registrations');
  mount(app, h('div', { class: 'p-medium' },
    h('div', { class: 'p-row p-row--between' }, h('div', {}, pageHeading(t('list.title'), t('list.lead'))),
      h('a', { class: 'p-btn p-btn--dark', href: pageUrl('register') }, icon('plus'), t('dash.newRegistration'))),
    h('section', { class: 'p-card p-mt-m', 'aria-label': t('list.title') },
      items.length
        ? h('ul', { class: 'p-list' }, items.map(registrationItem))
        : h('div', { class: 'p-empty' },
            h('div', { class: 'p-empty__icon' }, icon('clipboard')),
            h('h2', { class: 'p-h3' }, t('dash.emptyTitle')),
            h('p', { class: 'p-muted p-mt-s' }, t('dash.emptyBody'))))));
}
