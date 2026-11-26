import { api, loadSession } from './api.js';
import { h, mount } from './dom.js';
import { lang, t } from './i18n.js';
import { counterpartPath, go, pageUrl, safeNext, takeHashToken } from './paths.js';
import { alertBox, errorMessage, loading } from './ui.js';

// Page access rules: guest pages bounce signed-in users to their account; protected pages send
// signed-out users to sign-in (returning afterwards); "verified" pages also need a confirmed email.
const ACCESS = {
  'sign-in': 'guest',
  'sign-up': 'guest',
  'forgot-password': 'guest',
  'reset-password': 'any',
  'verify-email': 'any',
  settings: 'auth',
  dashboard: 'verified',
  register: 'verified',
  registrations: 'verified',
  registration: 'verified',
  'qr-info': 'any',
};

const LANG_KEY = 'linusbiomena-language'; // shared with the public site's language switch

function preferredLanguage() {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;
  }
}

export function rememberLanguage(value) {
  try {
    localStorage.setItem(LANG_KEY, value);
  } catch {
    /* storage unavailable: preference simply isn't remembered */
  }
}

export async function signOut() {
  try {
    await api('POST', '/auth/sign-out', {});
  } catch {
    /* already signed out */
  }
  go(pageUrl('sign-in', { signedOut: '1' }));
}

function renderHeader(page, session) {
  const nav = document.getElementById('account-nav');
  if (!nav) return;
  const items = [h('a', { class: 'p-nav__home', href: lang === 'ar' ? '/ar/traced/' : '/traced/' }, t('nav.home'))];
  if (session) {
    items.push(h('a', { href: pageUrl('dashboard'), 'aria-current': page === 'dashboard' ? 'page' : undefined }, t('nav.dashboard')));
    items.push(h('button', { type: 'button', class: 'p-link', onclick: signOut }, t('nav.signOut')));
  } else if (page !== 'sign-in') {
    items.push(h('a', { href: pageUrl('sign-in') }, t('nav.signIn')));
  }
  const switcher = h('a', { href: counterpartPath(), lang: lang === 'ar' ? 'en' : 'ar-SA', hreflang: lang === 'ar' ? 'en' : 'ar-SA', 'aria-label': t('nav.languageLabel') }, t('nav.language'));
  switcher.addEventListener('click', (e) => {
    e.preventDefault();
    rememberLanguage(lang === 'ar' ? 'en' : 'ar');
    go(counterpartPath() + location.search);
  });
  items.push(switcher);
  mount(nav, items);
}

export async function boot(page, loadPage) {
  // Follow the language the visitor chose on the public site.
  const pref = preferredLanguage();
  if ((pref === 'ar' && lang === 'en') || (pref === 'en' && lang === 'ar')) {
    const token = page === 'verify-email' || page === 'reset-password' ? takeHashToken() : null;
    location.replace(counterpartPath() + location.search + (token ? `#token=${token}` : location.hash));
    return;
  }

  const app = document.getElementById('app');
  mount(app, loading());

  let session;
  try {
    session = await loadSession();
  } catch (err) {
    mount(app, alertBox('error', errorMessage(err)));
    return;
  }

  const rule = ACCESS[page] || 'auth';
  const here = location.pathname + location.search;
  if (rule === 'guest' && session) {
    const next = safeNext(new URLSearchParams(location.search).get('next'));
    return go(session.emailVerified ? next || pageUrl('dashboard') : pageUrl('verify-email'));
  }
  if ((rule === 'auth' || rule === 'verified') && !session) return go(pageUrl('sign-in', { next: here }));
  if (rule === 'verified' && !session.emailVerified) return go(pageUrl('verify-email'));

  renderHeader(page, session);
  try {
    const mod = await loadPage();
    await mod.default({ app, session, page });
  } catch (err) {
    mount(app, alertBox('error', errorMessage(err)));
  }
}
