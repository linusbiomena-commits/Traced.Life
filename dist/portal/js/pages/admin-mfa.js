import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { go, safeNext } from '../core/paths.js';
import { adminHome, signOut } from '../core/app.js';
import { alertBox, errorMessage, field, focusTitle, pageHeading, setBusy } from '../core/ui.js';

// Two-step verification for privileged roles (required by the server for admin, super admin,
// auditor and lab operator). Enrolment shows a QR rendered by our own server plus the key for
// manual entry, then one-time recovery codes. The secret is never stored in the browser.
export default function render({ app, session }) {
  const next = safeNext(new URLSearchParams(location.search).get('next'));
  const done = async () => {
    const me = await api('GET', '/auth/me');
    go(next || adminHome(me.user));
  };
  const shell = (...children) => mount(app, h('div', { class: 'p-narrow' },
    h('p', { class: 'p-badge p-badge--muted' }, t('admin.portal')), h('div', { class: 'p-mt-s' }, children),
    h('p', { class: 'p-center p-small p-mt-m' }, h('button', { type: 'button', class: 'p-linkbtn', onclick: signOut }, t('nav.signOut')))));

  const codeForm = (label, submitText, onCode, extra) => {
    const code = field({ label, name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 20 });
    const status = h('div', { 'aria-live': 'polite' });
    const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark p-btn--block' }, submitText);
    const form = h('form', { novalidate: true }, status, code.wrap, extra || null, h('div', { class: 'p-actions' }, submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      mount(status);
      const value = code.input.value.replace(/\s/g, '');
      if (!value) {
        mount(status, alertBox('error', t('admin.mfa.codeRequired')));
        code.input.focus();
        return;
      }
      setBusy(submit, true);
      try {
        await onCode(value);
      } catch (err) {
        setBusy(submit, false);
        code.input.value = '';
        mount(status, alertBox('error', errorMessage(err)));
        code.input.focus();
      }
    });
    return form;
  };

  if (session.mfa.enrolled) {
    let useRecovery = false;
    const draw = () => {
      const toggle = h('button', { type: 'button', class: 'p-linkbtn p-small' }, t(useRecovery ? 'admin.mfa.useApp' : 'admin.mfa.useRecovery'));
      toggle.addEventListener('click', () => {
        useRecovery = !useRecovery;
        draw();
      });
      shell(pageHeading(t('admin.mfa.verifyTitle'), t(useRecovery ? 'admin.mfa.recoveryLead' : 'admin.mfa.verifyLead')),
        h('div', { class: 'p-card' }, codeForm(t(useRecovery ? 'admin.mfa.recoveryCode' : 'admin.mfa.code'), t('admin.mfa.verify'), async (value) => {
          await api('POST', '/auth/mfa/verify', useRecovery ? { recoveryCode: value } : { code: value });
          await done();
        }, h('p', { class: 'p-mt-s' }, toggle))));
    };
    draw();
    return;
  }

  // Enrolment.
  const start = h('button', { type: 'button', class: 'p-btn p-btn--dark p-btn--block' }, t('admin.mfa.start'));
  const status = h('div', { 'aria-live': 'polite' });
  start.addEventListener('click', async () => {
    setBusy(start, true);
    try {
      const setup = await api('POST', '/auth/mfa/setup', {});
      shell(pageHeading(t('admin.mfa.setupTitle'), t('admin.mfa.scanLead')),
        h('div', { class: 'p-card p-stack' },
          h('img', { class: 'p-mfa-qr', src: setup.qrImage, alt: t('admin.mfa.qrAlt'), width: 200, height: 200 }),
          h('p', { class: 'p-small p-muted' }, t('admin.mfa.manualKey')),
          h('p', { class: 'p-code', dir: 'ltr' }, setup.secret.replace(/(.{4})/g, '$1 ').trim()),
          codeForm(t('admin.mfa.code'), t('admin.mfa.enable'), async (value) => {
            const res = await api('POST', '/auth/mfa/enable', { code: value });
            shell(pageHeading(t('admin.mfa.recoveryTitle'), t('admin.mfa.recoverySave')),
              h('div', { class: 'p-card p-stack' },
                alertBox('warning', null, t('admin.mfa.recoveryOnce')),
                h('ul', { class: 'p-recovery', dir: 'ltr', 'aria-label': t('admin.mfa.recoveryTitle') }, res.recoveryCodes.map((c) => h('li', {}, c))),
                h('button', { type: 'button', class: 'p-btn p-btn--dark p-btn--block', onclick: done }, t('admin.mfa.saved'))));
            focusTitle();
          })));
      focusTitle();
    } catch (err) {
      setBusy(start, false);
      mount(status, alertBox('error', errorMessage(err)));
    }
  });
  shell(pageHeading(t('admin.mfa.setupTitle'), t('admin.mfa.setupLead')), h('div', { class: 'p-card p-stack' }, status, start));
}
