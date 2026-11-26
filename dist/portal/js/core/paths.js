// Portal URLs for both languages. Arabic pages live under /ar, as on the rest of the site.

export const PAGES = {
  dashboard: 'account/',
  'sign-in': 'account/sign-in/',
  'sign-up': 'account/sign-up/',
  'verify-email': 'account/verify-email/',
  'forgot-password': 'account/forgot-password/',
  'reset-password': 'account/reset-password/',
  settings: 'account/settings/',
  register: 'account/register/',
  registrations: 'account/registrations/',
  registration: 'account/registration/',
  'qr-info': 'c/',
  'staff-dashboard': 'staff/',
  'staff-sign-in': 'staff/sign-in/',
  'staff-scan': 'staff/scan/',
  'staff-history': 'staff/history/',
  'staff-settings': 'staff/settings/',
  'staff-accept-invite': 'staff/accept-invite/',
  'admin-accept-invite': 'admin/accept-invite/',
};

export const isArabicPath = (path = location.pathname) => /^\/ar(?:\/|$)/.test(path);

export function pageUrl(page, params, lang) {
  const ar = lang ? lang === 'ar' : isArabicPath();
  const query = params ? `?${new URLSearchParams(params).toString()}` : '';
  return `${ar ? '/ar' : ''}/traced/${PAGES[page]}${query}`;
}

export function siteUrl(path, lang) {
  const ar = lang ? lang === 'ar' : isArabicPath();
  return `${ar ? '/ar' : ''}${path}`;
}

/** The same page in the other language. */
export function counterpartPath(path = location.pathname) {
  return isArabicPath(path) ? path.replace(/^\/ar(?=\/|$)/, '') || '/' : `/ar${path}`;
}

const NEXT_RE = /^\/(?:ar\/)?traced\/(?:account|staff)\/(?:[a-z-]+\/)?(?:\?id=[0-9a-f-]{36})?$/;

/** Only same-site portal paths are accepted as a post-sign-in destination (no open redirects). */
export function safeNext(value) {
  return typeof value === 'string' && NEXT_RE.test(value) ? value : null;
}

export function go(url) {
  location.assign(url);
}

let capturedToken;

/**
 * Reads #token=... once and removes it from the address bar (and history). main.js calls this
 * before anything else runs, so the token never lingers in the URL while the page loads.
 */
export function takeHashToken() {
  if (capturedToken !== undefined) return capturedToken;
  const match = /(?:^#|&)token=([A-Za-z0-9_-]{20,128})/.exec(location.hash);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  capturedToken = match ? match[1] : null;
  return capturedToken;
}
