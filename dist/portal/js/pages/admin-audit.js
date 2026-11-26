import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { can } from '../core/app.js';
import { alertBox, errorMessage, loading } from '../core/ui.js';
import { adminPage, auditActionLabel, control, input, ltr, qs, roleLabel, select, table, when } from './admin-common.js';

// Audit log viewer (audit.read). Read-only. Viewers without personal-data permission (auditors)
// receive entries with IP addresses, emails and free-text reasons already removed by the server.
const PREFIXES = ['auth', 'registration', 'customer', 'patient', 'qr', 'sample', 'staff', 'branch', 'instructions', 'email', 'report', 'audit', 'authz'];

export default async function render({ app, session }) {
  const full = can(session, 'registration.read_full');
  const from = input({ type: 'date' });
  const to = input({ type: 'date' });
  const area = select([['', t('admin.filter.any')], ...PREFIXES.map((p) => [p, t(`admin.audit.area.${p}`)])], '');
  const action = input({ maxlength: 100, dir: 'ltr', autocomplete: 'off', placeholder: 'registration.viewed_full' });
  const outcome = select([['', t('admin.filter.any')], ...['success', 'failure', 'denied'].map((o) => [o, t(`admin.outcome.${o}`)])], '');
  const actor = input({ type: full ? 'email' : 'text', maxlength: full ? 254 : 36, dir: 'ltr', autocomplete: 'off' });
  const targetType = input({ maxlength: 50, dir: 'ltr', autocomplete: 'off' });
  const targetId = input({ maxlength: 200, dir: 'ltr', autocomplete: 'off' });
  const list = h('div', {}, loading());
  const more = h('button', { type: 'button', class: 'p-btn p-btn--ghost', hidden: true }, t('admin.loadMore'));
  let beforeSeq = null;
  let items = [];

  const meta = (m) => {
    const entries = Object.entries(m || {}).filter(([, v]) => v !== null && v !== undefined);
    return entries.length ? h('pre', { class: 'p-code', dir: 'ltr' }, entries.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n')) : '–';
  };
  const run = async (append) => {
    if (!append) {
      beforeSeq = null;
      items = [];
      mount(list, loading());
    }
    try {
      const actorValue = actor.value.trim();
      const res = await api('GET', `/admin/audit-logs${qs({
        from: from.value, to: to.value, actionPrefix: area.value, action: action.value.trim(), outcome: outcome.value,
        ...(full && actorValue.includes('@') ? { actorEmail: actorValue } : /^[0-9a-f-]{36}$/i.test(actorValue) ? { actorUserId: actorValue } : {}),
        targetType: targetType.value.trim(), targetId: targetId.value.trim(), beforeSeq, limit: 50,
      })}`);
      items = items.concat(res.items);
      beforeSeq = res.nextBeforeSeq;
      more.hidden = !beforeSeq;
      mount(list, table(
        [t('admin.col.time'), t('admin.col.event'), t('admin.col.outcome'), t('admin.audit.actor'), t('admin.audit.target'), t('admin.audit.details'), full ? t('admin.audit.ip') : null].filter(Boolean),
        items.map((e) => [
          when(e.occurredAt), h('span', {}, auditActionLabel(e.action), h('br'), h('span', { class: 'p-small p-muted p-ltr', dir: 'ltr' }, e.action)), t(`admin.outcome.${e.outcome}`),
          h('span', {}, e.actorRole ? roleLabel(e.actorRole) : t('admin.audit.system'), e.actorEmail ? [h('br'), ltr(e.actorEmail)] : null),
          e.targetType ? h('span', { class: 'p-small', dir: 'ltr' }, `${e.targetType}${e.targetId ? ` ${e.targetId}` : ''}`) : '–',
          meta(e.metadata), full ? ltr(e.ip) : null,
        ].filter((x) => x !== null)), { caption: t('admin.audit.title') }));
    } catch (err) {
      mount(list, alertBox('error', errorMessage(err)));
    }
  };
  more.addEventListener('click', () => run(true));
  const filters = h('form', { class: 'p-filter-grid', novalidate: true },
    control(t('admin.filter.from'), from), control(t('admin.filter.to'), to), control(t('admin.audit.area'), area), control(t('admin.audit.exactAction'), action),
    control(t('admin.col.outcome'), outcome), control(t(full ? 'admin.audit.actorEmail' : 'admin.audit.actorId'), actor),
    control(t('admin.audit.targetType'), targetType), control(t('admin.audit.targetId'), targetId),
    h('div', { class: 'p-actions' }, h('button', { type: 'submit', class: 'p-btn p-btn--ghost' }, t('admin.filter.apply'))));
  filters.addEventListener('submit', (e) => {
    e.preventDefault();
    run(false);
  });
  mount(app, adminPage(t('admin.audit.title'), t(full ? 'admin.audit.lead' : 'admin.audit.leadRedacted'), h('div', { class: 'p-card' }, filters), list, h('div', { class: 'p-actions' }, more)));
  await run(false);
}
