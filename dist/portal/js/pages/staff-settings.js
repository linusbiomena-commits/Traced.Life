import { api } from '../core/api.js';
import { h, mount, nextId } from '../core/dom.js';
import { lang, t } from '../core/i18n.js';
import { counterpartPath, go } from '../core/paths.js';
import { isValidName, normaliseName } from '../core/rules.js';
import { rememberLanguage, signOut } from '../core/app.js';
import { alertBox, errorMessage, field, newPasswordProblem, pageHeading, passwordField, setBusy, validate } from '../core/ui.js';
import { branchLabel, loadStaff } from './staff-common.js';

// Staff account settings: display name, language, password, sign out. Branch assignments are
// managed by administrators (Phase 5 admin portal; CLI until then).
export default async function render({ app, session }) {
  const staff = await loadStaff();
  const name = field({ label: t('field.fullName'), name: 'name', autocomplete: 'name', value: staff.staff.name || '', required: false, maxlength: 200 });
  const langId = nextId('lang');
  const language = h('select', { class: 'p-select', id: langId },
    h('option', { value: 'en', selected: session.locale === 'en' || undefined }, t('field.language.en')),
    h('option', { value: 'ar', selected: session.locale === 'ar' || undefined }, t('field.language.ar')));
  const pSummary = h('div');
  const pStatus = h('div', { 'aria-live': 'polite' });
  const save = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('common.save'));
  const profile = h('form', { novalidate: true }, pSummary, pStatus, name.wrap,
    h('div', { class: 'p-field' }, h('label', { class: 'p-label', for: langId }, t('field.language')), language), h('div', { class: 'p-actions' }, save));
  profile.addEventListener('submit', async (e) => {
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

  mount(app, h('div', { class: 'p-medium' },
    h('p', { class: 'p-badge p-badge--muted' }, t('staff.portal')),
    h('div', { class: 'p-mt-s' }, pageHeading(t('staff.settings.title'))),
    h('div', { class: 'p-stack' },
      h('section', { class: 'p-card', 'aria-labelledby': 'acc' }, h('h2', { class: 'p-h2', id: 'acc' }, t('settings.account')),
        h('dl', { class: 'p-dl p-mt-m' }, h('dt', {}, t('field.email')), h('dd', { class: 'p-ltr' }, session.email),
          h('dt', {}, t('staff.branch')), h('dd', {}, staff.branches.length ? staff.branches.map(branchLabel).join(' · ') : t('staff.noBranch')))),
      h('section', { class: 'p-card', 'aria-labelledby': 'prof' }, h('h2', { class: 'p-h2', id: 'prof' }, t('settings.profile')), h('div', { class: 'p-mt-m' }, profile)),
      h('section', { class: 'p-card', 'aria-labelledby': 'pw' }, h('h2', { class: 'p-h2', id: 'pw' }, t('settings.changePassword')), h('p', { class: 'p-muted p-mt-s' }, t('settings.changePasswordLead')), h('div', { class: 'p-mt-m' }, pw)),
      h('section', { class: 'p-card', 'aria-labelledby': 'so' }, h('h2', { class: 'p-h2', id: 'so' }, t('settings.signOutTitle')),
        h('div', { class: 'p-actions' }, h('button', { type: 'button', class: 'p-btn p-btn--ghost', onclick: signOut }, t('nav.signOut')))))));
}
