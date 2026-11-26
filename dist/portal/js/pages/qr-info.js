import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { pageHeading } from '../core/ui.js';

// Opened when someone scans a customer QR with an ordinary phone camera. Deliberately static:
// it never sends the token anywhere and shows no registration data (main.js has already
// removed the token from the address bar). Only authorised staff tools validate QR codes.
export default function render({ app }) {
  mount(app, h('div', { class: 'p-narrow' },
    pageHeading(t('qrInfo.title')),
    h('div', { class: 'p-card p-stack' },
      h('p', {}, t('qrInfo.body')),
      h('a', { class: 'p-btn p-btn--ghost p-btn--block', href: pageUrl('dashboard') }, t('common.goToDashboard')))));
}
