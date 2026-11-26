import { api } from '../core/api.js';
import { h, mount, nextId } from '../core/dom.js';
import { formatDateTime, t } from '../core/i18n.js';
import { alertBox, errorMessage, focusTitle, pageHeading, setBusy } from '../core/ui.js';
import { branchShort, newKey, sampleBadge, sampleScanner, stepsList } from './sample-common.js';

const REASONS = ['damaged_packaging', 'missing_sample', 'unreadable_label', 'identification_mismatch', 'insufficient_sample', 'other'];

// Laboratory scanner: identify a sample by its label, then explicitly confirm receipt (with the
// sample's condition), reject (provisional reason categories), or record analysis progress and
// report availability. Scanning alone never changes anything. No patient data is shown.
export default async function render({ app }) {
  const current = h('div');
  let code = null;
  const scanner = sampleScanner(async (c) => {
    try {
      const { sample } = await api('POST', '/lab/samples/scan', { code: c });
      code = c;
      show(sample);
    } catch (err) {
      mount(scanner.status, alertBox('error', errorMessage(err)));
    }
  });

  const radio = (name, value, label, checked) => h('label', { class: 'p-check' }, h('input', { type: 'radio', name, value, checked: checked || undefined }), h('span', {}, label));
  const picked = (form, name) => form.querySelector(`input[name="${name}"]:checked`)?.value;

  async function send(sample, action, extra, status, button) {
    setBusy(button, true);
    try {
      const res = await api('POST', '/lab/samples/action', { code, action, expectedStatus: sample.status, idempotencyKey: newKey(), ...extra });
      show(res.sample, t('sample.done', { status: t(`admin.sampleStatus.${res.status}`) }));
    } catch (err) {
      setBusy(button, false);
      mount(status, alertBox('error', errorMessage(err)));
    }
  }

  function receiveForm(sample) {
    const name = nextId('cond');
    const outcome = nextId('outcome');
    const status = h('div', { 'aria-live': 'polite' });
    const reason = h('select', { class: 'p-select' }, REASONS.map((r) => h('option', { value: r }, t(`sample.reason.${r}`))));
    const remarks = h('textarea', { class: 'p-textarea', rows: 2, maxlength: 1000 });
    const rejectFields = h('div', { class: 'p-stack', hidden: true },
      h('div', { class: 'p-field' }, h('label', { class: 'p-label' }, t('sample.rejectReason'), reason), h('p', { class: 'p-hint' }, t('sample.reasonsProvisional'))),
      h('div', { class: 'p-field' }, h('label', { class: 'p-label' }, t('sample.remarks'), remarks), h('p', { class: 'p-hint' }, t('sample.remarksInternal'))));
    const confirm = h('input', { type: 'checkbox' });
    const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('lab.confirmReceipt'));
    const form = h('form', { novalidate: true, class: 'p-stack p-details' },
      h('h3', { class: 'p-h3' }, t('lab.receiptTitle')),
      h('fieldset', {}, h('legend', { class: 'p-label' }, t('lab.condition')), h('div', { class: 'p-choices--inline p-row' }, radio(name, 'intact', t('sample.condition.intact')), radio(name, 'damaged', t('sample.condition.damaged')))),
      h('fieldset', {}, h('legend', { class: 'p-label' }, t('lab.decision')), h('div', { class: 'p-row' }, radio(outcome, 'accept', t('lab.accept'), true), radio(outcome, 'reject', t('lab.reject')))),
      rejectFields,
      h('label', { class: 'p-check' }, confirm, h('span', {}, t('lab.confirmPhysical', { id: sample.sampleId }))),
      status, h('div', { class: 'p-actions' }, submit));
    form.addEventListener('change', () => { rejectFields.hidden = picked(form, outcome) !== 'reject'; });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      mount(status);
      const condition = picked(form, name);
      if (!condition) return mount(status, alertBox('error', t('error.CONDITION_REQUIRED')));
      if (!confirm.checked) return mount(status, alertBox('error', t('sample.confirmRequired')));
      if (picked(form, outcome) === 'reject') {
        if (reason.value === 'other' && !remarks.value.trim()) return mount(status, alertBox('error', t('error.REMARKS_REQUIRED')));
        return send(sample, 'reject', { condition, reasonCategory: reason.value, ...(remarks.value.trim() ? { remarks: remarks.value.trim() } : {}) }, status, submit);
      }
      return send(sample, 'receive', { condition }, status, submit);
    });
    return form;
  }

  function simpleForm(sample, action, needsReportConfirmation) {
    const status = h('div', { 'aria-live': 'polite' });
    const confirm = h('input', { type: 'checkbox' });
    const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t(`sample.action.${action}`));
    const form = h('form', { novalidate: true, class: 'p-stack p-details' }, h('h3', { class: 'p-h3' }, t(`sample.action.${action}`)),
      needsReportConfirmation ? alertBox('info', null, t('lab.reportNote')) : null,
      h('label', { class: 'p-check' }, confirm, h('span', {}, needsReportConfirmation ? t('lab.confirmReport') : t('lab.confirmPhysical', { id: sample.sampleId }))),
      status, h('div', { class: 'p-actions' }, submit));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      mount(status);
      if (!confirm.checked) return mount(status, alertBox('error', t('sample.confirmRequired')));
      return send(sample, action, needsReportConfirmation ? { reportDeliveryConfirmed: true } : {}, status, submit);
    });
    return form;
  }

  function rejectForm(sample) {
    const status = h('div', { 'aria-live': 'polite' });
    const reason = h('select', { class: 'p-select' }, REASONS.map((r) => h('option', { value: r }, t(`sample.reason.${r}`))));
    const remarks = h('textarea', { class: 'p-textarea', rows: 2, maxlength: 1000 });
    const submit = h('button', { type: 'submit', class: 'p-btn p-btn--ghost' }, t('lab.reject'));
    const form = h('form', { novalidate: true, class: 'p-stack' },
      h('div', { class: 'p-field' }, h('label', { class: 'p-label' }, t('sample.rejectReason'), reason), h('p', { class: 'p-hint' }, t('sample.reasonsProvisional'))),
      h('div', { class: 'p-field' }, h('label', { class: 'p-label' }, t('sample.remarks'), remarks), h('p', { class: 'p-hint' }, t('sample.remarksInternal'))),
      status, h('div', { class: 'p-actions' }, submit));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      mount(status);
      if (reason.value === 'other' && !remarks.value.trim()) return mount(status, alertBox('error', t('error.REMARKS_REQUIRED')));
      return send(sample, 'reject', { reasonCategory: reason.value, ...(remarks.value.trim() ? { remarks: remarks.value.trim() } : {}) }, status, submit);
    });
    return h('details', { class: 'p-details' }, h('summary', {}, t('lab.rejectSample')), form);
  }

  function show(sample, message) {
    const forms = [];
    if (sample.allowedActions.includes('receive')) forms.push(receiveForm(sample));
    for (const a of ['start_analysis', 'complete_analysis', 'report_available']) if (sample.allowedActions.includes(a)) forms.push(simpleForm(sample, a, a === 'report_available'));
    if (sample.allowedActions.includes('reject') && !sample.allowedActions.includes('receive')) forms.push(rejectForm(sample));
    mount(current, h('section', { class: 'p-card p-stack', 'aria-labelledby': 'lab-sample-title' },
      message ? alertBox('success', message) : null,
      h('div', { class: 'p-row p-row--between' }, h('h2', { class: 'p-h2 p-ltr', dir: 'ltr', id: 'lab-sample-title' }, sample.sampleId), sampleBadge(sample.status)),
      h('dl', { class: 'p-dl p-dl--strong' },
        h('dt', {}, t('staff.trackingId')), h('dd', { class: 'p-ltr', dir: 'ltr' }, sample.trackingId),
        h('dt', {}, t('staff.sampleType')), h('dd', {}, t('staff.sampleHair')),
        h('dt', {}, t('admin.col.branch')), h('dd', {}, branchShort(sample.branch)),
        h('dt', {}, t('staff.collectedAt')), h('dd', {}, formatDateTime(sample.collectedAt)),
        sample.dispatch ? [h('dt', {}, t('sample.courier')), h('dd', {}, `${sample.dispatch.courier} · `, h('span', { class: 'p-ltr', dir: 'ltr' }, sample.dispatch.shipmentTrackingNumber))] : null,
        sample.receipt ? [h('dt', {}, t('lab.received')), h('dd', {}, `${formatDateTime(sample.receipt.at)} · ${t(`sample.condition.${sample.receipt.condition}`)}`)] : null,
        sample.rejection ? [h('dt', {}, t('lab.rejected')), h('dd', {}, `${formatDateTime(sample.rejection.at)} · ${t(`sample.reason.${sample.rejection.reasonCategory}`)}`)] : null),
      h('p', { class: 'p-small p-muted' }, t('lab.noPatientData')),
      forms.length ? forms : alertBox('info', null, t('lab.noAction')),
      h('details', { class: 'p-details' }, h('summary', {}, t('sample.history')), stepsList(sample.steps))));
  }

  mount(app, h('div', { class: 'p-medium' },
    h('p', { class: 'p-badge p-badge--muted' }, t('lab.portal')),
    h('div', { class: 'p-mt-s' }, pageHeading(t('lab.scanTitle'), t('lab.scanLead'))),
    h('div', { class: 'p-stack' }, scanner.el, current)));
  focusTitle();
  const preset = new URLSearchParams(location.search).get('sample');
  if (preset) {
    scanner.prefill(preset);
    await scanner.submit();
  }
}
