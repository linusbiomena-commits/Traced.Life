import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageHeading } from '../core/ui.js';

// Opened when a physical sample label is scanned with an ordinary phone camera. Static: the token
// was already removed from the address bar by main.js and is never sent anywhere. Only
// authorised staff and laboratory tools identify samples.
export default function render({ app }) {
  mount(app, h('div', { class: 'p-narrow' }, pageHeading(t('sampleInfo.title')), h('div', { class: 'p-card' }, h('p', {}, t('sampleInfo.body')))));
}
