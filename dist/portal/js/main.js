import { boot } from './core/app.js';
import { takeHashToken } from './core/paths.js';

const PAGES = {
  'sign-in': () => import('./pages/sign-in.js'),
  'sign-up': () => import('./pages/sign-up.js'),
  'verify-email': () => import('./pages/verify-email.js'),
  'forgot-password': () => import('./pages/forgot-password.js'),
  'reset-password': () => import('./pages/reset-password.js'),
  dashboard: () => import('./pages/dashboard.js'),
  settings: () => import('./pages/settings.js'),
  register: () => import('./pages/register.js'),
  registrations: () => import('./pages/registrations.js'),
  registration: () => import('./pages/registration.js'),
};

const page = document.documentElement.dataset.page;
const TOKEN_PAGES = new Set(['verify-email', 'reset-password']);

if (TOKEN_PAGES.has(page)) {
  takeHashToken(); // capture and hide emailed tokens immediately
  // Opening another emailed link while already on this page only changes the #hash.
  window.addEventListener('hashchange', () => {
    if (/token=/.test(location.hash)) location.reload();
  });
}
if (PAGES[page]) boot(page, PAGES[page]);
