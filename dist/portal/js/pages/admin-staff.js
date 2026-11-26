import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { can } from '../core/app.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, errorMessage, loading, setBusy } from '../core/ui.js';
import { adminPage, branchText, card, checkbox, control, input, ltr, qs, roleLabel, select, table, when, yesNo } from './admin-common.js';

// Staff accounts: list, filters and invitations. Only roles the server says this account may
// grant are offered (admins: collection staff and lab operators; super admins: all staff roles).
export default async function render({ app, session }) {
  const q = input({ type: 'search', maxlength: 200 });
  const role = select([['', t('admin.filter.any')], ...['collection_staff', 'lab_operator', 'admin', 'auditor', 'super_admin'].map((r) => [r, roleLabel(r)])], '');
  const status = select([['', t('admin.filter.any')], ['active', t('admin.status.active')], ['pending', t('admin.staff.pending')], ['suspended', t('admin.status.suspended')], ['deactivated', t('admin.status.deactivated')]], '');
  const list = h('div', {}, loading());
  let branches = [];
  if (can(session, 'branch.manage')) {
    try {
      branches = (await api('GET', '/admin/branches')).items.filter((b) => b.active);
    } catch {
      branches = [];
    }
  }

  let grantable = [];
  const load = async () => {
    mount(list, loading());
    try {
      const res = await api('GET', `/admin/staff${qs({ q: q.value.trim(), role: role.value, status: status.value })}`);
      grantable = res.grantableRoles;
      mount(list, table(
        [t('admin.col.name'), t('field.email'), t('admin.col.roles'), t('admin.col.status'), t('admin.staff.branches'), t('admin.staff.mfa'), t('admin.cust.lastLogin')],
        res.items.map((u) => [
          h('a', { href: pageUrl('admin-staff-member', { id: u.id }) }, u.fullName || u.email),
          ltr(u.email), u.roles.map(roleLabel).join(', '),
          u.invitationPending && u.status === 'active' ? t('admin.staff.pending') : t(`admin.status.${u.status}`),
          u.branches.length ? u.branches.map(branchText).join(', ') : '–', yesNo(u.mfaEnabled), when(u.lastLoginAt),
        ]), { caption: t('admin.staff.title') }));
      drawInvite();
    } catch (err) {
      mount(list, alertBox('error', errorMessage(err)));
    }
  };

  const inviteHost = h('div');
  const notice = h('div', { 'aria-live': 'polite' });
  const drawInvite = () => {
    if (!grantable.length) return mount(inviteHost);
    if (inviteHost.firstChild) return; // keep the form (and any message) across list reloads
    const email = input({ type: 'email', maxlength: 254, autocomplete: 'off' });
    const name = input({ maxlength: 200, autocomplete: 'off' });
    const locale = select([['en', t('field.language.en')], ['ar', t('field.language.ar')]], 'en');
    const roleBoxes = grantable.map((r) => ({ role: r, ...checkbox(roleLabel(r), r === 'collection_staff') }));
    const branchBoxes = branches.map((b) => ({ id: b.id, ...checkbox(branchText(b)) }));
    const status2 = h('div', { 'aria-live': 'polite' });
    const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('admin.staff.inviteSubmit'));
    const form = h('form', { novalidate: true, class: 'p-stack' },
      h('div', { class: 'p-filter-grid' }, control(t('field.email'), email), control(t('field.fullName'), name), control(t('field.language'), locale)),
      h('fieldset', {}, h('legend', { class: 'p-label' }, t('admin.col.roles')), h('div', { class: 'p-checks' }, roleBoxes.map((b) => b.wrap))),
      branchBoxes.length ? h('fieldset', {}, h('legend', { class: 'p-label' }, t('admin.staff.branches')), h('p', { class: 'p-hint' }, t('admin.staff.branchesHint')), h('div', { class: 'p-checks' }, branchBoxes.map((b) => b.wrap))) : null,
      status2, h('div', { class: 'p-actions' }, submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      mount(status2);
      const roles = roleBoxes.filter((b) => b.box.checked).map((b) => b.role);
      if (!email.value.trim() || !name.value.trim() || !roles.length) {
        mount(status2, alertBox('error', t('admin.staff.inviteMissing')));
        return;
      }
      setBusy(submit, true);
      try {
        const res = await api('POST', '/admin/staff', {
          email: email.value.trim(), fullName: name.value.trim(), roles, locale: locale.value,
          branchIds: roles.includes('collection_staff') ? branchBoxes.filter((b) => b.box.checked).map((b) => b.id) : [],
        });
        mount(status2, alertBox('success', t('admin.staff.invited', { email: res.staff.email })));
        mount(notice, alertBox('success', t('admin.staff.invited', { email: res.staff.email })));
        email.value = '';
        name.value = '';
        await load();
      } catch (err) {
        mount(status2, alertBox('error', errorMessage(err)));
      } finally {
        setBusy(submit, false);
      }
    });
    mount(inviteHost, card(t('admin.staff.invite'), h('p', { class: 'p-muted p-small' }, t('admin.staff.inviteLead')), h('div', { class: 'p-mt-m' }, form)));
  };

  const filters = h('form', { class: 'p-filter-grid', novalidate: true }, control(t('admin.staff.search'), q), control(t('admin.col.roles'), role), control(t('admin.col.status'), status),
    h('div', { class: 'p-actions' }, h('button', { type: 'submit', class: 'p-btn p-btn--ghost' }, t('admin.filter.apply'))));
  filters.addEventListener('submit', (e) => {
    e.preventDefault();
    load();
  });
  mount(app, adminPage(t('admin.staff.title'), t('admin.staff.lead'), notice, h('div', { class: 'p-card' }, filters), list, inviteHost));
  await load();
}
