import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { pageUrl } from '../core/paths.js';
import { alertBox, errorMessage, loading, setBusy } from '../core/ui.js';
import { actionForm, adminPage, card, checkbox, control, dl, input, ltr, table } from './admin-common.js';

// Collection branches (branch.manage). Branches are never deleted; deactivating one that still
// has registrations awaiting collection needs an explicit acknowledgement, and those
// registrations should then be transferred.
export default async function render({ app }) {
  const host = h('div', { class: 'p-stack' }, loading());
  const fields = (b = {}) => ({
    nameEn: input({ value: b.nameEn || '', maxlength: 200 }), nameAr: input({ value: b.nameAr || '', maxlength: 200, dir: 'rtl', lang: 'ar' }),
    cityEn: input({ value: b.cityEn || '', maxlength: 100 }), cityAr: input({ value: b.cityAr || '', maxlength: 100, dir: 'rtl', lang: 'ar' }),
    addressEn: input({ value: b.addressEn || '', maxlength: 500 }), addressAr: input({ value: b.addressAr || '', maxlength: 500, dir: 'rtl', lang: 'ar' }),
    sortOrder: input({ type: 'number', value: String(b.sortOrder ?? 0), min: 0, max: 10000 }),
  });
  const grid = (f) => h('div', { class: 'p-filter-grid' },
    control(t('admin.branch.nameEn'), f.nameEn), control(t('admin.branch.nameAr'), f.nameAr), control(t('admin.branch.cityEn'), f.cityEn), control(t('admin.branch.cityAr'), f.cityAr),
    control(t('admin.branch.addressEn'), f.addressEn), control(t('admin.branch.addressAr'), f.addressAr), control(t('admin.branch.sortOrder'), f.sortOrder));
  const values = (f) => ({
    nameEn: f.nameEn.value.trim(), nameAr: f.nameAr.value.trim(), cityEn: f.cityEn.value.trim(), cityAr: f.cityAr.value.trim(),
    addressEn: f.addressEn.value.trim(), addressAr: f.addressAr.value.trim(), sortOrder: Number(f.sortOrder.value || 0),
  });

  const load = async (message) => {
    const { items } = await api('GET', '/admin/branches');
    mount(host,
      message ? alertBox('success', message) : null,
      items.map((b) => {
        const f = fields(b);
        const ack = checkbox(t('admin.branch.ack', { n: b.stats.pending }));
        return card(null,
          h('div', { class: 'p-row p-row--between' }, h('h2', { class: 'p-h2' }, `${b.nameEn} · ${b.nameAr}`),
            h('span', { class: `p-badge${b.active ? '' : ' p-badge--muted'}` }, t(b.active ? 'admin.branch.active' : 'admin.branch.inactive'))),
          h('div', { class: 'p-mt-m' }, dl([
            [t('admin.branch.code'), ltr(b.code)],
            [t('admin.branch.city'), `${b.cityEn} · ${b.cityAr}`],
            [t('admin.branch.address'), [b.addressEn, b.addressAr].filter(Boolean).join(' · ') || '–'],
            [t('admin.branch.stats'), t('admin.branch.statsText', { regs: b.stats.registrations, pending: b.stats.pending, collected: b.stats.collected, month: b.stats.collectedThisMonth })],
          ])),
          b.stats.pending ? h('p', { class: 'p-small p-mt-s' }, h('a', { href: `${pageUrl('admin-registrations')}?branchId=${b.id}&status=awaiting_sample_collection` }, t('admin.branch.viewPending'))) : null,
          h('div', { class: 'p-mt-m' },
            h('h3', { class: 'p-h3' }, t('admin.branch.staff')),
            table([t('admin.col.name'), t('field.email'), t('admin.col.status')], b.staff.map((u) => [h('a', { href: pageUrl('admin-staff-member', { id: u.id }) }, u.fullName || u.email), ltr(u.email), t(`admin.status.${u.status}`)]))),
          h('div', { class: 'p-mt-m' },
            actionForm({
              summary: t('admin.branch.edit'), submitLabel: t('common.save'), reason: false, fields: [grid(f)],
              run: async () => { await api('PATCH', `/admin/branches/${b.id}`, values(f)); await load(t('admin.branch.saved')); return false; },
            }),
            actionForm({
              summary: t(b.active ? 'admin.branch.deactivate' : 'admin.branch.activate'), intro: t(b.active ? 'admin.branch.deactivateIntro' : 'admin.branch.activateIntro'),
              submitLabel: t(b.active ? 'admin.branch.deactivate' : 'admin.branch.activate'), danger: b.active,
              fields: b.active && b.stats.pending ? [ack.wrap] : [],
              run: async (reason) => {
                await api('POST', `/admin/branches/${b.id}/status`, { active: !b.active, reason, acknowledgePending: ack.box.checked });
                await load(t(b.active ? 'admin.branch.deactivated' : 'admin.branch.activated'));
                return false;
              },
            })));
      }));
  };

  const code = input({ maxlength: 32, autocomplete: 'off', dir: 'ltr' });
  const nf = fields();
  const status = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('admin.branch.create'));
  const form = h('form', { novalidate: true, class: 'p-stack' }, control(t('admin.branch.code'), code, t('admin.branch.codeHint')), grid(nf), status, h('div', { class: 'p-actions' }, submit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(status);
    setBusy(submit, true);
    try {
      await api('POST', '/admin/branches', { code: code.value.trim(), ...values(nf) });
      code.value = '';
      for (const el of Object.values(nf)) el.value = el.type === 'number' ? '0' : '';
      await load(t('admin.branch.created'));
    } catch (err) {
      mount(status, alertBox('error', errorMessage(err)));
    } finally {
      setBusy(submit, false);
    }
  });

  mount(app, adminPage(t('admin.branch.title'), t('admin.branch.lead'), host,
    h('details', { class: 'p-details' }, h('summary', {}, t('admin.branch.new')), form)));
  await load();
}
