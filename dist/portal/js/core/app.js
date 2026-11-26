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
  // Admin portal (Phase 5): privileged accounts that have passed MFA; navigation by permission.
  'admin-sign-in': 'admin-guest',
  'admin-mfa': 'admin-mfa',
  'admin-dashboard': 'admin',
  'admin-registrations': 'admin',
  'admin-registration': 'admin',
  'admin-customer': 'admin',
  'admin-staff': 'admin',
  'admin-staff-member': 'admin',
  'admin-branches': 'admin',
  'admin-instructions': 'admin',
  'admin-emails': 'admin',
  'admin-audit': 'admin',
  'admin-settings': 'admin',
  // Phase 6: physical samples (staff), laboratory portal, admin custody pages.
  'sample-info': 'any',
  'staff-samples': 'staff',
  'staff-label': 'staff',
  'lab-sign-in': 'lab-guest',
  'lab-dashboard': 'lab',
  'lab-scan': 'lab',
  'lab-history': 'lab',
  'admin-samples': 'admin',
  'admin-sample': 'admin',
  'admin-sample-label': 'admin',
  // Phase 7: audit integrity and personal-data export.
  'admin-integrity': 'admin',
  'admin-exports': 'admin',
};

// Admin navigation: each item appears only for a permission the account holds. The server checks
// every request again; hiding a link is never the control.
export const ADMIN_NAV = [
  ['admin-dashboard', 'admin.nav.dashboard', ['stats.read']],
  ['admin-registrations', 'admin.nav.registrations', ['registration.read_full']],
  ['admin-samples', 'admin.nav.samples', ['registration.read_full']],
  ['admin-staff', 'admin.nav.staff', ['staff.manage', 'admin.manage']],
  ['admin-branches', 'admin.nav.branches', ['branch.manage']],
  ['admin-instructions', 'admin.nav.instructions', ['instructions.draft']],
  ['admin-emails', 'admin.nav.emails', ['email.manage']],
  ['admin-audit', 'admin.nav.audit', ['audit.read']],
  ['admin-integrity', 'admin.nav.integrity', ['audit.read']],
  ['admin-exports', 'admin.nav.exports', ['report.export_pii']],
  ['admin-settings', 'admin.nav.settings', []],
];
// Pages beyond the menu items need the permission of the area they belong to.
const ADMIN_PAGE_PERMS = {
  ...Object.fromEntries(ADMIN_NAV.map(([id, , perms]) => [id, perms])),
  'admin-registration': ['registration.read_full'],
  'admin-customer': ['registration.read_full'],
  'admin-staff-member': ['staff.manage', 'admin.manage'],
  'admin-sample': ['registration.read_full'],
  'admin-sample-label': ['registration.read_full'],
};
const ADMIN_PERMS = ['stats.read', 'registration.read_full', 'staff.manage', 'admin.manage', 'branch.manage', 'instructions.draft', 'email.manage', 'audit.read'];
const ADMIN_PAGES = new Set(Object.keys(ACCESS).filter((p) => p.startsWith('admin-') && p !== 'admin-accept-invite'));

/** UI routing only: an account with any administrative permission. */
export const isAdmin = (session) => Boolean(session?.permissions?.some((p) => ADMIN_PERMS.includes(p)));
export const can = (session, ...perms) => perms.length === 0 || perms.some((p) => session?.permissions?.includes(p));
const needsMfa = (session) => Boolean(session?.mfa?.required && !session.mfa.verified);

/** First admin page this account may open. */
export function adminHome(session) {
  const first = ADMIN_NAV.find(([, , perms]) => can(session, ...perms));
  return pageUrl(first ? first[0] : 'admin-settings');
}

const STAFF_PAGES = new Set(['staff-sign-in', 'staff-dashboard', 'staff-scan', 'staff-samples', 'staff-label', 'staff-history', 'staff-settings', 'staff-accept-invite']);
const LAB_PAGES = new Set(['lab-sign-in', 'lab-dashboard', 'lab-scan', 'lab-history']);

