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
  // Staff portal (Phase 4): staff pages need an account with collection permissions.
  'staff-sign-in': 'staff-guest',
  'staff-dashboard': 'staff',
  'staff-scan': 'staff',
  'staff-history': 'staff',
  'staff-settings': 'staff',
  'staff-accept-invite': 'any',
  'admin-accept-invite': 'any',
};

const STAFF_PAGES = new Set(['staff-sign-in', 'staff-dashboard', 'staff-scan', 'staff-history', 'staff-settings', 'staff-accept-invite']);

/** UI routing only; every staff API call is authorised again on the server. */
export const isStaff = (session) => Boolean(session?.permissions?.includes('collection.scan'));

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
  const staffPage = STAFF_PAGES.has(document.documentElement.dataset.page);
  try {
    await api('POST', '/auth/sign-out', {});
  } catch {
    /* already signed out */
  }
  go(pageUrl(staffPage ? 'staff-sign-in' : 'sign-in', { signedOut: '1' }));
}

function renderHeader(page, session) {
  const nav = document.getElementById('account-nav');
  if (!nav) return;
  const items = [h('a', { class: 'p-nav__home', href: lang === 'ar' ? '/ar/traced/' : '/traced/' }, t('nav.home'))];
  if (STAFF_PAGES.has(page) && isStaff(session)) {
    nav.setAttribute('aria-label', t('staff.nav.main'));
    items.length = 0;
    for (const [id, key] of [['staff-dashboard', 'staff.nav.dashboard'], ['staff-scan', 'staff.nav.scan'], ['staff-history', 'staff.nav.history'], ['staff-settings', 'staff.nav.settings']]) {
      items.push(h('a', { href: pageUrl(id), 'aria-current': page === id ? 'page' : undefined }, t(key)));
    }
    items.push(h('button', { type: 'button', class: 'p-link', onclick: signOut }, t('nav.signOut')));
  } else if (session) {
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
    const token = ['verify-email', 'reset-password', 'staff-accept-invite', 'admin-accept-invite'].includes(page) ? takeHashToken() : null;
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
  if ((rule === 'guest' || rule === 'staff-guest') && session && isStaff(session)) {
    return go(safeNext(new URLSearchParams(location.search).get('next')) || pageUrl('staff-dashboard'));
  }
  if (rule === 'staff' && !session) return go(pageUrl('staff-sign-in', { next: here }));
  if (rule === 'staff' && !isStaff(session)) {
    renderHeader(page, session);
    mount(app, h('div', { class: 'p-narrow' }, h('h1', { class: 'p-h1' }, t('staff.forbidden.title')),
      h('div', { class: 'p-card' }, alertBox('info', null, t('staff.forbidden.body')))));
    return;
  }
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
