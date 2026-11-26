import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { can } from '../core/app.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, focusTitle } from '../core/ui.js';
import { actionForm, adminPage, auditActionLabel, branchText, card, checkbox, control, dl, ltr, roleLabel, select, table, when, yesNo } from './admin-common.js';

// One staff account: details, security status, branches and recent activity, plus the changes
// this administrator may make (the server re-checks authority, self-changes and the last active
// super administrator inside a locked transaction).
export default async function render({ app, session }) {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) {
    mount(app, adminPage(t('admin.staffd.title'), null, alertBox('error', t('error.NOT_FOUND'))));
    return;
  }
  let branches = [];
  if (can(session, 'branch.manage')) {
    try {
      branches = (await api('GET', '/admin/branches')).items;
    } catch {
      branches = [];
    }
  }
  draw(app, await api('GET', `/admin/staff/${encodeURIComponent(id)}`), branches);
}

function draw(app, { staff: s, activity, canManage, grantableRoles }, branches) {
  const after = async (message) => {
    draw(app, await api('GET', `/admin/staff/${encodeURIComponent(s.id)}`), branches);
    document.getElementById('action-result')?.replaceChildren(alertBox('success', message));
    return false;
  };
  const actions = [];
  if (canManage && s.status !== 'deactivated') {
    const roleBoxes = grantableRoles.map((r) => ({ role: r, ...checkbox(roleLabel(r), s.roles.includes(r)) }));
    actions.push(actionForm({
      summary: t('admin.staffd.roles'), intro: t('admin.staffd.rolesIntro'), submitLabel: t('admin.staffd.rolesSubmit'),
      fields: [h('div', { class: 'p-checks' }, roleBoxes.map((b) => b.wrap))],
      run: async (reason) => {
        await api('PUT', `/admin/staff/${s.id}/roles`, { roles: roleBoxes.filter((b) => b.box.checked).map((b) => b.role), reason });
        return after(t('admin.staffd.saved'));
      },
    }));
    if (s.roles.includes('collection_staff') && branches.length) {
      const assigned = new Set(s.branches.map((b) => b.id));
      const boxes = branches.filter((b) => b.active || assigned.has(b.id)).map((b) => ({ id: b.id, ...checkbox(branchText(b), assigned.has(b.id)) }));
      actions.push(actionForm({
        summary: t('admin.staffd.branches'), intro: t('admin.staffd.branchesIntro'), submitLabel: t('admin.staffd.branchesSubmit'),
        fields: [h('div', { class: 'p-checks' }, boxes.map((b) => b.wrap))],
        run: async (reason) => {
          await api('PUT', `/admin/staff/${s.id}/branches`, { branchIds: boxes.filter((b) => b.box.checked).map((b) => b.id), reason });
          return after(t('admin.staffd.saved'));
        },
      }));
    }
    const options = ['active', 'suspended', 'deactivated'].filter((x) => x !== s.status);
    const next = select(options.map((x) => [x, t(`admin.staffd.to.${x}`)]), options[0]);
    actions.push(actionForm({
      summary: t('admin.staffd.status'), intro: t('admin.staffd.statusIntro'), submitLabel: t('admin.staffd.statusSubmit'), danger: true,
      fields: [control(t('admin.staffd.newStatus'), next)],
      run: async (reason) => {
        await api('POST', `/admin/staff/${s.id}/status`, { status: next.value, reason });
        return after(t('admin.staffd.saved'));
      },
    }));
    if (s.invitationPending && s.status === 'active') {
      actions.push(actionForm({
        summary: t('admin.staffd.resend'), intro: t('admin.staffd.resendIntro'), submitLabel: t('admin.staffd.resendSubmit'), reason: false,
        run: async () => { await api('POST', `/admin/staff/${s.id}/resend-invite`, {}); return t('admin.staffd.resent'); },
      }));
    }
  }
  const sec = s.security;
  mount(app, adminPage(s.fullName || s.email, null,
    h('p', {}, h('a', { href: pageUrl('admin-staff') }, t('admin.staffd.back'))),
    h('div', { id: 'action-result', 'aria-live': 'polite' }),
    h('div', { class: 'p-grid' },
      card(t('admin.staffd.account'), dl([
        [t('field.email'), ltr(s.email)],
        [t('admin.col.roles'), s.roles.map(roleLabel).join(', ')],
        [t('admin.col.status'), s.invitationPending && s.status === 'active' ? t('admin.staff.pending') : t(`admin.status.${s.status}`)],
        s.statusReason ? [t('admin.col.reason'), s.statusReason] : null,
        [t('admin.staff.branches'), s.branches.length ? s.branches.map(branchText).join(', ') : '–'],
        [t('admin.cust.created'), when(s.createdAt)],
        [t('admin.cust.lastLogin'), when(s.lastLoginAt)],
      ])),
      card(t('admin.staffd.security'), dl([
        [t('admin.staff.mfa'), yesNo(sec.mfaEnabled)],
        [t('admin.staffd.tempLocked'), yesNo(sec.temporarilyLocked)],
        [t('admin.staffd.failed'), String(sec.failedSignIns)],
        [t('admin.staffd.pwChanged'), when(sec.passwordChangedAt)],
        [t('admin.cust.sessions'), String(sec.activeSessions)],
      ]))),
    actions.length ? card(t('admin.regd.actions'), actions) : h('p', { class: 'p-small p-muted' }, t('admin.staffd.readOnly')),
    card(t('admin.staffd.activity'), table([t('admin.col.time'), t('admin.col.event'), t('admin.col.outcome')],
      activity.map((a) => [when(a.occurredAt), auditActionLabel(a.action), t(`admin.outcome.${a.outcome}`)])))));
  focusTitle();
}