/** UI routing only; every staff API call is authorised again on the server. */
export const isStaff = (session) => Boolean(session?.permissions?.includes('collection.scan'));
const isCustomer = (session) => Boolean(session?.roles?.includes('customer'));
/** Laboratory operators (admins also hold the lab permission but use the admin portal). */
export const isLab = (session) => Boolean(session?.permissions?.includes('custody.record_lab'));

/**
 * The one place that decides where a signed-in account belongs (UI routing only; the server
 * authorises every request). `next` is honoured only when it is a safe portal path inside that
 * account's own area, so a crafted link can't send anyone elsewhere. Returns null when the role
 * has no portal yet.
 */
export function homeFor(session, next) {
  const safe = safeNext(next);
  const area = safe ? /^\/(?:ar\/)?traced\/(account|staff|admin|lab)\//.exec(safe)?.[1] : null;
  const keep = (a) => (area === a ? safe : null);
  if (isAdmin(session)) return needsMfa(session) ? pageUrl('admin-mfa', keep('admin') ? { next: safe } : undefined) : keep('admin') || adminHome(session);
  if (isStaff(session)) return keep('staff') || pageUrl('staff-dashboard');
  if (isLab(session)) return needsMfa(session) ? pageUrl('admin-mfa', keep('lab') ? { next: safe } : undefined) : keep('lab') || pageUrl('lab-dashboard');
  if (isCustomer(session)) return session.emailVerified ? keep('account') || pageUrl('dashboard') : pageUrl('verify-email');
  return null;
}

function noPortal(page, session) {
  renderHeader(page, session);
  mount(document.getElementById('app'), h('div', { class: 'p-narrow' }, h('h1', { class: 'p-h1' }, t('role.noPortal.title')),
    h('div', { class: 'p-card' }, alertBox('info', null, t('role.noPortal.body')))));
}

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
  const current = document.documentElement.dataset.page;
  const staffPage = STAFF_PAGES.has(current);
  const adminPage = ADMIN_PAGES.has(current);
  const labPage = LAB_PAGES.has(current);
  try {
    await api('POST', '/auth/sign-out', {});
  } catch {
    /* already signed out */
  }
  go(pageUrl(adminPage ? 'admin-sign-in' : labPage ? 'lab-sign-in' : staffPage ? 'staff-sign-in' : 'sign-in', { signedOut: '1' }));
}

