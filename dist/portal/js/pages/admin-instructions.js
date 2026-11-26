import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { lang, t } from '../core/i18n.js';
import { alertBox, errorMessage, loading, setBusy } from '../core/ui.js';
import { actionForm, adminPage, card, control, input, ltr, table, textarea, when } from './admin-common.js';

// Collection-instruction versions. Admins prepare and submit bilingual drafts; only the super
// administrator publishes. Publishing in the application is NOT clinical approval: a version is
// "approved" only when the publisher records the reference of the laboratory/management approval
// obtained outside the system. Published versions can never be edited.
const lines = (text) => text.split('\n').map((x) => x.trim()).filter(Boolean);
function parseChecklist(text) {
  return lines(text).map((line) => {
    const [id, labelEn, labelAr] = line.split('|').map((x) => (x || '').trim());
    return { id, labelEn, labelAr };
  });
}
const checklistText = (items) => items.map((c) => `${c.id} | ${c.labelEn} | ${c.labelAr}`).join('\n');

function draftEditor(d = {}) {
  const f = {
    version: input({ value: d.version || '', maxlength: 32, dir: 'ltr', autocomplete: 'off' }),
    titleEn: input({ value: d.titleEn || '', maxlength: 200 }),
    titleAr: input({ value: d.titleAr || '', maxlength: 200, dir: 'rtl', lang: 'ar' }),
    stepsEn: textarea({ rows: 6 }), stepsAr: textarea({ rows: 6, dir: 'rtl', lang: 'ar' }), checklist: textarea({ rows: 5, dir: 'auto' }),
    notes: textarea({ rows: 2, maxlength: 1000 }),
  };
  f.stepsEn.value = (d.stepsEn || []).join('\n');
  f.stepsAr.value = (d.stepsAr || []).join('\n');
  f.checklist.value = checklistText(d.checklist || []);
  f.notes.value = d.notes || '';
  const el = h('div', { class: 'p-stack' },
    control(t('admin.instr.version'), f.version, t('admin.instr.versionHint')),
    h('div', { class: 'p-filter-grid' }, control(t('admin.instr.titleEn'), f.titleEn), control(t('admin.instr.titleAr'), f.titleAr)),
    h('div', { class: 'p-filter-grid' }, control(t('admin.instr.stepsEn'), f.stepsEn, t('admin.instr.stepsHint')), control(t('admin.instr.stepsAr'), f.stepsAr, t('admin.instr.stepsHint'))),
    control(t('admin.instr.checklist'), f.checklist, t('admin.instr.checklistHint')),
    control(t('admin.instr.notes'), f.notes));
  const value = () => ({
    version: f.version.value.trim(), titleEn: f.titleEn.value.trim(), titleAr: f.titleAr.value.trim(),
    stepsEn: lines(f.stepsEn.value), stepsAr: lines(f.stepsAr.value), checklist: parseChecklist(f.checklist.value), notes: f.notes.value.trim() || null,
  });
  return { el, value };
}

