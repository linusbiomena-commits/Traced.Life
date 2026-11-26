import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { go, pageUrl, safeNext } from '../core/paths.js';
import { alertBox, emailProblem, errorMessage, field, pageHeading, passwordField, setBusy, validate } from '../core/ui.js';

export default function render({ app }) {
  const params = new URLSearchParams(location.search);
  const email = field({ label: t('field.email'), name: 'email', type: 'email', autocomplete: 'username', inputmode: 'email', maxlength: 254 });
  const password = passwordField({ label: t('field.password'), name: 'password', autocomplete: 'current-password' });
  const summary = h('div');
  const status = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark p-btn--block' }, t('signIn.submit'));

  if (params.get('signedOut')) status.append(alertBox('success', t('signIn.signedOut')));
  if (params.get('passwordChanged')) status.append(alertBox('success', t('signIn.passwordChanged')));

  const form = h('form', { novalidate: true }, summary, email.wrap, password.wrap,
    h('p', { class: 'p-small p-mt-s' }, h('a', { href: pageUrl('forgot-password') }, t('signIn.forgot'))),
    h('div', { class: 'p-actions' }, submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(status);
    const ok = validate(summary, [
      [email, emailProblem(email.input.value)],
      [password, password.input.value ? null : t('v.required', { field: t('field.password') })],
    ]);
    if (!ok) return;
    setBusy(submit, true);
    try {
      const { user } = await api('POST', '/auth/sign-in', { email: email.input.value.trim(), password: password.input.value });
      const next = safeNext(params.get('next'));
      if (user.permissions.includes('collection.scan')) return go(pageUrl('staff-dashboard')); // staff use their own portal
      go(user.emailVerified ? next || pageUrl('dashboard') : pageUrl('verify-email'));
    } catch (err) {
      setBusy(submit, false);
      password.input.value = '';
      mount(status, alertBox('error', errorMessage(err)));
      password.input.focus();
    }
  });

  mount(app, h('div', { class: 'p-narrow' },
    pageHeading(t('signIn.title'), t('signIn.lead')),
    h('div', { class: 'p-card' }, status, form),
    h('p', { class: 'p-center p-small p-mt-m' }, `${t('signIn.noAccount')} `, h('a', { href: pageUrl('sign-up') }, t('signIn.createAccount')))));
}