function renderHeader(page, session) {
  const nav = document.getElementById('account-nav');
  if (!nav) return;
  const items = [h('a', { class: 'p-nav__home', href: lang === 'ar' ? '/ar/traced/' : '/traced/' }, t('nav.home'))];
  if (ADMIN_PAGES.has(page) && isAdmin(session) && !needsMfa(session)) {
    nav.setAttribute('aria-label', t('admin.nav.main'));
    items.length = 0;
    for (const [id, key, perms] of ADMIN_NAV) {
      if (can(session, ...perms)) items.push(h('a', { href: pageUrl(id), 'aria-current': page === id || page.startsWith(`${id}-`) || (id === 'admin-registrations' && ['admin-registration', 'admin-customer'].includes(page)) ? 'page' : undefined }, t(key)));
    }
    items.push(h('button', { type: 'button', class: 'p-link', onclick: signOut }, t('nav.signOut')));
  } else if (LAB_PAGES.has(page) && isLab(session) && !needsMfa(session)) {
    nav.setAttribute('aria-label', t('lab.nav.main'));
    items.length = 0;
    for (const [id, key] of [['lab-dashboard', 'lab.nav.dashboard'], ['lab-scan', 'lab.nav.scan'], ['lab-history', 'lab.nav.history']]) {
      items.push(h('a', { href: pageUrl(id), 'aria-current': page === id ? 'page' : undefined }, t(key)));
    }
    items.push(h('button', { type: 'button', class: 'p-link', onclick: signOut }, t('nav.signOut')));
  } else if (STAFF_PAGES.has(page) && isStaff(session)) {
    nav.setAttribute('aria-label', t('staff.nav.main'));
    items.length = 0;
    for (const [id, key] of [['staff-dashboard', 'staff.nav.dashboard'], ['staff-scan', 'staff.nav.scan'], ['staff-samples', 'staff.nav.samples'], ['staff-history', 'staff.nav.history'], ['staff-settings', 'staff.nav.settings']]) {
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
  const nextParam = safeNext(new URLSearchParams(location.search).get('next'));
  // Sign-in pages: a signed-in account goes to its own portal.
  if ((rule === 'guest' || rule === 'staff-guest' || rule === 'admin-guest' || rule === 'lab-guest') && session) {
    const home = homeFor(session, nextParam);
    if (home) return go(home);
  }
  if (rule === 'admin-mfa' && session && !isAdmin(session) && isLab(session)) {
    // Laboratory operators share the two-step verification page.
    if (!needsMfa(session)) return go(homeFor(session, nextParam));
    renderHeader(page, session);
    const mod = await loadPage();
    return mod.default({ app, session, page });
  }
  if (rule === 'lab') {
    if (!session) return go(pageUrl('lab-sign-in', { next: here }));
    if (!isLab(session)) {
      renderHeader(page, session);
      mount(app, h('div', { class: 'p-narrow' }, h('h1', { class: 'p-h1' }, t('lab.forbidden.title')),
        h('div', { class: 'p-card' }, alertBox('info', null, t('lab.forbidden.body')))));
      return;
    }
    if (needsMfa(session)) return go(pageUrl('admin-mfa', { next: here }));
  }
  if (rule === 'admin' || rule === 'admin-mfa') {
    if (!session) return go(pageUrl('admin-sign-in', rule === 'admin' ? { next: here } : undefined));
    if (!isAdmin(session)) {
      renderHeader(page, session);
      mount(app, h('div', { class: 'p-narrow' }, h('h1', { class: 'p-h1' }, t('admin.forbidden.title')),
        h('div', { class: 'p-card' }, alertBox('info', null, t('admin.forbidden.body')))));
      return;
    }
    if (rule === 'admin' && needsMfa(session)) return go(pageUrl('admin-mfa', { next: here }));
    if (rule === 'admin' && !can(session, ...(ADMIN_PAGE_PERMS[page] || []))) {
      renderHeader(page, session);
      mount(app, h('div', { class: 'p-narrow' }, h('h1', { class: 'p-h1' }, t('admin.forbidden.title')),
        h('div', { class: 'p-card' }, alertBox('info', null, t('admin.forbidden.page')))));
      return;
    }
    if (rule === 'admin-mfa' && !needsMfa(session)) return go(nextParam || adminHome(session));
  }
  // Customer-only pages: staff and admin accounts go to their own portal; other roles get a notice.
  if ((rule === 'auth' || rule === 'verified') && session && !isCustomer(session)) {
    const home = homeFor(session);
    return home ? go(home) : noPortal(page, session);
  }
  if (rule === 'staff' && !session) return go(pageUrl('staff-sign-in', { next: here }));
  if (rule === 'staff' && !isStaff(session)) {
    renderHeader(page, session);
    mount(app, h('div', { class: 'p-narrow' }, h('h1', { class: 'p-h1' }, t('staff.forbidden.title')),
      h('div', { class: 'p-card' }, alertBox('info', null, t('staff.forbidden.body')))));
    return;
  }
  if ((rule === 'guest' || rule === 'staff-guest' || rule === 'admin-guest' || rule === 'lab-guest') && session) {
    // Signed in, but the role has no portal (homeFor returned null): sign-in page with a notice.
    session.noPortal = true;
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
