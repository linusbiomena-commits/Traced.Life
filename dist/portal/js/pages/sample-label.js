import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { formatDate, t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, errorMessage, focusTitle, pageHeading, setBusy } from '../core/ui.js';

// Physical sample label (staff for their branches; admins). Content: TRACED, registration tracking
// ID, physical sample ID, sample QR, sample type and collection date. Nothing personal. Printing
// uses the browser's print dialog (thermal printers work through their normal driver; "Save as
// PDF" gives a PDF). Each print is recorded; reprints need a reason. Physical printer
// compatibility is not claimed until tested with the real printer and labels.
export default async function render({ app, page }) {
  const admin = page === 'admin-sample-label';
  const base = admin ? '/admin' : '/staff';
  const id = new URLSearchParams(location.search).get('id');
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    mount(app, h('div', { class: 'p-narrow' }, pageHeading(t('label.title')), alertBox('error', t('error.NOT_FOUND'))));
    return;
  }
  const { label } = await api('GET', `${base}/samples/${id}/label`);
  let prints = label.prints;
  let size = label.sizes[0];

  const qrSrc = `/api/v1${base}/samples/${id}/qr.svg`;
  const preview = h('div', { class: 'p-slabel-preview' });
  const drawLabel = () => mount(preview, h('div', { class: `p-slabel p-slabel--${size}`, dir: 'ltr', lang: 'en' },
    h('img', { class: 'p-slabel__qr', src: qrSrc, alt: t('label.qrAlt') }),
    h('div', { class: 'p-slabel__text' },
      h('p', { class: 'p-slabel__brand' }, 'TRACED'),
      h('p', { class: 'p-slabel__id' }, label.sampleId),
      h('p', { class: 'p-slabel__line' }, label.trackingId),
      h('p', { class: 'p-slabel__line' }, `Hair · شعر · ${label.collectedOn}`))));
  drawLabel();

  const sizeSelect = h('select', { class: 'p-select', id: 'label-size' }, label.sizes.map((s) => h('option', { value: s }, t('label.size', { size: s.replace('x', ' × ') }))));
  sizeSelect.addEventListener('change', () => { size = sizeSelect.value; drawLabel(); });
  const reason = h('textarea', { class: 'p-textarea', rows: 2, maxlength: 500, id: 'reprint-reason' });
  const reasonField = h('div', { class: 'p-field', hidden: prints === 0 },
    h('label', { class: 'p-label', for: 'reprint-reason' }, t('label.reprintReason')), h('p', { class: 'p-hint' }, t('label.reprintHint')), reason);
  const status = h('div', { 'aria-live': 'polite' });
  const printBtn = h('button', { type: 'button', class: 'p-btn p-btn--dark' }, prints === 0 ? t('label.print') : t('label.reprint'));
  const count = h('p', { class: 'p-small p-muted' });
  const drawCount = () => { count.textContent = t('label.printed', { n: prints }); };
  drawCount();
  printBtn.addEventListener('click', async () => {
    mount(status);
    if (prints > 0 && reason.value.trim().length < 5) {
      mount(status, alertBox('error', t('error.REPRINT_REASON_REQUIRED')));
      reason.focus();
      return;
    }
    setBusy(printBtn, true);
    try {
      const res = await api('POST', `${base}/samples/${id}/label-print`, { size, ...(prints > 0 ? { reason: reason.value.trim() } : {}) });
      prints = res.printNumber;
      reason.value = '';
      reasonField.hidden = false;
      printBtn.dataset.label = t('label.reprint'); // setBusy(false) restores this saved label
      drawCount();
      window.print();
    } catch (err) {
      mount(status, alertBox('error', errorMessage(err)));
    } finally {
      setBusy(printBtn, false);
    }
  });

  mount(app, h('div', { class: 'p-medium' },
    h('div', { class: 'p-noprint' },
      h('p', { class: 'p-badge p-badge--muted' }, t(admin ? 'admin.portal' : 'staff.portal')),
      h('div', { class: 'p-mt-s' }, pageHeading(t('label.title'), t('label.lead'))),
      h('p', {}, h('a', { href: admin ? pageUrl('admin-sample', { id }) : pageUrl('staff-samples') }, t('label.back')))),
    h('div', { class: 'p-stack' },
      h('section', { class: 'p-card p-stack p-noprint' },
        h('dl', { class: 'p-dl' },
          h('dt', {}, t('label.sampleId')), h('dd', { class: 'p-ltr', dir: 'ltr' }, label.sampleId),
          h('dt', {}, t('staff.trackingId')), h('dd', { class: 'p-ltr', dir: 'ltr' }, label.trackingId),
          h('dt', {}, t('staff.collectedAt')), h('dd', {}, formatDate(label.collectedOn))),
        h('div', { class: 'p-field' }, h('label', { class: 'p-label', for: 'label-size' }, t('label.sizeLabel')), h('p', { class: 'p-hint' }, t('label.sizeHint')), sizeSelect),
        reasonField, status, h('div', { class: 'p-actions' }, printBtn,
          h('a', { class: 'p-btn p-btn--ghost', href: `/api/v1${base}/samples/${id}/qr.png`, download: '' }, t('label.downloadPng')),
          h('a', { class: 'p-btn p-btn--ghost', href: qrSrc, download: '' }, t('label.downloadSvg'))),
        count, h('p', { class: 'p-small p-muted' }, t('label.privacy'))),
      h('section', { class: 'p-card', 'aria-label': t('label.previewTitle') },
        h('h2', { class: 'p-h3 p-noprint' }, t('label.previewTitle')), h('div', { class: 'p-mt-m' }, preview)))));
  focusTitle();
}
