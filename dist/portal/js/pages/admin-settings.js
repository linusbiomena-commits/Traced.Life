import { api } from '../core/api.js';
import { h, mount, nextId } from '../core/dom.js';
import { lang, t } from '../core/i18n.js';
import { counterpartPath, go } from '../core/paths.js';
import { isValidName, normaliseName } from '../core/rules.js';
import { rememberLanguage, signOut } from '../core/app.js';
import { alertBox, errorMessage, field, newPasswordProblem, pageHeading, passwordField, setBusy, validate } from '../core/ui.js';
import { roleLabel, yesNo } from './admin-common.js';

// Administrator account settings: name, language, password, two-step status, sign out.
export default async function render({ app, session }) {
  const profile = await api('GET', '/me/profile');
  const name = field({ label: t('field.fullName'), name: 'name', autocomplete: 'name', value: profile.profile?.fullName || '', required: false, maxlength: 200 });
  const langId = nextId('lang');
  const language = h('select', { class: 'p-select', id: langId },
    h('option', { value: 'en', selected: session.locale === 'en' || undefined }, t('field.language.en')),
    h('option', { value: 'ar', selected: session.locale === 'ar' || undefined }, t('field.language.ar')));
  const pSummary = h('div');
  const pStatus = h('div', { 'aria-live': 'polite' });
  const save = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('common.save'));
  const prof = h('form', { novalidate: true }, pSummary, pStatus, name.wrap,
    h('div', { class: 'p-field' }, h('label', { class: 'p-label', for: langId }, t('field.language')), language), h('div', { class: 'p-actions' }, save));
  prof.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(pStatus);
    const n = normaliseName(name.input.value);
    if (!validate(pSummary, [[name, n && !isValidName(n, 200) ? t('v.name') : null]])) return;
    setBusy(save, true, t('common.saving'));
    try {
      await api('PATCH', '/me/profile', { fullName: n || null, locale: language.value });
      if (language.value !== lang) {
        rememberLanguage(language.value);
        return go(counterpartPath());
      }
      mount(pStatus, alertBox('success', t('settings.profileSaved')));
    } catch (err) {
      mount(pStatus, alertBox('error', errorMessage(err)));
    } finally {
      setBusy(save, false);
    }
  });

  const current = passwordField({ label: t('field.currentPassword'), name: 'current-password', autocomplete: 'current-password' });
  const next = passwordField({ label: t('field.newPassword'), name: 'new-password', autocomplete: 'new-password', hint: t('field.passwordHint') });
  const wSummary = h('div');
  const wStatus = h('div', { 'aria-live': 'polite' });
  const savePw = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('settings.updatePassword'));
  const pw = h('form', { novalidate: true }, wSummary, wStatus, current.wrap, next.wrap, h('div', { class: 'p-actions' }, savePw));
  pw.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(wStatus);
    if (!validate(wSummary, [[current, current.input.value ? null : t('v.required', { field: t('field.currentPassword') })], [next, newPasswordProblem(next.input.value, session.email)]])) return;
    setBusy(savePw, true, t('common.saving'));
    try {
      await api('POST', '/auth/password/change', { currentPassword: current.input.value, newPassword: next.input.value });
      current.input.value = '';
      next.input.value = '';
      mount(wStatus, alertBox('success', t('settings.passwordChanged')));
    } catch (err) {
      mount(wStatus, alertBox('error', errorMessage(err)));
    } finally {
      setBusy(savePw, false);
    }
  });

  // Phase 7: replace recovery codes (old ones stop working). Needs a current authenticator code.
  const rcCode = h('input', { class: 'p-input', id: nextId('rc'), inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, dir: 'ltr' });
  const rcStatus = h('div', { 'aria-live': 'polite' });
  const rcBtn = h('button', { type: 'submit', class: 'p-btn p-btn--ghost' }, t('admin.settings.newCodes'));
  const rc = h('form', { novalidate: true }, rcStatus,
    h('div', { class: 'p-field' }, h('label', { class: 'p-label', for: rcCode.id }, t('admin.mfa.code')), rcCode),
    h('div', { class: 'p-actions' }, rcBtn));
  rc.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(rcStatus);
    if (!/^\d{6}$/.test(rcCode.value.trim())) {
      mount(rcStatus, alertBox('error', t('admin.export.needCode')));
      return;
    }
    setBusy(rcBtn, true);
    try {
      const res = await api('POST', '/auth/mfa/recovery-codes', { code: rcCode.value.trim() });
      mount(rcStatus, alertBox('warning', null, t('admin.mfa.recoveryOnce')),
        h('ul', { class: 'p-recovery', dir: 'ltr', 'aria-label': t('admin.mfa.recoveryTitle') }, res.recoveryCodes.map((c) => h('li', {}, c))));
    } catch (err) {
      mount(rcStatus, alertBox('error', errorMessage(err)));
    } finally {
      rcCode.value = '';
      setBusy(rcBtn, false);
    }
  });

  mount(app, h('div', { class: 'p-medium' },
    h('p', { class: 'p-badge p-badge--muted' }, t('admin.portal')),
    h('div', { class: 'p-mt-s' }, pageHeading(t('admin.settings.title'))),
    h('div', { class: 'p-stack' },
      h('section', { class: 'p-card', 'aria-labelledby': 'acc' }, h('h2', { class: 'p-h2', id: 'acc' }, t('settings.account')),
        h('dl', { class: 'p-dl p-mt-m' },
          h('dt', {}, t('field.email')), h('dd', { class: 'p-ltr' }, session.email),
          h('dt', {}, t('admin.col.roles')), h('dd', {}, session.roles.map(roleLabel).join(', ')),
          h('dt', {}, t('admin.staff.mfa')), h('dd', {}, yesNo(session.mfa.enrolled)))),
      h('section', { class: 'p-card', 'aria-labelledby': 'prof' }, h('h2', { class: 'p-h2', id: 'prof' }, t('settings.profile')), h('div', { class: 'p-mt-m' }, prof)),
      h('section', { class: 'p-card', 'aria-labelledby': 'pw' }, h('h2', { class: 'p-h2', id: 'pw' }, t('settings.changePassword')), h('p', { class: 'p-muted p-mt-s' }, t('admin.settings.passwordNote')), h('div', { class: 'p-mt-m' }, pw)),
      session.mfa.enrolled ? h('section', { class: 'p-card', 'aria-labelledby': 'rcodes' }, h('h2', { class: 'p-h2', id: 'rcodes' }, t('admin.settings.codesTitle')),
        h('p', { class: 'p-muted p-mt-s' }, t('admin.settings.codesNote')), h('div', { class: 'p-mt-m' }, rc)) : null,
      h('section', { class: 'p-card', 'aria-labelledby': 'so' }, h('h2', { class: 'p-h2', id: 'so' }, t('settings.signOutTitle')),
        h('div', { class: 'p-actions' }, h('button', { type: 'button', class: 'p-btn p-btn--ghost', onclick: signOut }, t('nav.signOut')))))));
}
