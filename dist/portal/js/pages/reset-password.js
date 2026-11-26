import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageUrl, takeHashToken } from '../core/paths.js';
import { alertBox, errorMessage, focusTitle, newPasswordProblem, pageHeading, passwordField, setBusy, validate } from '../core/ui.js';

export default function render({ app }) {
  const token = takeHashToken(); // kept in memory only; removed from the address bar
  if (!token) {
    mount(app, h('div', { class: 'p-narrow' }, pageHeading(t('reset.title')),
      h('div', { class: 'p-card p-stack' }, alertBox('info', t('reset.missingToken')),
        h('a', { class: 'p-btn p-btn--dark p-btn--block', href: pageUrl('forgot-password') }, t('reset.requestNew')))));
    return;
  }

  const password = passwordField({ label: t('field.newPassword'), name: 'new-password', autocomplete: 'new-password', hint: t('field.passwordHint') });
  const summary = h('div');
  const status = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark p-btn--block' }, t('reset.submit'));
  const form = h('form', { novalidate: true }, summary, password.wrap, h('div', { class: 'p-actions' }, submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(status);
    if (!validate(summary, [[password, newPasswordProblem(password.input.value)]])) return;
    setBusy(submit, true);
    try {
      await api('POST', '/auth/password/reset', { token, password: password.input.value });
      mount(app, h('div', { class: 'p-narrow' }, pageHeading(t('reset.doneTitle')),
        h('div', { class: 'p-card p-stack' }, alertBox('success', null, t('reset.doneBody')),
          h('a', { class: 'p-btn p-btn--dark p-btn--block', href: pageUrl('sign-in') }, t('common.goToSignIn')))));
      focusTitle();
    } catch (err) {
      setBusy(submit, false);
      const extra = err.code === 'INVALID_OR_EXPIRED_TOKEN' ? h('p', { class: 'p-mt-s' }, h('a', { href: pageUrl('forgot-password') }, t('reset.requestNew'))) : null;
      mount(status, alertBox('error', errorMessage(err), null, extra));
    }
  });

  mount(app, h('div', { class: 'p-narrow' }, pageHeading(t('reset.title'), t('reset.lead')), h('div', { class: 'p-card' }, status, form)));
}
