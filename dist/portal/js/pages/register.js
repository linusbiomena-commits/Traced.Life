import { api, ApiError, newIdempotencyKey } from '../core/api.js';
import { h, mount, nextId } from '../core/dom.js';
import { formatAge, formatDate, lang, t } from '../core/i18n.js';
import { go, pageUrl } from '../core/paths.js';
import {
  ageParts, dateOfBirthProblem, formatSaudiMobile, isValidName, MIN_DATE_OF_BIRTH, normaliseName, normaliseSaudiMobile, requiredConsentTypes,
} from '../core/rules.js';
import { alertBox, choiceGroup, errorMessage, field, setBusy, validate } from '../core/ui.js';
import { branchName, isCustomer } from './common.js';

const TOTAL = 5;

export default async function render({ app, session }) {
  if (!isCustomer(session)) {
    mount(app, alertBox('info', t('dash.staffTitle'), t('dash.staffBody')));
    return;
  }

  let config;
  try {
    config = await api('GET', `/me/registration-form?locale=${lang}`);
  } catch (err) {
    mount(app, h('div', { class: 'p-medium' }, h('h1', { class: 'p-h1' }, t('reg.title')), alertBox('error', errorMessage(err))));
    return;
  }
  if (!config.branches.length) {
    mount(app, h('div', { class: 'p-medium' }, h('h1', { class: 'p-h1' }, t('reg.title')), alertBox('info', t('reg.noBranches'))));
    return;
  }

  // All answers live in memory only (not in storage), and leave with the page.
  const state = {
    step: 1,
    relationship: null,
    patient: { firstName: '', lastName: '', dateOfBirth: '', gender: null },
    contact: { fullName: config.profile.fullName || '', phone: config.profile.phone ? formatSaudiMobile(config.profile.phone) : '' },
    saveToProfile: true,
    branchId: config.branches.length === 1 ? config.branches[0].id : null,
    accepted: new Set(),
    idempotencyKey: newIdempotencyKey(), // kept for retries so a resubmission can't duplicate
    submitted: false,
    dirty: false,
  };

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty && !state.submitted) {
      e.preventDefault();
      e.returnValue = t('reg.leaveWarning');
    }
  });

  const container = h('div', { class: 'p-medium' });
  mount(app, container);

  const stepTitles = () => [
    t('reg.step1'),
    state.relationship === 'child' ? t('reg.step2Child') : t('reg.step2'),
    t('reg.step3'),
    t('reg.step4'),
    t('reg.step5'),
  ];

  function progress() {
    const labels = [1, 2, 3, 4, 5].map((n) => t(`reg.stepLabel${n}`));
    return h('ol', { class: 'p-steps', 'aria-label': t('reg.stepOf', { n: Math.min(state.step, TOTAL), total: TOTAL }) },
      labels.map((label, i) => {
        const n = i + 1;
        const st = n < state.step ? 'done' : n === state.step || (state.step > TOTAL && n === TOTAL) ? 'current' : 'todo';
        return h('li', { dataset: { state: st }, 'aria-current': st === 'current' ? 'step' : undefined },
          h('span', { class: 'p-steps__bar' }), h('span', { class: 'p-steps__label' }, label));
      }));
  }

  function shell(title, body, actions, { isReview = false } = {}) {
    const stepText = isReview ? t('reg.review') : t('reg.stepOf', { n: state.step, total: TOTAL });
    mount(container,
      h('p', { class: 'p-muted p-small' }, t('reg.title')),
      h('h1', { class: 'p-h1', id: 'page-title', tabindex: '-1' }, title),
      h('p', { class: 'p-muted p-small p-mt-s' }, isReview ? t('reg.reviewLead') : stepText),
      h('div', { class: 'p-mt-m' }, progress()),
      h('div', { class: 'p-card' }, body, actions));
    document.title = `${title} | TRACED`;
    document.getElementById('page-title').focus();
    window.scrollTo({ top: 0 });
  }

  function nav(onNext, { nextLabel = t('common.continue'), backTo } = {}) {
    const next = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, nextLabel);
    const back = state.step > 1 || backTo
      ? h('button', { type: 'button', class: 'p-btn p-btn--ghost', onclick: () => show(backTo ?? state.step - 1) }, t('common.back'))
      : h('a', { class: 'p-btn p-btn--ghost', href: pageUrl('dashboard') }, t('common.back'));
    return { next, row: h('div', { class: 'p-actions p-actions--split' }, back, next) };
  }

  function form(children, onSubmit) {
    const f = h('form', { novalidate: true }, children);
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      onSubmit();
    });
    f.addEventListener('input', () => { state.dirty = true; });
    return f;
  }

  // ---- Step 1: relationship ----------------------------------------------------------------
  function step1() {
    const summary = h('div');
    const group = choiceGroup({
      legend: t('reg.rel.legend'), name: 'relationship', value: state.relationship,
      options: [
        { value: 'self', label: t('reg.rel.self'), description: t('reg.rel.selfDesc') },
        { value: 'child', label: t('reg.rel.child'), description: t('reg.rel.childDesc') },
        { value: 'authorized_dependent', label: t('reg.rel.dependent'), description: t('reg.rel.dependentDesc') },
      ],
    });
    group.onChange(() => group.clearError());
    const { row } = nav();
    const f = form([summary, group.wrap, row], () => {
      if (!validate(summary, [[group, group.value ? null : t('v.requiredChoice')]])) return;
      if (state.relationship && state.relationship !== group.value) state.accepted.clear();
      state.relationship = group.value;
      state.dirty = true;
      show(2);
    });
    shell(stepTitles()[0], f);
  }

  // ---- Step 2: patient -----------------------------------------------------------------------
  function step2() {
    const summary = h('div');
    const first = field({ label: t('reg.firstName'), name: 'given-name', autocomplete: state.relationship === 'self' ? 'given-name' : 'off', value: state.patient.firstName, maxlength: 100 });
    const last = field({ label: t('reg.lastName'), name: 'family-name', autocomplete: state.relationship === 'self' ? 'family-name' : 'off', value: state.patient.lastName, maxlength: 100 });
    const dob = field({ label: t('reg.dob'), name: 'bday', type: 'date', autocomplete: state.relationship === 'self' ? 'bday' : 'off', value: state.patient.dateOfBirth, min: MIN_DATE_OF_BIRTH, max: config.rules.today });
    const ageOut = h('p', { class: 'p-age', 'aria-live': 'polite', hidden: true });
    const gender = choiceGroup({
      legend: t('reg.gender'), name: 'gender', value: state.patient.gender, inline: true,
      options: [{ value: 'female', label: t('reg.gender.female') }, { value: 'male', label: t('reg.gender.male') }],
    });
    gender.onChange(() => gender.clearError());

    const dobMessage = (value) => {
      if (!value) return t('v.required', { field: t('reg.dob') });
      const p = dateOfBirthProblem(value, state.relationship, config.rules.today);
      return { INVALID_DATE: t('v.dob'), FUTURE_DATE: t('v.dobFuture'), TOO_OLD: t('v.dobOld'), CHILD_MUST_BE_UNDER_18: t('v.dobChild'), SELF_MUST_BE_ADULT: t('v.dobSelf') }[p] || null;
    };
    const updateAge = () => {
      const v = dob.input.value;
      const a = v && !dateOfBirthProblem(v, 'authorized_dependent', config.rules.today) ? ageParts(v, config.rules.today) : null;
      ageOut.hidden = !a;
      ageOut.textContent = a ? t('reg.age', { age: formatAge(a) }) : '';
    };
    dob.input.addEventListener('input', updateAge);
    dob.input.addEventListener('change', updateAge);
    updateAge();

    const { row } = nav();
    const f = form([summary, first.wrap, last.wrap, dob.wrap, ageOut, h('div', { class: 'p-mt-m' }, gender.wrap), row], () => {
      const fn = normaliseName(first.input.value);
      const ln = normaliseName(last.input.value);
      const ok = validate(summary, [
        [first, !fn ? t('v.required', { field: t('reg.firstName') }) : isValidName(fn) ? null : t('v.name')],
        [last, !ln ? t('v.required', { field: t('reg.lastName') }) : isValidName(ln) ? null : t('v.name')],
        [dob, dobMessage(dob.input.value)],
        [gender, gender.value ? null : t('v.requiredChoice')],
      ]);
      if (!ok) return;
      state.patient = { firstName: fn, lastName: ln, dateOfBirth: dob.input.value, gender: gender.value };
      show(3);
    });
    shell(stepTitles()[1], f);
  }

  // ---- Step 3: contact ----------------------------------------------------------------------
  function step3() {
    const summary = h('div');
    const dependent = state.relationship !== 'self';
    const name = field({ label: dependent ? t('reg.guardianName') : t('reg.holderName'), name: 'name', autocomplete: 'name', value: state.contact.fullName, maxlength: 200 });
    const email = field({ label: t('field.email'), name: 'email', type: 'email', value: config.profile.email, readonly: true, required: false, hint: t('reg.emailNote') });
    const phone = field({ label: t('field.mobile'), name: 'tel', type: 'tel', autocomplete: 'tel-national', inputmode: 'tel', hint: t('field.mobileHint'), value: state.contact.phone, maxlength: 20 });
    const saveId = nextId('save');
    const save = h('input', { type: 'checkbox', id: saveId, checked: state.saveToProfile || undefined });
    const { row } = nav();
    const f = form([
      summary,
      h('p', { class: 'p-muted' }, t('reg.contactLead')),
      dependent ? h('div', { class: 'p-mt-s' }, alertBox('info', null, t('reg.guardianNote'))) : null,
      h('div', { class: 'p-mt-m' }, name.wrap), email.wrap, phone.wrap,
      h('label', { class: 'p-check p-mt-m', for: saveId }, save, h('span', {}, t('reg.saveProfile'))),
      row,
    ], () => {
      const n = normaliseName(name.input.value);
      const p = normaliseSaudiMobile(phone.input.value);
      const ok = validate(summary, [
        [name, !n ? t('v.required', { field: name.label }) : isValidName(n, 200) ? null : t('v.name')],
        [phone, !phone.input.value.trim() ? t('v.required', { field: t('field.mobile') }) : p ? null : t('v.mobile')],
      ]);
      if (!ok) return;
      state.contact = { fullName: n, phone: formatSaudiMobile(p) };
      state.saveToProfile = save.checked;
      show(4);
    });
    shell(stepTitles()[2], f);
  }

  // ---- Step 4: collection ------------------------------------------------------------------
  function step4() {
    const summary = h('div');
    const branch = choiceGroup({
      legend: t('reg.branch'), name: 'branch', value: state.branchId,
      options: config.branches.map((b) => ({ value: b.id, label: branchName(b), description: lang === 'ar' ? b.addressAr : b.addressEn })),
    });
    branch.onChange(() => branch.clearError());
    const { row } = nav();
    const f = form([
      summary,
      h('dl', { class: 'p-dl' },
        h('dt', {}, t('reg.product')), h('dd', {}, t('reg.productValue')),
        h('dt', {}, t('reg.sampleType')), h('dd', {}, t('reg.sampleValue')),
        h('dt', {}, t('reg.country')), h('dd', {}, t('reg.countryValue'))),
      h('div', { class: 'p-mt-m' }, h('p', { class: 'p-hint' }, t('reg.branchHint')), h('div', { class: 'p-mt-s' }, branch.wrap)),
      row,
    ], () => {
      if (!validate(summary, [[branch, branch.value ? null : t('v.branch')]])) return;
      state.branchId = branch.value;
      show(5);
    });
    shell(stepTitles()[3], f);
  }

  // ---- Step 5: consent ----------------------------------------------------------------------
  const neededDocs = () => {
    const types = requiredConsentTypes(state.relationship);
    return types.map((type) => config.consents.find((d) => d.type === type)).filter(Boolean);
  };

  function step5(message) {
    const summary = h('div');
    const checks = neededDocs().map((doc) => {
      const id = nextId('consent');
      const errorId = `${id}-error`;
      const input = h('input', { type: 'checkbox', id, checked: state.accepted.has(doc.id) || undefined, 'aria-describedby': errorId, required: true });
      const error = h('p', { class: 'p-error', id: errorId, hidden: true });
      const api = {
        input, error, doc, label: doc.title,
        setError(msg) { error.textContent = msg; error.hidden = false; input.setAttribute('aria-invalid', 'true'); },
        clearError() { error.hidden = true; input.removeAttribute('aria-invalid'); },
      };
      input.addEventListener('change', () => api.clearError());
      const textId = `${id}-text`;
      api.wrap = h('div', { class: 'p-consent' },
        h('div', { class: 'p-row p-row--between' }, h('h2', { class: 'p-h3' }, doc.title), doc.provisional ? h('span', { class: 'p-badge p-badge--warning' }, t('common.provisional')) : null),
        h('div', { class: 'p-consent-text', id: textId, tabindex: '0', role: 'region', 'aria-label': doc.title }, doc.body),
        h('label', { class: 'p-check', for: id }, input, h('span', {}, t('reg.accept', { title: doc.title }))),
        error);
      return api;
    });
    const { row } = nav();
    const f = form([
      summary,
      message ? alertBox('warning', message) : null,
      h('p', { class: 'p-muted' }, t('reg.consentLead')),
      h('div', { class: 'p-mt-m' }, checks.map((c) => c.wrap)),
      row,
    ], () => {
      if (!validate(summary, checks.map((c) => [c, c.input.checked ? null : t('v.consent')]))) return;
      state.accepted = new Set(checks.map((c) => c.doc.id));
      show(6);
    });
    shell(stepTitles()[4], f);
  }

  // ---- Review & submit ---------------------------------------------------------------------
  function review() {
    const branch = config.branches.find((b) => b.id === state.branchId);
    const rel = { self: t('reg.rel.self'), child: t('reg.rel.child'), authorized_dependent: t('reg.rel.dependent') }[state.relationship];
    const age = ageParts(state.patient.dateOfBirth, config.rules.today);
    const status = h('div', { 'aria-live': 'assertive' });
    const block = (title, step, rows) => h('section', { class: 'p-review-section' },
      h('div', { class: 'p-row p-row--between' }, h('h2', { class: 'p-h3' }, title),
        h('button', { type: 'button', class: 'p-linkbtn', onclick: () => show(step), 'aria-label': `${t('common.edit')}: ${title}` }, t('common.edit'))),
      h('dl', { class: 'p-dl p-mt-s' }, rows.map(([k, v, attrs]) => [h('dt', {}, k), h('dd', attrs || {}, v)])));

    const { next, row } = nav(null, { nextLabel: t('reg.submit'), backTo: 5 });
    const body = h('div', {},
      status,
      block(t('reg.step1'), 1, [[t('reg.relationship'), rel]]),
      block(stepTitles()[1], 2, [
        [t('detail.name'), `${state.patient.firstName} ${state.patient.lastName}`],
        [t('reg.dob'), formatDate(state.patient.dateOfBirth)],
        [t('detail.age'), formatAge(age)],
        [t('reg.gender'), t(`reg.gender.${state.patient.gender}`)],
      ]),
      block(t('reg.step3'), 3, [
        [state.relationship === 'self' ? t('reg.holderName') : t('reg.guardianName'), state.contact.fullName],
        [t('field.email'), config.profile.email, { class: 'p-ltr' }],
        [t('field.mobile'), state.contact.phone, { dir: 'ltr' }],
      ]),
      block(t('reg.step4'), 4, [
        [t('reg.product'), t('reg.productValue')],
        [t('reg.sampleType'), t('reg.sampleValue')],
        [t('reg.country'), t('reg.countryValue')],
        [t('reg.branch'), branch ? branchName(branch) : ''],
      ]),
      block(t('reg.step5'), 5, neededDocs().map((d) => [d.title, t('reg.accepted')])));

    const f = form([body, row], async () => {
      setBusy(next, true, t('reg.submitting'));
      mount(status);
      const payload = {
        relationship: state.relationship,
        patient: state.patient,
        contact: { fullName: state.contact.fullName, phone: state.contact.phone },
        branchId: state.branchId,
        consentDocumentIds: [...state.accepted],
        saveToProfile: state.saveToProfile,
      };
      // Same details → same key (a retry can't duplicate). Edited after a failure → new key.
      const serialized = JSON.stringify(payload);
      if (state.lastPayload && state.lastPayload !== serialized) state.idempotencyKey = newIdempotencyKey();
      state.lastPayload = serialized;
      try {
        const res = await api('POST', '/me/registrations', payload, { idempotencyKey: state.idempotencyKey });
        state.submitted = true;
        go(pageUrl('registration', { id: res.registration.id, created: '1' }));
      } catch (err) {
        setBusy(next, false);
        if (err instanceof ApiError && err.code === 'CONSENT_OUTDATED') {
          config = await api('GET', `/me/registration-form?locale=${lang}`);
          state.accepted.clear();
          state.idempotencyKey = newIdempotencyKey();
          state.step = 5;
          step5(t('error.CONSENT_OUTDATED'));
          return;
        }
        if (err instanceof ApiError && err.code === 'INVALID_BRANCH') {
          config = await api('GET', `/me/registration-form?locale=${lang}`);
          state.branchId = null;
          state.idempotencyKey = newIdempotencyKey();
        }
        mount(status, alertBox('error', errorMessage(err)));
        status.scrollIntoView({ block: 'center' });
      }
    });
    shell(t('reg.review'), f, null, { isReview: true });
  }

  function show(step) {
    state.step = step;
    [null, step1, step2, step3, step4, step5, review][step]();
  }
  show(1);
}
