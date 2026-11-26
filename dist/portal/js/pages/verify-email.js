import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageUrl, takeHashToken } from '../core/paths.js';
import { alertBox, errorMessage, pageHeading, setBusy } from '../core/ui.js';

export default async function render({ app, session }) {
  const token = takeHashToken();
  const body = h('div', { class: 'p-card p-stack', 'aria-live': 'polite' });
  mount(app, h('div', { class: 'p-narrow' }, pageHeading(t('verify.title')), body));

  const continueLink = () =>
    session ? h('a', { class: 'p-btn p-btn--dark p-btn--block', href: pageUrl('dashboard') }, t('common.goToDashboard'))
      : h('a', { class: 'p-btn p-btn--dark p-btn--block', href: pageUrl('sign-in') }, t('common.goToSignIn'));

  const resendBlock = () => {
    if (!session) return h('p', {}, h('a', { href: pageUrl('sign-in') }, t('verify.signInToResend')));
    const out = h('div', { 'aria-live': 'polite' });
    const btn = h('button', { type: 'button', class: 'p-btn p-btn--ghost p-btn--block' }, t('verify.resend'));
    btn.addEventListener('click', async () => {
      setBusy(btn, true);
      try {
        await api('POST', '/auth/verify-email/resend', {});
        mount(out, alertBox('success', t('verify.resent')));
      } catch (err) {
        mount(out, alertBox('error', errorMessage(err)));
      } finally {
        setBusy(btn, false);
      }
    });
    return h('div', { class: 'p-stack' }, btn, out);
  };

  if (token) {
    mount(body, h('p', { class: 'p-loading', role: 'status' }, t('verify.checking')));
    try {
      await api('POST', '/auth/verify-email', { token });
      if (session) session.emailVerified = true;
      mount(body, alertBox('success', t('verify.successTitle'), t('verify.successBody')), continueLink());
    } catch (err) {
      mount(body, alertBox('error', errorMessage(err)), session && !session.emailVerified ? resendBlock() : continueLink());
    }
    return;
  }

  if (session?.emailVerified) {
    mount(body, alertBox('success', t('verify.already')), continueLink());
  } else if (session) {
    mount(body, h('p', {}, t('verify.pendingBody', { email: session.email })), resendBlock());
  } else {
    mount(body, h('p', {}, t('verify.signInToResend')), continueLink());
  }
}
