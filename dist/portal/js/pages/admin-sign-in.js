import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { go, pageUrl, safeNext } from '../core/paths.js';
import { adminHome, isAdmin } from '../core/app.js';
import { alertBox, emailProblem, errorMessage, field, pageHeading, passwordField, setBusy, validate } from '../core/ui.js';

// Admin sign-in: the same authentication API as everyone else (no separate auth system). Admin
// accounts are created by invitation only; two-step verification follows on the next page.
export default function render({ app, session }) {
  const params = new URLSearchParams(location.search);
  const email = field({ label: t('field.email'), name: 'email', type: 'email', autocomplete: 'username', inputmode: 'email', maxlength: 254 });
  const password = passwordField({ label: t('field.password'), name: 'password', autocomplete: 'current-password' });
  const summary = h('div');
  const status = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark p-btn--block' }, t('signIn.submit'));
  if (params.get('signedOut')) status.append(alertBox('success', t('signIn.signedOut')));
  if (session) status.append(alertBox('info', null, t('admin.forbidden.body')));

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
      if (!isAdmin(user)) {
        setBusy(submit, false);
        mount(status, alertBox('error', t('admin.forbidden.title'), t('admin.forbidden.body')));
        return;
      }
      const next = safeNext(params.get('next'));
      if (user.mfa.required && !user.mfa.verified) go(pageUrl('admin-mfa', next ? { next } : undefined));
      else go(next || adminHome(user));
    } catch (err) {
      setBusy(submit, false);
      password.input.value = '';
      mount(status, alertBox('error', errorMessage(err)));
      password.input.focus();
    }
  });

  mount(app, h('div', { class: 'p-narrow' },
    h('p', { class: 'p-badge p-badge--muted' }, t('admin.portal')),
    h('div', { class: 'p-mt-s' }, pageHeading(t('admin.signIn.title'), t('admin.signIn.lead'))),
    h('div', { class: 'p-card' }, status, form)));
}
