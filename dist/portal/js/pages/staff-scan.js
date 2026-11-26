import { api } from '../core/api.js';
import { h, mount, nextId } from '../core/dom.js';
import { formatAge, formatDateTime, t, statusLabel } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { extractCustomerToken, isTrackingIdOnly, QrScanner, ScannerError } from '../core/scanner.js';
import { alertBox, errorMessage, focusTitle, pageHeading, setBusy } from '../core/ui.js';
import { branchLabel, branchPicker, genderLabel, loadStaff } from './staff-common.js';

// Scan → validate → verify identity → checklist → confirm. Staff only ever receive the patient's
// age and gender plus operational data (the API enforces this). Raw QR content is never logged,
// displayed or stored; it is sent once to the validation API.
export default async function render({ app }) {
  const staff = await loadStaff();
  if (!staff.branch) {
    mount(app, h('div', { class: 'p-medium' }, pageHeading(t('scan.title')), h('div', { class: 'p-card' }, alertBox('info', null, t('staff.noBranch')))));
    return;
  }

  const stage = h('div', { class: 'p-stack p-mt-m' });
  const video = h('video', { class: 'p-scanner__video', playsinline: true, muted: true, 'aria-label': t('scan.videoLabel') });
  let busy = false; // a scan is being checked: ignore further detections (no duplicate requests)
  const scanner = new QrScanner(video, (text) => handleScanned(text));

  // Release the camera whenever the page is left or hidden.
  const release = () => scanner.stop();
  window.addEventListener('pagehide', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });

  // ---- Idle / scanning ----------------------------------------------------------------------
  function scanStage(message) {
    busy = false;
    const status = h('div', { 'aria-live': 'polite' }, message || null);
    const start = h('button', { type: 'button', class: 'p-btn p-btn--dark p-btn--lg' }, t('scan.start'));
    const stop = h('button', { type: 'button', class: 'p-btn p-btn--ghost', hidden: true }, t('scan.stop'));
    const camId = nextId('camera');
    const camSelect = h('select', { class: 'p-select', id: camId });
    const camField = h('div', { class: 'p-field', hidden: true }, h('label', { class: 'p-label', for: camId }, t('scan.camera')), camSelect);
    const frame = h('div', { class: 'p-scanner', hidden: true }, video, h('div', { class: 'p-scanner__guide', 'aria-hidden': 'true' }));
    const hint = h('p', { class: 'p-muted p-small', hidden: true }, t('scan.scanning'));

    const begin = async (deviceId) => {
      setBusy(start, true);
      mount(status);
      try {
        await scanner.start(deviceId);
        frame.hidden = false;
        hint.hidden = false;
        start.hidden = true;
        stop.hidden = false;
        const cams = await scanner.cameras();
        if (cams.length > 1) {
          mount(camSelect, cams.map((c, i) => h('option', { value: c.deviceId, selected: c.deviceId === scanner.activeDeviceId || undefined }, c.label || `${t('scan.camera')} ${i + 1}`)));
          camField.hidden = false;
        }
      } catch (err) {
        const kind = err instanceof ScannerError ? err.kind : 'camera';
        mount(status, alertBox('error', t(`scan.err.${kind}`)));
      } finally {
        setBusy(start, false);
      }
    };
    start.addEventListener('click', () => begin());
    stop.addEventListener('click', () => {
      scanner.stop();
      scanStage();
    });
    camSelect.addEventListener('change', () => begin(camSelect.value));

    // Manual entry / USB keyboard-wedge scanners (they type the code and press Enter).
    const manualId = nextId('manual');
    const manual = h('input', { class: 'p-input p-ltr', id: manualId, type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', maxlength: 300, 'aria-describedby': `${manualId}-hint` });
    const manualForm = h('form', { novalidate: true, class: 'p-mt-s' },
      h('div', { class: 'p-field' }, h('label', { class: 'p-label', for: manualId }, t('scan.manualLabel')), h('p', { class: 'p-hint', id: `${manualId}-hint` }, t('scan.manualHint')), manual),
      h('div', { class: 'p-actions' }, h('button', { type: 'submit', class: 'p-btn p-btn--ghost' }, t('scan.manualSubmit'))));
    manualForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const value = manual.value;
      manual.value = ''; // don't keep the code on screen
      handleScanned(value);
    });

    mount(stage,
      h('section', { class: 'p-card', 'aria-labelledby': 'cam-title' },
        h('h2', { class: 'p-h2', id: 'cam-title' }, t('scan.camera')),
        h('p', { class: 'p-muted p-mt-s' }, t('scan.lead')),
        h('div', { class: 'p-mt-m' }, status),
        frame, hint, camField,
        h('div', { class: 'p-actions' }, start, stop)),
      h('section', { class: 'p-card', 'aria-labelledby': 'manual-title' },
        h('h2', { class: 'p-h3', id: 'manual-title' }, t('scan.manualTitle')), manualForm));
  }

  // ---- Checking -----------------------------------------------------------------------------
  async function handleScanned(text) {
    if (busy) return;
    busy = true;
    scanner.stop(); // a code was read: release the camera immediately
    if (isTrackingIdOnly(text)) return scanStage(alertBox('error', t('scan.err.trackingOnly')));
    const token = extractCustomerToken(text);
    if (!token) return scanStage(alertBox('error', t('scan.reason.UNRECOGNISED')));
    mount(stage, h('div', { class: 'p-card' }, h('p', { class: 'p-loading', role: 'status' }, t('scan.checking'))));
    try {
      const result = await api('POST', '/staff/qr/validate', { code: token, branchId: staff.branch.id });
      if (!result.qrValid) return invalidStage(result);
      resultStage(result);
    } catch (err) {
      scanStage(alertBox('error', errorMessage(err)));
    }
  }

  function againButton() {
    return h('button', { type: 'button', class: 'p-btn p-btn--dark', onclick: () => scanStage() }, t('scan.again'));
  }

  function invalidStage(result) {
    mount(stage, h('div', { class: 'p-card p-stack' },
      alertBox(result.reason === 'ALREADY_COLLECTED' ? 'warning' : 'error', t(`scan.reason.${result.reason}`),
        result.trackingId ? `${t('detail.trackingId')}: ${result.trackingId}` : null),
      h('div', { class: 'p-actions' }, againButton())));
    focusStage();
  }

  // ---- Valid: details, identity, checklist, confirm -----------------------------------------
  function resultStage(v, notice) {
    const status = h('div', { 'aria-live': 'polite' }, notice || null);
    const details = h('section', { class: 'p-card', 'aria-labelledby': 'res-title' },
      h('div', { class: 'p-row p-row--between' }, h('h2', { class: 'p-h2', id: 'res-title' }, t('scan.valid')), h('span', { class: 'p-badge' }, '✓')),
      h('dl', { class: 'p-dl p-dl--strong p-mt-m' },
        h('dt', {}, t('detail.trackingId')), h('dd', { class: 'p-ltr p-tracking-id' }, v.trackingId),
        h('dt', {}, t('staff.age')), h('dd', {}, formatAge(v.patientAge)),
        h('dt', {}, t('staff.gender')), h('dd', {}, genderLabel(v.patientGender)),
        h('dt', {}, t('staff.sampleType')), h('dd', {}, t('staff.sampleHair')),
        h('dt', {}, t('staff.status')), h('dd', {}, statusLabel(v.sampleStatus)),
        h('dt', {}, t('staff.branch')), h('dd', {}, branchLabel(v.branch))));

    // Identity verification (QR possession is NOT identity).
    const idStatus = v.identityVerification.status;
    const idCard = h('section', { class: 'p-card', 'aria-labelledby': 'id-title' },
      h('div', { class: 'p-row p-row--between' }, h('h2', { class: 'p-h3', id: 'id-title' }, t('id.title')),
        h('span', { class: `p-badge${idStatus === 'verified' ? '' : idStatus === 'failed' ? ' p-badge--warning' : ' p-badge--muted'}` }, t(`id.status.${idStatus}`))),
      h('p', { class: 'p-muted p-small p-mt-s' }, t('id.lead')),
      v.devVerificationAvailable
        ? h('div', { class: 'p-dev-panel p-mt-m', role: 'group', 'aria-labelledby': 'dev-title' },
            h('p', { class: 'p-h3', id: 'dev-title' }, t('id.devTitle')),
            h('p', { class: 'p-small p-mt-s' }, t('id.devNote')),
            h('div', { class: 'p-actions' }, ['verified', 'pending', 'failed'].map((o) =>
              h('button', { type: 'button', class: 'p-btn p-btn--ghost', onclick: (e) => devVerify(v, o, e.currentTarget) }, t(`id.dev.${o}`)))))
        : h('div', { class: 'p-mt-m' }, alertBox('warning', null, t('id.noMethod'))));

    // Instructions + checklist.
    const ins = v.collectionInstructions;
    const checks = ins.checklist.map((item) => {
      const id = nextId('chk');
      const input = h('input', { type: 'checkbox', id, value: item.id });
      return { item, input, row: h('label', { class: 'p-check', for: id }, input, h('span', {}, item.label)) };
    });
    const confirm = h('button', { type: 'button', class: 'p-btn p-btn--dark p-btn--lg p-btn--block' }, t('check.confirm'));
    const gate = h('p', { class: 'p-small p-muted', 'aria-live': 'polite' });
    const refreshGate = () => {
      const allTicked = checks.every((c) => c.input.checked);
      const ok = v.canCollect && allTicked;
      confirm.disabled = !ok;
      confirm.setAttribute('aria-disabled', String(!ok));
      gate.textContent = !v.canCollect ? t('check.needId') : allTicked ? '' : t('check.needAll');
    };
    checks.forEach((c) => c.input.addEventListener('change', refreshGate));
    confirm.addEventListener('click', async () => {
      if (confirm.disabled) return;
      setBusy(confirm, true, t('check.confirming'));
      try {
        const res = await api('POST', `/staff/collection-sessions/${v.collectionSessionId}/collect`, {
          instructionsId: ins.id, checklist: checks.filter((c) => c.input.checked).map((c) => c.item.id),
        });
        doneStage(res.collection);
      } catch (err) {
        setBusy(confirm, false);
        refreshGate();
        mount(status, alertBox('error', errorMessage(err)), err.code === 'QR_REPLACED' || err.code === 'SESSION_EXPIRED' || err.code === 'ALREADY_COLLECTED' ? h('div', { class: 'p-actions' }, againButton()) : null);
      }
    });

    const insCard = h('section', { class: 'p-card', 'aria-labelledby': 'ins-title' },
      h('div', { class: 'p-row p-row--between' }, h('h2', { class: 'p-h3', id: 'ins-title' }, t('scan.instructions')),
        ins.provisional ? h('span', { class: 'p-badge p-badge--warning' }, t('scan.notApproved')) : null),
      h('p', { class: 'p-muted p-small p-mt-s' }, ins.title, ' · ', t('scan.version', { v: ins.version })),
      h('ol', { class: 'p-steps-list p-mt-m' }, ins.steps.map((s) => h('li', {}, s))),
      h('fieldset', { class: 'p-mt-m' }, h('legend', {}, t('check.title')), h('div', { class: 'p-stack' }, checks.map((c) => c.row))),
      h('div', { class: 'p-mt-m' }, confirm, gate));

    mount(stage, status, details, idCard, insCard, h('div', { class: 'p-actions' }, h('button', { type: 'button', class: 'p-btn p-btn--ghost', onclick: () => scanStage() }, t('scan.again'))));
    refreshGate();
    focusStage();
  }

  async function devVerify(v, outcome, button) {
    setBusy(button, true);
    try {
      resultStage(await api('POST', `/staff/collection-sessions/${v.collectionSessionId}/identity/dev`, { outcome }));
    } catch (err) {
      setBusy(button, false);
      resultStage(v, alertBox('error', errorMessage(err)));
    }
  }

  function doneStage(c) {
    mount(stage, h('section', { class: 'p-card p-stack', 'aria-labelledby': 'done-title' },
      h('h2', { class: 'p-h2', id: 'done-title' }, t('done.title')),
      alertBox('success', null, t('done.body', { id: c.trackingId, branch: branchLabel(c.branch) })),
      h('p', { class: 'p-muted p-small' }, formatDateTime(c.collectedAt)),
      h('div', { class: 'p-actions' }, againButton(), h('a', { class: 'p-btn p-btn--ghost', href: pageUrl('staff-dashboard') }, t('staff.nav.dashboard')))));
    focusStage();
  }

  function focusStage() {
    stage.querySelector('h2, [role="alert"]')?.setAttribute('tabindex', '-1');
    stage.querySelector('h2, [role="alert"]')?.focus();
  }

  mount(app, h('div', { class: 'p-medium' },
    h('p', { class: 'p-badge p-badge--muted' }, t('staff.portal')),
    h('div', { class: 'p-mt-s' }, pageHeading(t('scan.title'))),
    h('div', { class: 'p-card' }, branchPicker(staff, (b) => { staff.branch = b; scanStage(); })),
    stage));
  scanStage();
  focusTitle();
}