export default async function render({ app }) {
  const host = h('div', { class: 'p-stack' }, loading());
  const load = async (message) => {
    const d = await api('GET', '/admin/instructions');
    const current = d.current.find((x) => x.locale === lang) || d.current[0];
    const versions = [...new Map(d.published.map((p) => [p.version, p])).keys()];
    const draftCards = d.drafts.map((x) => {
      const actions = [];
      if (x.status === 'draft') {
        const ed = draftEditor(x);
        actions.push(actionForm({ summary: t('admin.instr.edit'), submitLabel: t('common.save'), reason: false, fields: [ed.el],
          run: async () => { await api('PUT', `/admin/instructions/drafts/${x.id}`, ed.value()); await load(t('admin.instr.saved')); return false; } }));
        actions.push(actionForm({ summary: t('admin.instr.submit'), intro: t('admin.instr.submitIntro'), submitLabel: t('admin.instr.submit'), reason: false,
          run: async () => { await api('POST', `/admin/instructions/drafts/${x.id}/submit`, {}); await load(t('admin.instr.submitted')); return false; } }));
      }
      if (x.status === 'submitted' && d.canPublish) {
        const effective = input({ type: 'datetime-local' });
        const reference = input({ maxlength: 200, autocomplete: 'off' });
        actions.push(actionForm({
          summary: t('admin.instr.publish'), intro: t('admin.instr.publishIntro'), submitLabel: t('admin.instr.publish'), reason: false, danger: true,
          fields: [control(t('admin.instr.effective'), effective, t('admin.instr.effectiveHint')), control(t('admin.instr.reference'), reference, t('admin.instr.referenceHint'))],
          confirmText: t('admin.instr.publishConfirm'),
          run: async () => {
            const res = await api('POST', `/admin/instructions/drafts/${x.id}/publish`, {
              confirm: true, clinicalApprovalReference: reference.value.trim() || null,
              ...(effective.value ? { effectiveFrom: new Date(effective.value).toISOString() } : {}),
            });
            await load(t(res.status === 'approved' ? 'admin.instr.publishedApproved' : 'admin.instr.publishedProvisional'));
            return false;
          },
        }));
        actions.push(actionForm({ summary: t('admin.instr.return'), intro: t('admin.instr.returnIntro'), submitLabel: t('admin.instr.return'),
          run: async (reason) => { await api('POST', `/admin/instructions/drafts/${x.id}/return`, { reason }); await load(t('admin.instr.returned')); return false; } }));
      }
      if (x.status === 'draft' || x.status === 'submitted') {
        actions.push(actionForm({ summary: t('admin.instr.withdraw'), submitLabel: t('admin.instr.withdraw'), danger: true,
          run: async (reason) => { await api('POST', `/admin/instructions/drafts/${x.id}/withdraw`, { reason }); await load(t('admin.instr.withdrawn')); return false; } }));
      }
      return h('div', { class: 'p-details' },
        h('div', { class: 'p-row p-row--between' }, h('strong', {}, `${x.version} · ${lang === 'ar' ? x.titleAr : x.titleEn}`), h('span', { class: 'p-badge p-badge--muted' }, t(`admin.instr.status.${x.status}`))),
        h('p', { class: 'p-small p-muted p-mt-s' }, t('admin.instr.draftMeta', { by: x.updatedBy, time: when(x.updatedAt) })),
        actions.length ? h('div', { class: 'p-mt-m' }, actions) : null);
    });
    mount(host,
      message ? alertBox('success', message) : null,
      alertBox('warning', t('admin.instr.clinicalTitle'), t('admin.instr.clinicalBody')),
      card(t('admin.instr.current'), current ? [
        h('p', {}, h('strong', {}, `${current.version} · ${current.title}`)),
        h('p', { class: 'p-mt-s' }, h('span', { class: `p-badge${current.provisional ? ' p-badge--warning' : ''}` }, t(current.provisional ? 'admin.instr.provisional' : 'admin.instr.approved'))),
        h('p', { class: 'p-small p-muted p-mt-s' }, t('admin.instr.productionNote')),
      ] : h('p', { class: 'p-muted' }, t('admin.instr.none'))),
      card(t('admin.instr.published'), table(
        [t('admin.instr.version'), t('admin.instr.locale'), t('admin.col.status'), t('admin.instr.effective'), t('admin.instr.reference'), t('admin.instr.publishedBy'), t('admin.instr.samples')],
        d.published.map((p) => [ltr(p.version), t(`field.language.${p.locale}`), t(`admin.instr.status.${p.status}`), when(p.effectiveFrom), p.approvalReference || '–', p.publishedBy || '–', String(p.samplesCollected)])),
        h('p', { class: 'p-small p-muted p-mt-s' }, t('admin.instr.immutable', { n: versions.length }))),
      card(t('admin.instr.drafts'), draftCards.length ? draftCards : h('p', { class: 'p-muted' }, t('admin.empty'))));
    return d;
  };

  const ed = draftEditor();
  const status = h('div', { 'aria-live': 'polite' });
  const submit = h('button', { type: 'submit', class: 'p-btn p-btn--dark' }, t('admin.instr.createDraft'));
  const prefill = h('button', { type: 'button', class: 'p-btn p-btn--ghost' }, t('admin.instr.prefill'));
  const form = h('form', { novalidate: true, class: 'p-stack' }, ed.el, status, h('div', { class: 'p-actions' }, submit, prefill));
  let latest = null;
  prefill.addEventListener('click', () => {
    const en = latest?.published.find((p) => p.locale === 'en');
    const ar = latest?.published.find((p) => p.locale === 'ar' && p.version === en?.version);
    if (!en || !ar) return;
    const copy = draftEditor({
      version: '', titleEn: en.title, titleAr: ar.title, stepsEn: en.steps, stepsAr: ar.steps,
      checklist: en.checklist.map((c, i) => ({ id: c.id, labelEn: c.label, labelAr: ar.checklist[i]?.label || '' })),
    });
    ed.el.replaceWith(copy.el);
    ed.el = copy.el;
    ed.value = copy.value;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    mount(status);
    setBusy(submit, true);
    try {
      await api('POST', '/admin/instructions/drafts', ed.value());
      latest = await load(t('admin.instr.created'));
    } catch (err) {
      mount(status, alertBox('error', errorMessage(err)));
    } finally {
      setBusy(submit, false);
    }
  });
  mount(app, adminPage(t('admin.instr.title'), t('admin.instr.lead'), host,
    h('details', { class: 'p-details' }, h('summary', {}, t('admin.instr.newDraft')), form)));
  latest = await load();
}
