import { api, ApiError } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { formatAge, formatDate, formatDateTime, lang, statusLabel, t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { dateOfBirthProblem, formatSaudiMobile, isValidName, normaliseName, riyadhToday } from '../core/rules.js';
import { alertBox, choiceGroup, errorMessage, field, focusTitle, pageHeading, setBusy, validate } from '../core/ui.js';
import { branchName, patientName, statusBadge } from './common.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function section(id, title, ...content) {
  return h('section', { class: 'p-card', 'aria-labelledby': id }, h('h2', { class: 'p-h2', id }, title), h('div', { class: 'p-mt-m' }, content));
}

function dl(rows) {
  return h('dl', { class: 'p-dl' }, rows.filter(Boolean).map(([k, v, attrs]) => [h('dt', {}, k), h('dd', attrs || {}, v)]));
}

export default async function render({ app, session }) {
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

  const draw = (registration, notice) => {
    r = registration;
    mount(app, view(notice));
  };

  // ---- QR card: image, downloads, resend, replace -------------------------------------------
  function qrCard() {
    if (!r.qrCode?.available) {
      if (r.collection) {
        return section('qr-title', t('detail.qr'),
          alertBox('success', null, t('detail.collected', { date: formatDateTime(r.collection.collectedAt), branch: branchName({ ...r.collection.branch }) })),
          h('p', { class: 'p-muted p-small p-mt-s' }, t('detail.qrUsed')),
          h('p', { class: 'p-mt-s' }, t('detail.trackingId'), ': ', h('span', { class: 'p-tracking-id', dir: 'ltr' }, r.trackingId)));
      }
      return section('qr-title', t('detail.qr'), h('p', { class: 'p-muted' }, t('common.notAvailableYet')));
    }
    const status = h('div', { 'aria-live': 'polite' });
    const cacheBust = encodeURIComponent(r.qrCode.issuedAt || '');
    const img = h('img', {
      class: 'p-qr', src: `${r.qrCode.svgUrl}?v=${cacheBust}`, width: '240', height: '240',
      alt: t('detail.qrAlt', { id: r.trackingId }),
    });

    const resend = h('button', { type: 'button', class: 'p-btn p-btn--ghost' }, t('detail.resendEmail'));
    resend.addEventListener('click', async () => {
      setBusy(resend, true);
      try {
        await api('POST', `/me/registrations/${r.id}/resend-email`, {});
        mount(status, alertBox('success', t('detail.resent', { email: r.contact.email })));
      } catch (err) {
        mount(status, alertBox('error', errorMessage(err)));
      } finally {
        setBusy(resend, false);
      }
    });

    const emailState = r.email ? h('p', { class: `p-small p-mt-s ${r.email.status === 'failed' ? '' : 'p-muted'}` }, t(`detail.emailStatus.${r.email.status}`)) : null;

    let regen = null;
    if (r.canRegenerateQr) {
      const confirm = h('button', { type: 'button', class: 'p-btn p-btn--dark', hidden: true }, t('detail.regenerateConfirm'));
      const start = h('button', { type: 'button', class: 'p-linkbtn' }, t('detail.regenerate'));
      start.addEventListener('click', () => {
        start.hidden = true;
        confirm.hidden = false;
        confirm.focus();
      });
      confirm.addEventListener('click', async () => {
        setBusy(confirm, true);
        try {
          const res = await api('POST', `/me/registrations/${r.id}/qr/regenerate`, {});
          draw(res.registration, alertBox('success', t('detail.regenerated')));
        } catch (err) {
          setBusy(confirm, false);
          mount(status, alertBox('error', errorMessage(err)));
        }
      });
      regen = h('div', { class: 'p-review-section' },
        h('h3', { class: 'p-h3' }, t('detail.regenerateTitle')),
        h('p', { class: 'p-muted p-small p-mt-s' }, t('detail.regenerateBody')),
        h('div', { class: 'p-mt-s' }, start, confirm));
    }

    return h('section', { class: 'p-card', 'aria-labelledby': 'qr-title' },
      h('h2', { class: 'p-h2', id: 'qr-title' }, t('detail.qr')),
      h('div', { class: 'p-qr-layout p-mt-m' },
        h('div', { class: 'p-qr-frame' }, img),
        h('div', {},
          h('p', { class: 'p-muted p-small' }, t('detail.trackingId')),
          h('p', { class: 'p-tracking-id', dir: 'ltr' }, r.trackingId),
          h('p', { class: 'p-mt-s' }, t('detail.qrHelp')),
          h('div', { class: 'p-actions' },
            h('a', { class: 'p-btn p-btn--dark', href: `${r.qrCode.pngUrl}?download=1`, download: '' }, t('detail.downloadPng')),
            h('a', { class: 'p-btn p-btn--ghost', href: `${r.qrCode.svgUrl}?download=1`, download: '' }, t('detail.downloadSvg'))),
          h('div', { class: 'p-actions' }, resend),
          emailState,
          status)),
      regen);
  }

  // ---- Patient details + protected correction ------------------------------------------------
  function patientCard() {
    const rel = { self: t('reg.rel.self'), child: t('reg.rel.child'), authorized_dependent: t('reg.rel.dependent') }[r.patient.relationship];
    const status = h('div', { 'aria-live': 'polite' });
    const body = h('div', {}, dl([
      [t('detail.name'), patientName(r.patient)],
      [t('reg.relationship'), rel],
      [t('reg.dob'), formatDate(r.patient.dateOfBirth)],
      [t('detail.age'), formatAge(r.patient.age)],
      [t('reg.gender'), t(`reg.gender.${r.patient.gender}`)],
    ]));
    let tools;
    if (r.canCorrectPatient) {
      const open = h('button', { type: 'button', class: 'p-btn p-btn--ghost' }, t('detail.correctOpen'));
      open.addEventListener('click', () => mount(body, correctionForm(status)));
      tools = h('div', { class: 'p-review-section' }, h('h3', { class: 'p-h3' }, t('detail.correctTitle')),
        h('p', { class: 'p-muted p-small p-mt-s' }, t('detail.correctLead')), h('div', { class: 'p-actions' }, open));
    } else {
      tools = h('p', { class: 'p-muted p-small p-mt-m' }, t('detail.correctLocked'));
    }
    return section('patient-title', t('detail.patient'), status, body, tools);
  }

  function correctionForm(status) {
    const summary = h('div');
    const first = field({ label: t('reg.firstName'), name: 'given-name', value: r.patient.firstName, maxlength: 100, autocomplete: 'off' });
    const last = field({ label: t('reg.lastName'), name: 'family-name', value: r.patient.lastName, maxlength: 100, autocomplete: 'off' });
    const today = riyadhToday();
    const dob = field({ label: t('reg.dob'), name: 'bday', type: 'date', value: r.patient.dateOfBirth, min: '1900-01-01', max: today, autocomplete: 'off' });
    const gender = choiceGroup({ legend: t('reg.gender'), name: 'gender', value: r.patient.gender, inline: true, options: [{ value: 'female', label: t('reg.gender.female') }, { value: 'male', label: t('reg.gender.male') }] });
    const reason = field({ label: t('detail.reason'), name: 'reason', required: false, maxlength: 500 });
    const save = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('detail.correctSave'));
    const cancel = h('button', { type: 'button', class: 'p-btn p-btn--ghost', onclick: () => draw(r) }, t('common.back'));
    const form = h('form', { novalidate: true }, summary, first.wrap, last.wrap, dob.wrap, h('div', { class: 'p-mt-m' }, gender.wrap), reason.wrap, h('div', { class: 'p-actions p-actions--split' }, cancel, save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fn = normaliseName(first.input.value);
      const ln = normaliseName(last.input.value);
      const p = dob.input.value ? dateOfBirthProblem(dob.input.value, r.patient.relationship, today) : 'INVALID_DATE';
      const dobMsg = { INVALID_DATE: t('v.dob'), FUTURE_DATE: t('v.dobFuture'), TOO_OLD: t('v.dobOld'), CHILD_MUST_BE_UNDER_18: t('v.dobChild'), SELF_MUST_BE_ADULT: t('v.dobSelf') }[p] || null;
      const ok = validate(summary, [
        [first, isValidName(fn) ? null : t('v.name')],
        [last, isValidName(ln) ? null : t('v.name')],
        [dob, dobMsg],
        [gender, gender.value ? null : t('v.requiredChoice')],
      ]);
      if (!ok) return;
      setBusy(save, true, t('common.saving'));
      try {
        const res = await api('PATCH', `/me/registrations/${r.id}/patient`, {
          patient: { firstName: fn, lastName: ln, dateOfBirth: dob.input.value, gender: gender.value },
          ...(reason.input.value.trim() ? { reason: reason.input.value.trim() } : {}),
        });
        draw(res.registration, alertBox('success', res.changed.length ? t('detail.corrected') : t('detail.noChanges')));
      } catch (err) {
        setBusy(save, false);
        mount(status, alertBox('error', errorMessage(err)));
      }
    });
    return form;
  }

  function view(notice) {
    const addr = lang === 'ar' ? r.branch.addressAr : r.branch.addressEn;
    return h('div', { class: 'p-medium' },
      pageHeading(created ? t('detail.successTitle') : t('detail.title'), created ? t('detail.successBody') : null),
      notice || null,
      h('div', { class: 'p-stack p-mt-m' },
        qrCard(),
        section('status-title', t('detail.status'),
          h('div', { class: 'p-row' }, statusBadge(r.status)),
          dl([
            [t('detail.trackingId'), r.trackingId ? h('span', { class: 'p-ltr' }, r.trackingId) : h('span', { class: 'p-muted' }, t('common.notIssuedYet'))],
            [t('detail.registeredOn'), formatDate(r.createdAt)],
            [t('reg.branch'), branchName(r.branch)],
          ]),
          h('h3', { class: 'p-h3 p-mt-m' }, t('detail.history')),
          // Phase 6: simplified sample journey (dates only), falling back to status history.
          r.timeline && r.timeline.length
            ? h('ol', { class: 'p-timeline p-mt-s' }, r.timeline.map((s) => h('li', {}, t(`timeline.${s.step}`), ' · ', h('span', { class: 'p-muted p-small' }, formatDateTime(s.at)))))
            : h('ol', { class: 'p-timeline p-mt-s' }, r.statusHistory.map((s) => h('li', {}, statusLabel(s.status), ' · ', h('span', { class: 'p-muted p-small' }, formatDateTime(s.at))))),
          r.timeline?.some((s) => s.step === 'sample_issue') && !r.timeline.some((s) => s.step === 'recollection_required') ? alertBox('info', null, t('timeline.issueNote')) : null,
          r.timeline?.at(-1)?.step === 'recollection_required' ? alertBox('info', null, t('timeline.recollectNote')) : null),
        section('instructions-title', t('detail.instructions'),
          h('ol', { class: 'p-steps-list' }, [1, 2, 3].map((n) => h('li', {}, t(`instr.${n}`))))),
        patientCard(),
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
        ]), r.branchChangedAt && !r.collection ? alertBox('info', null, t('detail.branchChanged', { date: formatDateTime(r.branchChangedAt) })) : null),
        section('consents-title', t('detail.consents'), h('ul', { class: 'p-list' }, r.consents.map((c) => h('li', { class: 'p-item' },
          h('div', {}, h('p', { class: 'p-item__title' }, c.title),
            h('p', { class: 'p-item__meta' }, h('span', {}, t('detail.version', { v: c.version })), h('span', {}, t('detail.acceptedOn', { date: formatDate(c.acceptedAt) })))),
          c.provisional ? h('span', { class: 'p-badge p-badge--warning' }, t('common.provisional')) : h('span', { class: 'p-badge' }, t('reg.accepted'))))))),
      back);
  }

  draw(r);
  if (created) focusTitle();

  // While the registration awaits collection, refresh quietly so the page updates on its own
  // once staff confirm the collection (only when the tab is visible).
  const poll = setInterval(async () => {
    if (document.hidden || r.status !== 'awaiting_sample_collection') return;
    try {
      const fresh = (await api('GET', `/me/registrations/${r.id}`)).registration;
      if (fresh.status !== r.status) draw(fresh);
    } catch {
      /* ignore transient errors; the next tick retries */
    }
  }, 20_000);
  window.addEventListener('pagehide', () => clearInterval(poll));
  void session;
}
