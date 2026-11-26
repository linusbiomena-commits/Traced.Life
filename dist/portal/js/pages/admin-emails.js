import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, errorMessage, loading, setBusy } from '../core/ui.js';
import { adminPage, control, input, ltr, qs, select, table, when } from './admin-common.js';

const KINDS = ['verify_email', 'account_exists', 'reset_password', 'password_changed', 'account_setup', 'registration_confirmation', 'registration_qr_resend', 'registration_branch_changed'];

// Email delivery monitor (email.manage). Recipients arrive masked from the server; message bodies,
// one-time links and tokens are never sent to this page.
export default async function render({ app }) {
  const params = new URLSearchParams(location.search);
  const status = select([['', t('admin.filter.any')], ...['queued', 'sending', 'sent', 'failed'].map((s) => [s, t(`admin.emailStatus.${s}`)])], params.get('status') || '');
  const kind = select([['', t('admin.filter.any')], ...KINDS.map((k) => [k, t(`admin.emailKind.${k}`)])], '');
  const from = input({ type: 'date' });
  const to = input({ type: 'date' });
  const summary = h('div', { class: 'p-grid p-grid--stats' });
  const list = h('div', {}, loading());
  const more = h('button', { type: 'button', class: 'p-btn p-btn--ghost', hidden: true }, t('admin.loadMore'));
  const note = h('div', { 'aria-live': 'polite' });
  let before = null;
  let items = [];

  const retryButton = (e) => {
    if (!e.retryable) return e.status === 'failed' ? h('span', { class: 'p-small p-muted' }, t('admin.email.notRetryable')) : '–';
    const b = h('button', { type: 'button', class: 'p-btn p-btn--ghost' }, t('admin.email.retry'));
    b.addEventListener('click', async () => {
      setBusy(b, true);
      try {
        await api('POST', `/admin/emails/${e.id}/retry`, {});
        mount(note, alertBox('success', t('admin.email.retried')));
        await run(false);
      } catch (err) {
        setBusy(b, false);
        mount(note, alertBox('error', errorMessage(err)));
      }
    });
    return b;
  };

  const run = async (append) => {
    if (!append) {
      before = null;
      items = [];
      mount(list, loading());
    }
    try {
      const res = await api('GET', `/admin/emails${qs({ status: status.value, kind: kind.value, from: from.value, to: to.value, before, limit: 50 })}`);
      items = items.concat(res.items);
      before = res.nextBefore;
      more.hidden = !before;
      mount(summary, ['queued', 'sending', 'sent', 'failed'].map((s) => h('div', { class: 'p-card p-stat' }, h('p', { class: 'p-stat__value' }, String(res.summary[s])), h('p', { class: 'p-muted p-small' }, t(`admin.emailStatus.${s}`)))));
      mount(list, table(
        [t('admin.col.time'), t('admin.email.kind'), t('admin.email.recipient'), t('admin.col.status'), t('admin.email.attempts'), t('admin.email.lastAttempt'), t('admin.email.provider'), t('admin.email.error'), t('admin.col.trackingId'), ''],
        items.map((e) => [
          when(e.createdAt), t(`admin.emailKind.${e.kind}`), ltr(e.recipient), t(`admin.emailStatus.${e.status}`), `${e.attempts}/${e.maxAttempts}`,
          e.status === 'queued' && e.nextAttemptAt ? t('admin.email.nextAt', { time: when(e.nextAttemptAt) }) : when(e.lastAttemptAt),
          e.providerMessageId ? ltr(e.providerMessageId) : '–', e.lastError || '–',
          e.registration ? h('a', { href: pageUrl('admin-registration', { id: e.registration.id }) }, ltr(e.registration.trackingId)) : '–',
          retryButton(e),
        ]), { caption: t('admin.email.title') }));
    } catch (err) {
      mount(list, alertBox('error', errorMessage(err)));
    }
  };
  more.addEventListener('click', () => run(true));
  const filters = h('form', { class: 'p-filter-grid', novalidate: true }, control(t('admin.col.status'), status), control(t('admin.email.kind'), kind),
    control(t('admin.filter.from'), from), control(t('admin.filter.to'), to), h('div', { class: 'p-actions' }, h('button', { type: 'submit', class: 'p-btn p-btn--ghost' }, t('admin.filter.apply'))));
  filters.addEventListener('submit', (e) => {
    e.preventDefault();
    run(false);
  });
  mount(app, adminPage(t('admin.email.title'), t('admin.email.lead'), summary, h('div', { class: 'p-card' }, filters), note, list, h('div', { class: 'p-actions' }, more)));
  await run(false);
}
