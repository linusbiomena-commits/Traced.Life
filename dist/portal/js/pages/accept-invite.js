import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageUrl, takeHashToken } from '../core/paths.js';
import { alertBox, errorMessage, focusTitle, newPasswordProblem, pageHeading, passwordField, setBusy, validate } from '../core/ui.js';

// Invitation acceptance for staff and admin accounts (link from the invitation email).
export default function render({ app, page }) {
  const admin = page === 'admin-accept-invite';
  const token = takeHashToken(); // kept in memory only; already removed from the address bar
  if (!token) {
    mount(app, h('div', { class: 'p-narrow' }, pageHeading(t('invite.title')), h('div', { class: 'p-card' }, alertBox('info', t('invite.missing')))));
    return;
  }
  const password = passwordField({ label: t('field.newPassword'), name: 'new-password', autocomplete: 'new-password', hint: t('field.passwordHint') });
  const summary = h('div');
  const status = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark p-btn--block' }, t('invite.submit'));
  const form = h('form', { novalidate: true }, summary, password.wrap, h('div', { class: 'p-actions' }, submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(status);
    if (!validate(summary, [[password, newPasswordProblem(password.input.value)]])) return;
    setBusy(submit, true);
    try {
      await api('POST', '/auth/account-setup', { token, password: password.input.value });
      mount(app, h('div', { class: 'p-narrow' }, pageHeading(t('invite.title')),
        h('div', { class: 'p-card p-stack' }, alertBox('success', null, admin ? t('invite.adminDone') : t('invite.done')),
          admin ? null : h('a', { class: 'p-btn p-btn--dark p-btn--block', href: pageUrl('staff-sign-in') }, t('common.goToSignIn')))));
      focusTitle();
    } catch (err) {
      setBusy(submit, false);
      mount(status, alertBox('error', errorMessage(err)));
    }
  });

  mount(app, h('div', { class: 'p-narrow' }, pageHeading(t('invite.title'), t('invite.lead')), h('div', { class: 'p-card' }, status, form)));
}
