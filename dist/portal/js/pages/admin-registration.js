import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { formatDate, lang, statusLabel, t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, focusTitle } from '../core/ui.js';
import {
  actionForm, adminPage, ageText, branchText, card, checkbox, control, dl, genderText, input, ltr, relationshipText, select, statusBadge, table, when, yesNo,
} from './admin-common.js';

// Full registration record for authorised administrators. The server audits every view
// (registration.viewed_full) and every action below; actions appear only when the account holds
// the permission and the registration is still awaiting collection.
export default async function render({ app }) {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    mount(app, adminPage(t('admin.regd.title'), null, alertBox('error', t('error.NOT_FOUND'))));
    return;
  }
  const res = await api('GET', `/admin/registrations/${encodeURIComponent(id)}`);
  draw(app, res);
}

function draw(app, { registration: r, permissions, activeBranches }) {
  const refresh = async (message) => {
    const next = await api('GET', `/admin/registrations/${encodeURIComponent(r.id)}`);
    draw(app, next);
    if (message) document.getElementById('action-result')?.replaceChildren(alertBox('success', message));
    return false;
  };
  const p = r.patient;
  const actions = [];
  if (permissions.manage && r.allowed.transfer) {
    const target = select(activeBranches.filter((b) => b.id !== r.branch.id).map((b) => [b.id, branchText(b)]), '');
    const notify = checkbox(t('admin.regd.notifyCustomer'), true);
    actions.push(actionForm({
      summary: t('admin.regd.transfer'), intro: t('admin.regd.transferIntro'), submitLabel: t('admin.regd.transferSubmit'),
      fields: [control(t('admin.regd.newBranch'), target), notify.wrap],
      run: async (reason) => {
        await api('POST', `/admin/registrations/${r.id}/transfer`, { branchId: target.value, reason, notifyCustomer: notify.box.checked });
        return refresh(t('admin.regd.transferred'));
      },
    }));
  }
  if (permissions.manage && r.allowed.correctPatient) {
    const first = input({ value: p.firstName, maxlength: 100, autocomplete: 'off' });
    const last = input({ value: p.lastName, maxlength: 100, autocomplete: 'off' });
    const dob = input({ type: 'date', value: p.dateOfBirth });
    const gender = select([['female', t('reg.gender.female')], ['male', t('reg.gender.male')]], p.gender);
    actions.push(actionForm({
      summary: t('admin.regd.correct'), intro: t('admin.regd.correctIntro'), submitLabel: t('admin.regd.correctSubmit'),
      fields: [h('div', { class: 'p-filter-grid' }, control(t('field.firstName'), first), control(t('field.lastName'), last), control(t('field.dateOfBirth'), dob), control(t('field.gender'), gender))],
      run: async (reason) => {
        await api('PATCH', `/admin/registrations/${r.id}/patient`, { patient: { firstName: first.value.trim(), lastName: last.value.trim(), dateOfBirth: dob.value, gender: gender.value }, reason });
        return refresh(t('admin.regd.corrected'));
      },
    }));
  }
  if (permissions.qr && r.allowed.qr) {
    const notify = checkbox(t('admin.regd.notifyCustomer'), true);
    const regenerate = checkbox(t('admin.regd.issueNew'), true);
    actions.push(actionForm({
      summary: t('admin.regd.revoke'), intro: t('admin.regd.revokeIntro'), submitLabel: t('admin.regd.revokeSubmit'), danger: true,
      fields: [regenerate.wrap, notify.wrap],
      run: async (reason) => {
        await api('POST', `/admin/registrations/${r.id}/qr/revoke`, { reason: reason.slice(0, 200), regenerate: regenerate.box.checked, notifyCustomer: notify.box.checked });
        return refresh(t('admin.regd.revoked'));
      },
    }));
    if (r.qr.status === 'active') {
      actions.push(actionForm({
        summary: t('admin.regd.resendQr'), intro: t('admin.regd.resendQrIntro'), submitLabel: t('admin.regd.resendQrSubmit'),
        run: async (reason) => {
          await api('POST', `/admin/registrations/${r.id}/qr/resend-email`, { reason });
          return t('admin.regd.resent');
        },
      }));
    }
  }
  if (permissions.manage && r.allowed.cancel) {
    actions.push(actionForm({
      summary: t('admin.regd.cancel'), intro: t('admin.regd.cancelIntro'), submitLabel: t('admin.regd.cancelSubmit'), danger: true,
      confirmText: t('admin.regd.cancelConfirm'),
      run: async (reason) => {
        await api('POST', `/admin/registrations/${r.id}/cancel`, { reason });
        return refresh(t('admin.regd.cancelled'));
      },
    }));
  }

  const a = r.accountHolder;
  mount(app, adminPage(t('admin.regd.title'), null,
    h('p', {}, h('a', { href: pageUrl('admin-registrations') }, t('admin.regd.back'))),
    h('div', { id: 'action-result', 'aria-live': 'polite' }),
    card(null,
      h('div', { class: 'p-row p-row--between' }, h('p', { class: 'p-tracking-id', dir: 'ltr' }, r.trackingId || '–'), statusBadge(r.status)),
      h('div', { class: 'p-mt-m' }, dl([
        [t('admin.col.branch'), `${branchText(r.branch)}${r.branch.active ? '' : ` · ${t('admin.branch.inactive')}`}`],
        [t('admin.col.qr'), t(`admin.qr.${r.qr.status}`)],
        [t('admin.col.registered'), when(r.createdAt)],
        r.cancelledAt ? [t('status.cancelled'), when(r.cancelledAt)] : null,
        [t('admin.regd.product'), `TRACED · ${t('staff.sampleHair')} · ${t('admin.regd.saudi')}`],
      ]))),
    actions.length ? card(t('admin.regd.actions'), actions) : null,
    h('div', { class: 'p-grid' },
      card(t('admin.regd.patient'), dl([
        [t('admin.col.patient'), `${p.firstName} ${p.lastName}`],
        [t('field.dateOfBirth'), p.dateOfBirth ? formatDate(p.dateOfBirth) : '–'],
        [t('admin.col.age'), ageText(p.age)],
        [t('field.gender'), genderText(p.gender)],
        [t('admin.regd.relationship'), relationshipText(p.relationship)],
      ])),
      card(t('admin.regd.accountHolder'), dl([
        [t('field.fullName'), a.fullName || r.contact.fullName],
        [t('field.email'), ltr(a.email)],
        [t('admin.regd.emailVerified'), yesNo(a.emailVerified)],
        [t('field.phone'), ltr(a.phone || r.contact.phone)],
        [t('admin.regd.accountStatus'), t(`admin.status.${a.status}`)],
        r.guardian ? [t('admin.regd.guardian'), `${r.guardian.name} (${relationshipText(r.guardian.relationship)})`] : null,
      ]), h('p', { class: 'p-mt-s' }, h('a', { href: pageUrl('admin-customer', { id: a.id }) }, t('admin.regd.openCustomer'))))),
    card(t('admin.regd.contactSnapshot'), dl([[t('field.fullName'), r.contact.fullName], [t('field.email'), ltr(r.contact.email)], [t('field.phone'), ltr(r.contact.phone)]])),
    card(t('admin.regd.collection'), r.collection.length
      ? table([t('admin.col.time'), t('admin.col.branch'), t('admin.regd.collectedBy'), t('admin.regd.instructions'), t('admin.regd.identity'), t('admin.col.status')],
        r.collection.map((s) => [when(s.collectedAt), branchText(s.branch), s.collectedBy.name ? `${s.collectedBy.name} (${s.collectedBy.email})` : s.collectedBy.email,
          `${s.instructionsVersion}${s.instructionsProvisional ? ` · ${t('admin.instr.provisional')}` : ''}`, `${t(`id.status.${s.identityVerification.status}`)} · ${t(`admin.idMethod.${s.identityVerification.method}`)}`, t(`admin.sampleStatus.${s.status}`)]))
      : h('p', { class: 'p-muted' }, t('admin.regd.notCollected')),
      r.identityVerifications.length ? h('div', { class: 'p-mt-m' }, h('h3', { class: 'p-h3' }, t('admin.regd.identityEvents')),
        table([t('admin.col.time'), t('admin.col.status'), t('admin.regd.method'), t('admin.regd.performedBy')],
          r.identityVerifications.map((v) => [when(v.at), t(`id.status.${v.status}`), t(`admin.idMethod.${v.method}`), v.performedBy || '–']))) : null),
    card(t('admin.regd.qrHistory'), table([t('admin.col.status'), t('admin.regd.issued'), t('admin.regd.revokedAt'), t('admin.col.reason'), t('admin.regd.usedAt')],
      r.qr.history.map((q) => [t(`admin.qr.${q.status}`), `${when(q.issuedAt)}${q.issuedBy ? ` · ${q.issuedBy}` : ''}`, q.revokedAt ? `${when(q.revokedAt)}${q.revokedBy ? ` · ${q.revokedBy}` : ''}` : '–', q.revokeReason || '–', when(q.usedAt)])),
      h('p', { class: 'p-small p-muted p-mt-s' }, t('admin.regd.noTokens'))),
    card(t('admin.regd.statusHistory'), table([t('admin.col.time'), t('admin.col.status'), t('admin.col.role'), t('admin.col.reason')],
      r.statusHistory.map((x) => [when(x.at), statusLabel(x.to), x.actorRole ? t(`admin.role.${x.actorRole}`) : '–', x.reason || '–']))),
    r.branchTransfers.length ? card(t('admin.regd.transfers'), table([t('admin.col.time'), t('admin.regd.from'), t('admin.regd.to'), t('admin.col.reason'), t('admin.regd.by')],
      r.branchTransfers.map((x) => [when(x.at), branchText(x.from), branchText(x.to), x.reason, x.actorEmail]))) : null,
    r.patientCorrections.length ? card(t('admin.regd.corrections'), table([t('admin.col.time'), t('admin.regd.fields'), t('admin.regd.previous'), t('admin.col.reason'), t('admin.regd.by')],
      r.patientCorrections.map((x) => [when(x.at), x.changedFields.map((f) => t(`admin.field.${f}`)).join(lang === 'ar' ? '، ' : ', '),
        x.previous ? Object.entries(x.previous).map(([k, v]) => `${t(`admin.prev.${k}`)}: ${v}`).join(' · ') : t('admin.regd.unreadable'), x.reason || '–', x.actorEmail || t(`admin.role.${x.actorRole || 'customer'}`)])),
      h('p', { class: 'p-small p-muted p-mt-s' }, t('admin.regd.correctionsNote'))) : null,
    card(t('admin.regd.consents'), table([t('admin.regd.document'), t('admin.regd.version'), t('admin.regd.acceptedAt')],
      r.consents.map((c) => [c.title, `${c.version}${c.provisional ? ` · ${t('admin.instr.provisional')}` : ''}`, when(c.acceptedAt)]))),
    card(t('admin.regd.emails'), table([t('admin.col.time'), t('admin.email.kind'), t('admin.col.status'), t('admin.email.attempts')],
      r.emails.map((e) => [when(e.createdAt), t(`admin.emailKind.${e.kind}`), t(`admin.emailStatus.${e.status}`), String(e.attempts)])))));
  focusTitle();
}
