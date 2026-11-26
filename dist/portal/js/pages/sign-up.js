import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { lang, t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, checkboxField, emailProblem, errorMessage, field, focusTitle, newPasswordProblem, pageHeading, passwordField, setBusy, validate } from '../core/ui.js';

export default function render({ app }) {
  const email = field({ label: t('field.email'), name: 'email', type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: 254 });
  const password = passwordField({ label: t('field.password'), name: 'new-password', autocomplete: 'new-password', hint: t('field.passwordHint') });
  const adult = checkboxField({ label: t('signUp.adult'), name: 'confirm-adult' });
  const summary = h('div');
  const status = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark p-btn--block' }, t('signUp.submit'));
  const form = h('form', { novalidate: true }, summary, email.wrap, password.wrap, adult.wrap, h('div', { class: 'p-actions' }, submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(status);
    const address = email.input.value.trim();
    const ok = validate(summary, [
      [email, emailProblem(address)],
      [password, newPasswordProblem(password.input.value, address)],
      [adult, adult.input.checked ? null : t('v.adult')],
    ]);
    if (!ok) return;
    setBusy(submit, true);
    try {
      await api('POST', '/auth/sign-up', { email: address, password: password.input.value, locale: lang, confirmAdult: true });
      mount(app, h('div', { class: 'p-narrow' },
        pageHeading(t('signUp.doneTitle')),
        h('div', { class: 'p-card p-stack' },
          alertBox('success', null, t('signUp.doneBody', { email: address })),
          h('p', { class: 'p-muted p-small' }, t('signUp.doneHint')),
          h('a', { class: 'p-btn p-btn--dark p-btn--block', href: pageUrl('sign-in') }, t('common.goToSignIn')))));
      focusTitle();
    } catch (err) {
      setBusy(submit, false);
      mount(status, alertBox('error', errorMessage(err)));
    }
  });

  mount(app, h('div', { class: 'p-narrow' },
    pageHeading(t('signUp.title'), t('signUp.lead')),
    h('div', { class: 'p-card' }, status, form),
    h('p', { class: 'p-center p-small p-mt-m' }, `${t('signUp.haveAccount')} `, h('a', { href: pageUrl('sign-in') }, t('signUp.signIn')))));
}
