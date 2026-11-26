import { h } from '../core/dom.js';
import { formatAge, formatDate, lang, statusLabel, t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';

export const SUPPORT_EMAIL = 'LinusBio@karama.tech';
export const SUPPORT_PHONE = '+966 55 141 5599';

export const isCustomer = (session) => session.roles.includes('customer');

export function statusBadge(status) {
  const muted = status === 'cancelled' || status === 'rejected';
  return h('span', { class: `p-badge${muted ? ' p-badge--muted' : ''}` }, statusLabel(status));
}

export function patientName(p) {
  return `${p.firstName} ${p.lastName}`;
}

export function branchName(b) {
  return lang === 'ar' ? `${b.nameAr} – ${b.cityAr}` : `${b.nameEn} – ${b.cityEn}`;
}

/** One registration as a list item (own data only, as returned by the API allowlist). */
export function registrationItem(r) {
  return h('li', { class: 'p-item' },
    h('div', {},
      h('p', { class: 'p-item__title' }, patientName(r.patient)),
      h('p', { class: 'p-item__meta' },
        h('span', {}, formatAge(r.patient.age)),
        h('span', {}, t(`reg.gender.${r.patient.gender}`)),
        h('span', {}, t('list.registered', { date: formatDate(r.createdAt) })))),
    statusBadge(r.status),
    h('div', { class: 'p-item__actions p-row p-row--between' },
      h('span', { class: 'p-small p-muted' }, r.trackingId ? h('span', { class: 'p-ltr' }, r.trackingId) : t('list.trackingPending')),
      h('a', { href: pageUrl('registration', { id: r.id }), 'aria-label': `${t('common.viewDetails')}: ${patientName(r.patient)}` }, t('common.viewDetails'))));
}

export function supportCard() {
  return h('section', { class: 'p-card', 'aria-labelledby': 'help-title' },
    h('h2', { class: 'p-h2', id: 'help-title' }, t('dash.help')),
    h('p', { class: 'p-muted p-mt-s' }, t('dash.helpBody')),
    h('ul', { class: 'p-list p-mt-s' },
      h('li', {}, h('a', { href: `mailto:${SUPPORT_EMAIL}`, class: 'p-ltr' }, SUPPORT_EMAIL)),
      h('li', {}, h('a', { href: `tel:${SUPPORT_PHONE.replace(/\s/g, '')}`, class: 'p-ltr', dir: 'ltr' }, SUPPORT_PHONE)),
      h('li', {}, h('a', { href: lang === 'ar' ? '/ar/traced/pages/faqs/' : '/traced/pages/faqs/' }, t('footer.faqs')))));
}
