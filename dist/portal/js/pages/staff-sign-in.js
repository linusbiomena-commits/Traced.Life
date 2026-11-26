import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { go, pageUrl } from '../core/paths.js';
import { homeFor } from '../core/app.js';
import { alertBox, emailProblem, errorMessage, field, pageHeading, passwordField, setBusy, validate } from '../core/ui.js';

// Staff sign-in uses the same authentication API as customers; staff accounts are created by
// invitation only, so there is no sign-up link here.
export default function render({ app, session }) {
  const params = new URLSearchParams(location.search);
  const email = field({ label: t('field.email'), name: 'email', type: 'email', autocomplete: 'username', inputmode: 'email', maxlength: 254 });
  const password = passwordField({ label: t('field.password'), name: 'password', autocomplete: 'current-password' });
  const summary = h('div');
  const status = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark p-btn--block' }, t('signIn.submit'));
  if (params.get('signedOut')) status.append(alertBox('success', t('signIn.signedOut')));
  if (session?.noPortal) status.append(alertBox('info', t('role.noPortal.title'), t('role.noPortal.body')));

  const form = h('form', { novalidate: true }, summary, email.wrap, password.wrap,
    h('p', { class: 'p-small p-mt-s' }, h('a', { href: pageUrl('forgot-password') }, t('signIn.forgot'))),
    h('div', { class: 'p-actions' }, submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(status);
    if (!validate(summary, [[email, emailProblem(email.input.value)], [password, password.input.value ? null : t('v.required', { field: t('field.password') })]])) return;
    setBusy(submit, true);
    try {
      const { user } = await api('POST', '/auth/sign-in', { email: email.input.value.trim(), password: password.input.value });
      // Every role goes to its own portal (admins via two-step verification), whichever sign-in page was used.
      const home = homeFor(user, params.get('next'));
      if (home) return go(home);
      setBusy(submit, false);
      mount(status, alertBox('info', t('role.noPortal.title'), t('role.noPortal.body')));
    } catch (err) {
      setBusy(submit, false);
      password.input.value = '';
      mount(status, alertBox('error', errorMessage(err)));
      password.input.focus();
    }
  });

  mount(app, h('div', { class: 'p-narrow' },
    h('p', { class: 'p-badge p-badge--muted' }, t('staff.portal')),
    h('div', { class: 'p-mt-s' }, pageHeading(t('staff.signIn.title'), t('staff.signIn.lead'))),
    h('div', { class: 'p-card' }, status, form),
    h('p', { class: 'p-center p-small p-mt-m' }, h('a', { href: pageUrl('sign-in') }, t('staff.signIn.customerLink')))));
}
