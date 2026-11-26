import { api, ApiError } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { formatAge, formatDate, formatDateTime, lang, statusLabel, t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { formatSaudiMobile } from '../core/rules.js';
import { alertBox, focusTitle, pageHeading } from '../core/ui.js';
import { branchName, patientName, statusBadge } from './common.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function section(id, title, ...content) {
  return h('section', { class: 'p-card', 'aria-labelledby': id }, h('h2', { class: 'p-h2', id }, title), h('div', { class: 'p-mt-m' }, content));
}

function dl(rows) {
  return h('dl', { class: 'p-dl' }, rows.filter(Boolean).map(([k, v, attrs]) => [h('dt', {}, k), h('dd', attrs || {}, v)]));
}

export default async function render({ app }) {
  const params = new URLSearchParams(location.search);
  const id = params.get('id') || '';
  const created = params.get('created') === '1';
  if (created) history.replaceState(null, '', `${location.pathname}?id=${encodeURIComponent(id)}`);

  const back = h('p', { class: 'p-mt-m' }, h('a', { href: pageUrl('registrations') }, t('detail.backToList')));
  let r;
  try {
    if (!UUID_RE.test(id)) throw new ApiError(404, 'NOT_FOUND');
    r = (await api('GET', `/me/registrations/${id}`)).registration;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      mount(app, h('div', { class: 'p-medium' }, pageHeading(t('detail.title')), alertBox('error', t('detail.notFound')), back));
      return;
    }
    throw err;
  }

  const rel = { self: t('reg.rel.self'), child: t('reg.rel.child'), authorized_dependent: t('reg.rel.dependent') }[r.patient.relationship];
  const addr = lang === 'ar' ? r.branch.addressAr : r.branch.addressEn;

  mount(app, h('div', { class: 'p-medium' },
    pageHeading(created ? t('detail.createdTitle') : t('detail.title'), created ? t('detail.createdBody') : null),
    created ? alertBox('success', null, t('detail.phaseNote')) : null,
    h('div', { class: 'p-stack p-mt-m' },
      section('status-title', t('detail.status'),
        h('div', { class: 'p-row' }, statusBadge(r.status)),
        dl([
          [t('detail.trackingId'), r.trackingId ? h('span', { class: 'p-ltr' }, r.trackingId) : h('span', { class: 'p-muted' }, t('common.notIssuedYet'))],
          [t('detail.qr'), h('span', { class: 'p-muted' }, t('common.notAvailableYet'))],
          [t('detail.registeredOn'), formatDate(r.createdAt)],
        ]),
        h('h3', { class: 'p-h3 p-mt-m' }, t('detail.history')),
        h('ol', { class: 'p-timeline p-mt-s' }, r.statusHistory.map((s) => h('li', {}, statusLabel(s.status), ' · ', h('span', { class: 'p-muted p-small' }, formatDateTime(s.at)))))),
      section('patient-title', t('detail.patient'), dl([
        [t('detail.name'), patientName(r.patient)],
        [t('reg.relationship'), rel],
        [t('reg.dob'), formatDate(r.patient.dateOfBirth)],
        [t('detail.age'), formatAge(r.patient.age)],
        [t('reg.gender'), t(`reg.gender.${r.patient.gender}`)],
      ])),
      section('contact-title', t('detail.contact'), dl([
        [t('field.fullName'), r.contact.fullName],
        [t('field.email'), r.contact.email, { class: 'p-ltr' }],
        [t('field.mobile'), formatSaudiMobile(r.contact.phone), { dir: 'ltr' }],
      ])),
      section('collection-title', t('detail.collection'), dl([
        [t('reg.product'), t('reg.productValue')],
        [t('reg.sampleType'), t('reg.sampleValue')],
        [t('reg.country'), t('reg.countryValue')],
        [t('reg.branch'), branchName(r.branch)],
        addr ? ['', addr] : null,
      ])),
      section('consents-title', t('detail.consents'), h('ul', { class: 'p-list' }, r.consents.map((c) => h('li', { class: 'p-item' },
        h('div', {}, h('p', { class: 'p-item__title' }, c.title),
          h('p', { class: 'p-item__meta' }, h('span', {}, t('detail.version', { v: c.version })), h('span', {}, t('detail.acceptedOn', { date: formatDate(c.acceptedAt) })))),
        c.provisional ? h('span', { class: 'p-badge p-badge--warning' }, t('common.provisional')) : h('span', { class: 'p-badge' }, t('reg.accepted'))))))),
    back));
  if (created) focusTitle();
}
