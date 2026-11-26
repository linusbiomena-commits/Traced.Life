import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { formatAge, formatDateTime, t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, errorMessage, focusTitle, loading, pageHeading, setBusy } from '../core/ui.js';
import { genderLabel } from './staff-common.js';
import { branchShort, newKey, sampleBadge, sampleScanner, stepsList } from './sample-common.js';

// Branch custody for collection staff: scan a sample label, confirm the sample, then package,
// mark ready for dispatch and dispatch (courier + shipment tracking number). A scan never changes
// anything by itself. Patient information shown: age and gender only.
export default async function render({ app }) {
  const current = h('div');
  const list = h('div', {}, loading());
  let code = null; // the scanned code, in memory only, for the next confirmed action

  const scanner = sampleScanner(async (c) => {
    try {
      const { sample } = await api('POST', '/staff/samples/scan', { code: c });
      code = c;
      show(sample);
    } catch (err) {
      mount(scanner.status, alertBox('error', errorMessage(err)));
    }
  });

  function actionForm(sample, action) {
    const status = h('div', { 'aria-live': 'polite' });
    const confirm = h('input', { type: 'checkbox' });
    const courier = action === 'dispatch' ? h('input', { class: 'p-input', maxlength: 120, autocomplete: 'off' }) : null;
    const tracking = action === 'dispatch' ? h('input', { class: 'p-input p-ltr', maxlength: 120, autocomplete: 'off' }) : null;
    const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t(`sample.action.${action}`));
    const form = h('form', { novalidate: true, class: 'p-stack p-details' },
      h('h3', { class: 'p-h3' }, t(`sample.action.${action}`)),
      courier ? h('div', { class: 'p-filter-grid' },
        h('div', { class: 'p-field' }, h('label', { class: 'p-label' }, t('sample.courier'), courier)),
        h('div', { class: 'p-field' }, h('label', { class: 'p-label' }, t('sample.shipmentTracking'), tracking))) : null,
      h('label', { class: 'p-check' }, confirm, h('span', {}, t('sample.confirmLabel', { id: sample.sampleId }))),
      h('p', { class: 'p-small p-muted' }, t('sample.packagingNote')),
      status, h('div', { class: 'p-actions' }, submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      mount(status);
      if (!confirm.checked) return mount(status, alertBox('error', t('sample.confirmRequired')));
      if (courier && (!courier.value.trim() || !tracking.value.trim())) return mount(status, alertBox('error', t('error.DISPATCH_DETAILS_REQUIRED')));
      setBusy(submit, true);
      try {
        const res = await api('POST', '/staff/samples/action', {
          code, action, expectedStatus: sample.status, idempotencyKey: newKey(),
          ...(courier ? { courier: courier.value.trim(), shipmentTrackingNumber: tracking.value.trim() } : {}),
        });
        show(res.sample, t('sample.done', { status: t(`admin.sampleStatus.${res.status}`) }));
        loadList();
      } catch (err) {
        setBusy(submit, false);
        mount(status, alertBox('error', errorMessage(err)));
      }
    });
    return form;
  }

  function show(sample, message) {
    mount(current, h('section', { class: 'p-card p-stack', 'aria-labelledby': 'sample-title' },
      message ? alertBox('success', message) : null,
      h('div', { class: 'p-row p-row--between' }, h('h2', { class: 'p-h2 p-ltr', id: 'sample-title', dir: 'ltr' }, sample.sampleId), sampleBadge(sample.status)),
      h('dl', { class: 'p-dl p-dl--strong' },
        h('dt', {}, t('staff.trackingId')), h('dd', { class: 'p-ltr', dir: 'ltr' }, sample.trackingId),
        h('dt', {}, t('staff.age')), h('dd', {}, formatAge(sample.patientAge)),
        h('dt', {}, t('staff.gender')), h('dd', {}, genderLabel(sample.patientGender)),
        h('dt', {}, t('staff.sampleType')), h('dd', {}, t('staff.sampleHair')),
        h('dt', {}, t('staff.branch')), h('dd', {}, branchShort(sample.branch)),
        h('dt', {}, t('staff.collectedAt')), h('dd', {}, formatDateTime(sample.collectedAt)),
        sample.dispatch ? [h('dt', {}, t('sample.courier')), h('dd', {}, `${sample.dispatch.courier} · `, h('span', { class: 'p-ltr', dir: 'ltr' }, sample.dispatch.shipmentTrackingNumber))] : null),
      h('p', {}, h('a', { href: pageUrl('staff-label', { id: sample.id }) }, t('sample.printLabel'))),
      sample.allowedActions.length ? sample.allowedActions.map((a) => actionForm(sample, a)) : alertBox('info', null, t('sample.noBranchAction')),
      h('details', { class: 'p-details' }, h('summary', {}, t('sample.history')), stepsList(sample.steps))));
    current.querySelector('h2')?.focus?.();
  }

  async function loadList() {
    try {
      const { items } = await api('GET', '/staff/samples');
      mount(list, items.length
        ? h('ul', { class: 'p-list' }, items.map((s) => h('li', { class: 'p-item' },
          h('div', {}, h('p', { class: 'p-item__title p-ltr', dir: 'ltr' }, s.sampleId),
            h('p', { class: 'p-item__meta' }, h('span', {}, branchShort(s.branch)), h('span', {}, formatDateTime(s.statusChangedAt)))),
          sampleBadge(s.status),
          h('div', { class: 'p-item__actions p-row' },
            h('a', { href: pageUrl('staff-label', { id: s.id }) }, t('sample.printLabel')),
            h('button', { type: 'button', class: 'p-linkbtn', onclick: () => { scanner.prefill(s.sampleId); scanner.submit(); } }, t('sample.open'))))))
        : h('p', { class: 'p-muted' }, t('sample.noneWaiting')));
    } catch (err) {
      mount(list, alertBox('error', errorMessage(err)));
    }
  }

  mount(app, h('div', { class: 'p-medium' },
    h('p', { class: 'p-badge p-badge--muted' }, t('staff.portal')),
    h('div', { class: 'p-mt-s' }, pageHeading(t('sample.staffTitle'), t('sample.staffLead'))),
    h('div', { class: 'p-stack' }, scanner.el, current,
      h('section', { class: 'p-card', 'aria-labelledby': 'waiting-title' }, h('h2', { class: 'p-h2', id: 'waiting-title' }, t('sample.waiting')), h('div', { class: 'p-mt-m' }, list)))));
  focusTitle();
  await loadList();
}
