import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, focusTitle } from '../core/ui.js';
import { actionForm, adminPage, branchText, card, dl, ltr, relationshipText, statusBadge, table, when, yesNo } from './admin-common.js';

// Customer account view (audited) with the approved Phase 5 actions: lock, unlock and resend the
// verification email. There is deliberately no deletion or deactivation here.
export default async function render({ app }) {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    mount(app, adminPage(t('admin.cust.title'), null, alertBox('error', t('error.NOT_FOUND'))));
    return;
  }
  draw(app, await api('GET', `/admin/customers/${encodeURIComponent(id)}`));
}

function draw(app, { customer: c, permissions }) {
  const after = async (message) => {
    draw(app, await api('GET', `/admin/customers/${encodeURIComponent(c.id)}`));
    document.getElementById('action-result')?.replaceChildren(alertBox('success', message));
    return false;
  };
  const locked = c.status === 'suspended' || c.temporarilyLocked;
  const actions = [];
  if (permissions.manage) {
    if (c.status === 'active') {
      actions.push(actionForm({
        summary: t('admin.cust.lock'), intro: t('admin.cust.lockIntro'), submitLabel: t('admin.cust.lockSubmit'), danger: true,
        run: async (reason) => { await api('POST', `/admin/customers/${c.id}/lock`, { reason }); return after(t('admin.cust.locked')); },
      }));
    }
    if (locked && c.status !== 'deactivated') {
      actions.push(actionForm({
        summary: t('admin.cust.unlock'), intro: t('admin.cust.unlockIntro'), submitLabel: t('admin.cust.unlockSubmit'),
        run: async (reason) => { await api('POST', `/admin/customers/${c.id}/unlock`, { reason }); return after(t('admin.cust.unlocked')); },
      }));
    }
    if (!c.emailVerified && c.status === 'active') {
      actions.push(actionForm({
        summary: t('admin.cust.resend'), intro: t('admin.cust.resendIntro'), submitLabel: t('admin.cust.resendSubmit'), reason: false,
        run: async () => { await api('POST', `/admin/customers/${c.id}/resend-verification`, {}); return t('admin.cust.resent'); },
      }));
    }
  }
  mount(app, adminPage(t('admin.cust.title'), null,
    h('p', {}, h('a', { href: pageUrl('admin-registrations') }, t('admin.regd.back'))),
    h('div', { id: 'action-result', 'aria-live': 'polite' }),
    card(t('admin.cust.account'), dl([
      [t('field.fullName'), c.fullName],
      [t('field.email'), ltr(c.email)],
      [t('field.phone'), ltr(c.phone)],
      [t('admin.regd.emailVerified'), yesNo(c.emailVerified)],
      [t('admin.regd.accountStatus'), `${t(`admin.status.${c.status}`)}${c.temporarilyLocked ? ` · ${t('admin.cust.tempLocked')}` : ''}`],
      c.statusReason ? [t('admin.col.reason'), c.statusReason] : null,
      [t('admin.cust.created'), when(c.createdAt)],
      [t('admin.cust.lastLogin'), when(c.lastLoginAt)],
      [t('admin.cust.adult'), when(c.adultConfirmedAt)],
      [t('admin.cust.sessions'), String(c.activeSessions)],
    ])),
    actions.length ? card(t('admin.regd.actions'), actions) : null,
    card(t('admin.cust.registrations'), table(
      [t('admin.col.trackingId'), t('admin.col.patient'), t('admin.regd.relationship'), t('admin.col.branch'), t('admin.col.status'), t('admin.col.registered')],
      c.registrations.map((r) => [h('a', { href: pageUrl('admin-registration', { id: r.id }) }, ltr(r.trackingId)), `${r.patient.firstName} ${r.patient.lastName}`,
        relationshipText(r.patient.relationship), branchText(r.branch), statusBadge(r.status), when(r.createdAt)])))));
  focusTitle();
}
