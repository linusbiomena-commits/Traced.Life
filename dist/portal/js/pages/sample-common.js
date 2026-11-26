import { h, mount, nextId } from '../core/dom.js';
import { formatDateTime, lang, t } from '../core/i18n.js';
import { QrScanner, ScannerError } from '../core/scanner.js';
import { alertBox, setBusy } from '../core/ui.js';

// Shared pieces for physical samples (Phase 6): the label scanner (camera, USB or typed sample ID),
// status badges and the operational step list. The scanned code is kept only in memory for the
// next confirmed action; it is never stored, logged or shown.

export const SAMPLE_TOKEN_RE = /(?:^|#)(s1_[A-Za-z0-9_-]{43})$/;
export const SAMPLE_ID_RE = /^TRC-SA-(0[1-9]|1[0-2])\/\d{2}-\d{5}-S\d{2}$/i;

/** Accepts a sample QR (URL or bare token) or a typed physical sample ID; anything else is refused locally. */
export function sampleCodeFrom(text) {
  const value = (text || '').trim();
  if (!value || value.length > 300) return null;
  const token = SAMPLE_TOKEN_RE.exec(value);
  if (token) return token[1];
  return SAMPLE_ID_RE.test(value) ? value.toUpperCase() : null;
}

export const sampleStatus = (s) => t(`admin.sampleStatus.${s}`);
export function sampleBadge(status) {
  const muted = status === 'rejected';
  return h('span', { class: `p-badge${muted ? ' p-badge--muted' : status === 'report_available' ? '' : ''}` }, sampleStatus(status));
}
export const branchShort = (b) => (b ? `${lang === 'ar' ? b.nameAr : b.nameEn}${b.code ? ` (${b.code})` : ''}` : '–');

export function stepsList(steps) {
  return h('ol', { class: 'p-timeline' }, steps.map((s) => h('li', {}, h('strong', {}, sampleStatus(s.status)), ' · ', h('span', { class: 'p-muted p-small' }, formatDateTime(s.at)))));
}

/**
 * Camera + manual/USB entry. `onCode(code)` receives a validated sample code. Returns
 * { el, stop } so the page can release the camera.
 */
export function sampleScanner(onCode) {
  const video = h('video', { class: 'p-scanner__video', playsinline: true, muted: true, 'aria-label': t('scan.videoLabel') });
  let busy = false;
  const status = h('div', { 'aria-live': 'polite' });
  const handle = async (text) => {
    if (busy) return;
    const code = sampleCodeFrom(text);
    if (!code) {
      mount(status, alertBox('error', t('sample.notALabel')));
      return;
    }
    busy = true;
    try {
      await onCode(code);
    } finally {
      busy = false;
    }
  };
  const scanner = new QrScanner(video, (text) => {
    stopCamera();
    handle(text);
  });
  const start = h('button', { type: 'button', class: 'p-btn p-btn--dark' }, t('sample.startCamera'));
  const stop = h('button', { type: 'button', class: 'p-btn p-btn--ghost', hidden: true }, t('scan.stop'));
  const frame = h('div', { class: 'p-scanner', hidden: true }, video, h('div', { class: 'p-scanner__guide', 'aria-hidden': 'true' }));
  function stopCamera() {
    scanner.stop();
    frame.hidden = true;
    stop.hidden = true;
    start.hidden = false;
  }
  start.addEventListener('click', async () => {
    setBusy(start, true);
    mount(status);
    try {
      await scanner.start();
      frame.hidden = false;
      start.hidden = true;
      stop.hidden = false;
    } catch (err) {
      mount(status, alertBox('error', t(`scan.err.${err instanceof ScannerError ? err.kind : 'camera'}`)));
    } finally {
      setBusy(start, false);
    }
  });
  stop.addEventListener('click', stopCamera);
  window.addEventListener('pagehide', stopCamera);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });

  const manualId = nextId('sample-code');
  const manual = h('input', { class: 'p-input p-ltr', id: manualId, type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', maxlength: 300, 'aria-describedby': `${manualId}-hint` });
  const form = h('form', { novalidate: true, class: 'p-mt-s' },
    h('div', { class: 'p-field' }, h('label', { class: 'p-label', for: manualId }, t('sample.manualLabel')), h('p', { class: 'p-hint', id: `${manualId}-hint` }, t('sample.manualHint')), manual),
    h('div', { class: 'p-actions' }, h('button', { type: 'submit', class: 'p-btn p-btn--ghost' }, t('sample.find'))));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = manual.value;
    manual.value = '';
    handle(value);
  });
  const el = h('section', { class: 'p-card p-stack', 'aria-labelledby': 'sample-scan-title' },
    h('h2', { class: 'p-h3', id: 'sample-scan-title' }, t('sample.scanTitle')),
    h('p', { class: 'p-muted p-small' }, t('sample.scanLead')),
    status, h('div', { class: 'p-actions' }, start, stop), frame, form);
  const prefill = (value) => { manual.value = value; };
  return { el, stop: stopCamera, status, prefill, submit: () => handle(manual.value) };
}

export function newKey() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
