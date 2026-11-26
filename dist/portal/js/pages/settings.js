import { api } from '../core/api.js';
import { h, mount, nextId } from '../core/dom.js';
import { lang, t } from '../core/i18n.js';
import { counterpartPath, go } from '../core/paths.js';
import { formatSaudiMobile, isValidName, normaliseName, normaliseSaudiMobile } from '../core/rules.js';
import { rememberLanguage, signOut } from '../core/app.js';
import { alertBox, errorMessage, field, newPasswordProblem, pageHeading, passwordField, setBusy, validate } from '../core/ui.js';

export default async function render({ app, session }) {
  const { profile } = await api('GET', '/me/profile');

  // ---- Profile -----------------------------------------------------------------------------
  const fullName = field({ label: t('field.fullName'), name: 'name', autocomplete: 'name', value: profile.fullName || '', required: false, maxlength: 200 });
  const mobile = field({ label: t('field.mobile'), name: 'tel', type: 'tel', autocomplete: 'tel-national', inputmode: 'tel', hint: t('field.mobileHint'), value: profile.phone ? formatSaudiMobile(profile.phone) : '', required: false, maxlength: 20 });
  const langId = nextId('lang');
  const language = h('select', { class: 'p-select', id: langId, name: 'locale', autocomplete: 'language' },
    h('option', { value: 'en', selected: profile.locale === 'en' || undefined }, t('field.language.en')),
    h('option', { value: 'ar', selected: profile.locale === 'ar' || undefined }, t('field.language.ar')));
  const profileSummary = h('div');
  const profileStatus = h('div', { 'aria-live': 'polite' });
  const saveProfile = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('common.save'));
  const profileForm = h('form', { novalidate: true }, profileSummary, profileStatus, fullName.wrap, mobile.wrap,
    h('div', { class: 'p-field' }, h('label', { class: 'p-label', for: langId }, t('field.language')), language),
    h('div', { class: 'p-actions' }, saveProfile));

  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(profileStatus);
    const name = normaliseName(fullName.input.value);
    const phone = mobile.input.value.trim() ? normaliseSaudiMobile(mobile.input.value) : null;
    const ok = validate(profileSummary, [
      [fullName, name && !isValidName(name, 200) ? t('v.name') : null],
      [mobile, mobile.input.value.trim() && !phone ? t('v.mobile') : null],
    ]);
    if (!ok) return;
    setBusy(saveProfile, true, t('common.saving'));
    try {
      await api('PATCH', '/me/profile', { fullName: name || null, phone, locale: language.value });
      if (language.value !== lang) {
        rememberLanguage(language.value);
        go(counterpartPath());
        return;
      }
      mount(profileStatus, alertBox('success', t('settings.profileSaved')));
    } catch (err) {
      mount(profileStatus, alertBox('error', errorMessage(err)));
    } finally {
      setBusy(saveProfile, false);
    }
  });

  // ---- Password ----------------------------------------------------------------------------
  const current = passwordField({ label: t('field.currentPassword'), name: 'current-password', autocomplete: 'current-password' });
  const next = passwordField({ label: t('field.newPassword'), name: 'new-password', autocomplete: 'new-password', hint: t('field.passwordHint') });
  const pwSummary = h('div');
  const pwStatus = h('div', { 'aria-live': 'polite' });
  const savePw = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('settings.updatePassword'));
  const pwForm = h('form', { novalidate: true }, pwSummary, pwStatus, current.wrap, next.wrap, h('div', { class: 'p-actions' }, savePw));

  pwForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(pwStatus);
    const ok = validate(pwSummary, [
      [current, current.input.value ? null : t('v.required', { field: t('field.currentPassword') })],
      [next, newPasswordProblem(next.input.value, session.email)],
    ]);
    if (!ok) return;
    setBusy(savePw, true, t('common.saving'));
    try {
      await api('POST', '/auth/password/change', { currentPassword: current.input.value, newPassword: next.input.value });
      current.input.value = '';
      next.input.value = '';
      mount(pwStatus, alertBox('success', t('settings.passwordChanged')));
    } catch (err) {
      mount(pwStatus, alertBox('error', errorMessage(err)));
    } finally {
      setBusy(savePw, false);
    }
  });

  mount(app, h('div', { class: 'p-medium' },
    pageHeading(t('settings.title')),
    h('div', { class: 'p-stack' },
      h('section', { class: 'p-card', 'aria-labelledby': 's-account' },
        h('h2', { class: 'p-h2', id: 's-account' }, t('settings.account')),
        h('dl', { class: 'p-dl p-mt-m' }, h('dt', {}, t('field.email')),
          h('dd', {}, h('span', { class: 'p-ltr' }, session.email), ' ',
            h('span', { class: `p-badge${session.emailVerified ? '' : ' p-badge--warning'}` }, t(session.emailVerified ? 'common.verified' : 'common.notVerified'))))),
      h('section', { class: 'p-card', 'aria-labelledby': 's-profile' }, h('h2', { class: 'p-h2', id: 's-profile' }, t('settings.profile')), h('div', { class: 'p-mt-m' }, profileForm)),
      h('section', { class: 'p-card', 'aria-labelledby': 's-password' },
        h('h2', { class: 'p-h2', id: 's-password' }, t('settings.changePassword')),
        h('p', { class: 'p-muted p-mt-s' }, t('settings.changePasswordLead')),
        h('div', { class: 'p-mt-m' }, pwForm)),
      h('section', { class: 'p-card', 'aria-labelledby': 's-signout' },
        h('h2', { class: 'p-h2', id: 's-signout' }, t('settings.signOutTitle')),
        h('p', { class: 'p-muted p-mt-s' }, t('settings.signOutBody')),
        h('div', { class: 'p-actions' }, h('button', { type: 'button', class: 'p-btn p-btn--ghost', onclick: signOut }, t('nav.signOut')))))));
}
