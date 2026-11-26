import { api } from '../core/api.js';
import { h, icon, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { formatSaudiMobile } from '../core/rules.js';
import { signOut } from '../core/app.js';
import { alertBox, pageHeading } from '../core/ui.js';
import { isCustomer, patientName, registrationItem, statusBadge, supportCard } from './common.js';

export default async function render({ app, session }) {
  if (!isCustomer(session)) {
    mount(app, h('div', { class: 'p-medium' }, pageHeading(t('dash.titleNoName')),
      h('div', { class: 'p-card' }, alertBox('info', t('dash.staffTitle'), t('dash.staffBody')))));
    return;
  }

  const [{ items }, { profile }] = await Promise.all([api('GET', '/me/registrations'), api('GET', '/me/profile')]);
  const title = profile.fullName ? t('dash.title', { name: profile.fullName.split(' ')[0] }) : t('dash.titleNoName');
  const newButton = h('a', { class: 'p-btn p-btn--dark', href: pageUrl('register') }, icon('plus'), t('dash.newRegistration'));

  const registrations = h('section', { class: 'p-card', 'aria-labelledby': 'regs-title' },
    h('div', { class: 'p-section-title' },
      h('h2', { class: 'p-h2', id: 'regs-title' }, t('dash.myRegistrations')),
      items.length ? h('a', { href: pageUrl('registrations') }, t('dash.viewAll')) : null),
    items.length
      ? h('ul', { class: 'p-list' }, items.slice(0, 3).map(registrationItem))
      : h('div', { class: 'p-empty' },
          h('div', { class: 'p-empty__icon' }, icon('clipboard')),
          h('h3', { class: 'p-h3' }, t('dash.emptyTitle')),
          h('p', { class: 'p-muted p-mt-s' }, t('dash.emptyBody')),
          h('div', { class: 'p-actions' }, h('a', { class: 'p-btn p-btn--primary', href: pageUrl('register') }, t('dash.newRegistration')))));

  const tracking = h('section', { class: 'p-card', 'aria-labelledby': 'tracking-title' },
    h('h2', { class: 'p-h2', id: 'tracking-title' }, t('dash.tracking')),
    h('p', { class: 'p-muted p-mt-s' }, t('dash.trackingBody')),
    items.length
      ? h('ul', { class: 'p-list p-mt-m' }, items.slice(0, 5).map((r) => h('li', { class: 'p-row p-row--between' },
          h('span', {}, patientName(r.patient), ' · ', h('span', { class: 'p-muted p-small' }, r.trackingId || t('common.notIssuedYet'))),
          statusBadge(r.status))))
      : h('p', { class: 'p-muted p-mt-m' }, t('dash.trackingEmpty')));

  const withQr = items.filter((r) => r.qrCode?.available);
  const qr = h('section', { class: 'p-card', 'aria-labelledby': 'qr-title' },
    h('h2', { class: 'p-h2', id: 'qr-title' }, t('dash.qrTitle')),
    h('p', { class: 'p-muted p-mt-s' }, withQr.length ? t('dash.qrBodyActive') : t('dash.qrEmpty')),
    withQr.length
      ? h('ul', { class: 'p-list p-mt-m' }, withQr.slice(0, 4).map((r) => h('li', { class: 'p-qr-row' },
          h('a', { href: pageUrl('registration', { id: r.id }), class: 'p-qr-thumb' },
            h('img', { src: r.qrCode.svgUrl, width: '72', height: '72', alt: t('detail.qrAlt', { id: r.trackingId }) })),
          h('div', {},
            h('p', { class: 'p-item__title' }, patientName(r.patient)),
            h('p', { class: 'p-small p-ltr' }, r.trackingId),
            h('p', { class: 'p-small p-mt-s' }, h('a', { href: `${r.qrCode.pngUrl}?download=1`, download: '' }, t('dash.downloadQr')))))))
      : null);

  const profileCard = h('section', { class: 'p-card', 'aria-labelledby': 'profile-title' },
    h('h2', { class: 'p-h2', id: 'profile-title' }, t('dash.profile')),
    h('dl', { class: 'p-dl p-mt-m' },
      h('dt', {}, t('field.email')), h('dd', { class: 'p-ltr' }, profile.email),
      profile.fullName ? [h('dt', {}, t('field.fullName')), h('dd', {}, profile.fullName)] : null,
      profile.phone ? [h('dt', {}, t('field.mobile')), h('dd', { dir: 'ltr' }, formatSaudiMobile(profile.phone))] : null),
    !profile.fullName || !profile.phone ? h('p', { class: 'p-muted p-small p-mt-s' }, t('dash.profileEmpty')) : null,
    h('div', { class: 'p-actions' },
      h('a', { class: 'p-btn p-btn--ghost', href: pageUrl('settings') }, t('dash.manageSettings')),
      h('button', { type: 'button', class: 'p-btn p-btn--ghost', onclick: signOut }, t('nav.signOut'))));

  mount(app,
    h('div', { class: 'p-row p-row--between' }, h('div', {}, pageHeading(title, t('dash.lead'))), newButton),
    h('div', { class: 'p-stack p-mt-m' }, registrations, h('div', { class: 'p-grid' }, tracking, qr), h('div', { class: 'p-grid' }, profileCard, supportCard())));
}
