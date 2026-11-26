import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, focusTitle } from '../core/ui.js';
import { actionForm, adminPage, card, control, dl, ltr, roleLabel, select, table, when } from './admin-common.js';
import { branchShort, sampleBadge, sampleStatus } from './sample-common.js';

const STATUSES = ['collected', 'packaged', 'ready_for_dispatch', 'dispatched', 'in_transit', 'received_by_laboratory', 'analysis_in_progress', 'analysis_completed', 'report_available', 'rejected'];

// One physical sample: complete custody timeline (append-only), dispatch and receipt details,
// label prints, corrections (appended, never edits) and recollection authorisation.
export default async function render({ app }) {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return mount(app, adminPage(t('admin.sample.title'), null, alertBox('error', t('error.NOT_FOUND'))));
  draw(app, await api('GET', `/admin/samples/${encodeURIComponent(id)}`));
}

function draw(app, { sample: s, permissions }) {
  const after = async (message) => {
    draw(app, await api('GET', `/admin/samples/${encodeURIComponent(s.id)}`));
    document.getElementById('action-result')?.replaceChildren(alertBox('success', message));
    return false;
  };
  const handover = (e) => [
    e.handover?.courier ? `${t('sample.courier')}: ${e.handover.courier}` : null,
    e.handover?.shipmentTrackingNumber ? `${t('sample.shipmentTracking')}: ${e.handover.shipmentTrackingNumber}` : null,
    e.handover?.verification ? t(`admin.sample.verification.${e.handover.verification}`) : null,
    e.condition ? `${t('lab.condition')}: ${t(`sample.condition.${e.condition}`)}` : null,
    e.reasonCategory ? `${t('sample.rejectReason')}: ${t(`sample.reason.${e.reasonCategory}`)}` : null,
  ].filter(Boolean).join(' · ') || '–';
  const actions = [];
  if (permissions.correct) {
    const eventSel = select(s.events.map((e) => [String(e.id), `#${e.id} · ${sampleStatus(e.to)} · ${when(e.at)}`]), String(s.events.at(-1)?.id));
    const toSel = select(STATUSES.map((x) => [x, sampleStatus(x)]), s.status);
    actions.push(actionForm({
      summary: t('admin.sample.correct'), intro: t('admin.sample.correctIntro'), submitLabel: t('admin.sample.correctSubmit'), danger: true,
      fields: [h('div', { class: 'p-filter-grid' }, control(t('admin.sample.eventToCorrect'), eventSel), control(t('admin.sample.correctTo'), toSel))],
      run: async (reason) => { await api('POST', `/admin/samples/${s.id}/correct`, { eventId: Number(eventSel.value), toStatus: toSel.value, reason }); return after(t('admin.sample.corrected')); },
    }));
  }
  if (permissions.authorizeRecollection) {
    actions.push(actionForm({
      summary: t('admin.sample.recollect'), intro: t('admin.sample.recollectIntro'), submitLabel: t('admin.sample.recollectSubmit'),
      confirmText: t('admin.sample.recollectConfirm'),
      run: async (reason) => { await api('POST', `/admin/registrations/${s.registrationId}/recollection`, { reason }); return after(t('admin.sample.recollected')); },
    }));
  }
  mount(app, adminPage(t('admin.sample.title'), null,
    h('p', {}, h('a', { href: pageUrl('admin-samples') }, t('admin.sample.back'))),
    h('div', { id: 'action-result', 'aria-live': 'polite' }),
    card(null,
      h('div', { class: 'p-row p-row--between' }, h('p', { class: 'p-tracking-id', dir: 'ltr' }, s.sampleId), sampleBadge(s.status)),
      h('div', { class: 'p-mt-m' }, dl([
        [t('admin.col.trackingId'), h('a', { href: pageUrl('admin-registration', { id: s.registrationId }) }, ltr(s.trackingId))],
        [t('staff.sampleType'), t('staff.sampleHair')],
        [t('admin.col.branch'), branchShort(s.branch)],
        [t('staff.collectedAt'), when(s.collectedAt)],
        [t('lab.since'), when(s.statusChangedAt)],
        [t('admin.sample.otherSamples'), s.registrationSamples.map((x) => (x.id === s.id ? x.sampleId : `${x.sampleId} (${sampleStatus(x.status)})`)).join(' · ')],
        s.recollection ? [t('admin.sample.recollection'), `${when(s.recollection.at)} · ${s.recollection.by} · ${s.recollection.reason}`] : null,
      ])),
      h('p', { class: 'p-mt-s' }, h('a', { href: pageUrl('admin-sample-label', { id: s.id }) }, t('sample.printLabel')))),
    actions.length ? card(t('admin.regd.actions'), actions) : null,
    card(t('admin.sample.timeline'), table([t('admin.col.time'), t('admin.sample.step'), t('admin.sample.location'), t('admin.audit.actor'), t('admin.sample.details'), t('sample.remarks')],
      s.events.map((e) => [when(e.at),
        h('span', {}, e.type === 'correction' ? `${t('admin.sample.correction')} #${e.correctsEventId} → ` : '', sampleStatus(e.to), e.from ? h('span', { class: 'p-small p-muted' }, ` (${t('admin.sample.from')} ${sampleStatus(e.from)})`) : null),
        `${t(`admin.sample.loc.${e.locationType}`)}${e.branchCode ? ` · ${e.branchCode}` : ''}${e.identifiedBy ? ` · ${t(`admin.sample.id.${e.identifiedBy}`)}` : ''}`,
        h('span', {}, roleLabel(e.actorRole), h('br'), ltr(e.recordedBy)), handover(e), e.remarks || '–'])),
      h('p', { class: 'p-small p-muted p-mt-s' }, t('admin.sample.appendOnly'))),
    card(t('admin.sample.prints'), table([t('admin.col.time'), t('label.sizeLabel'), t('admin.sample.reprint'), t('admin.col.reason'), t('admin.regd.by')],
      s.labelPrints.map((p) => [when(p.at), p.size.replace('x', ' × '), t(p.reprint ? 'admin.yes' : 'admin.no'), p.reason || '–', p.by]))),
    card(t('admin.sample.qr'), table([t('admin.col.status'), t('admin.regd.issued'), t('admin.regd.revokedAt')], s.qr.map((q) => [t(`admin.qr.${q.status}`), when(q.issuedAt), when(q.revokedAt)])),
      h('p', { class: 'p-small p-muted p-mt-s' }, t('admin.regd.noTokens')))));
  focusTitle();
}
