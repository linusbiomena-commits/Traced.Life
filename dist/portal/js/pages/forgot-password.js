import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, emailProblem, errorMessage, field, focusTitle, pageHeading, setBusy, validate } from '../core/ui.js';

export default function render({ app }) {
  const email = field({ label: t('field.email'), name: 'email', type: 'email', autocomplete: 'email', inputmode: 'email', maxlength: 254 });
  const summary = h('div');
  const status = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark p-btn--block' }, t('forgot.submit'));
  const form = h('form', { novalidate: true }, summary, email.wrap, h('div', { class: 'p-actions' }, submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(status);
    const address = email.input.value.trim();
    if (!validate(summary, [[email, emailProblem(address)]])) return;
    setBusy(submit, true);
    try {
      await api('POST', '/auth/password/forgot', { email: address });
      mount(app, h('div', { class: 'p-narrow' },
        pageHeading(t('forgot.doneTitle')),
        h('div', { class: 'p-card p-stack' },
          alertBox('success', null, t('forgot.doneBody', { email: address })),
          h('a', { class: 'p-btn p-btn--ghost p-btn--block', href: pageUrl('sign-in') }, t('forgot.backToSignIn')))));
      focusTitle();
    } catch (err) {
      setBusy(submit, false);
      mount(status, alertBox('error', errorMessage(err)));
    }
  });

  mount(app, h('div', { class: 'p-narrow' },
    pageHeading(t('forgot.title'), t('forgot.lead')),
    h('div', { class: 'p-card' }, status, form),
    h('p', { class: 'p-center p-small p-mt-m' }, h('a', { href: pageUrl('sign-in') }, t('forgot.backToSignIn')))));
}
