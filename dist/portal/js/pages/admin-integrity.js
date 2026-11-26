import { api } from '../core/api.js';
import { h, mount } from '../core/dom.js';
import { t } from '../core/i18n.js';
import { can } from '../core/app.js';
import { alertBox, errorMessage, loading, setBusy } from '../core/ui.js';
import { adminPage, card, dl, ltr, table, when, yesNo } from './admin-common.js';

// Audit integrity (Phase 7, audit.read): hash-chain status, signed checkpoints and verification
// history. Anyone with audit.read may run a verification; only super administrators may sign a
// checkpoint by hand (the scheduler signs one daily). Hashes, counts and codes only, no personal data.
export default async function render({ app, session }) {
  const body = h('div', {}, loading());
  const status = h('div', { 'aria-live': 'polite' });
  mount(app, adminPage(t('admin.integrity.title'), t('admin.integrity.lead'), status, body));

  const findingText = (f) => {
    const label = t(`admin.integrity.finding.${f.code}`);
    const where = [f.checkpointId ? `#${f.checkpointId}` : null, f.seq ? `seq ${f.seq}` : null].filter(Boolean).join(' · ');
    return h('li', {}, label, where ? h('span', { class: 'p-small p-muted p-ltr', dir: 'ltr' }, ` (${where})`) : null);
  };

  const load = async () => {
    const d = await api('GET', '/admin/audit-integrity');
    const verifyBtn = h('button', { type: 'button', class: 'p-btn p-btn--primary' }, t('admin.integrity.verify'));
    const cpBtn = can(session, 'admin.manage') && d.configuration.checkpointKeyConfigured
      ? h('button', { type: 'button', class: 'p-btn p-btn--ghost' }, t('admin.integrity.checkpoint')) : null;
    verifyBtn.addEventListener('click', async () => {
      setBusy(verifyBtn, true, t('admin.integrity.verifying'));
      mount(status);
      try {
        const r = await api('POST', '/admin/audit-integrity/verify', {});
        await load();
        mount(status, r.outcome === 'ok'
          ? alertBox('success', t('admin.integrity.ok', { rows: String(r.chainRows), checkpoints: String(r.checkpointsChecked) }))
          : alertBox('error', t('admin.integrity.failed'), null, h('ul', {}, r.findings.map(findingText))));
      } catch (err) {
        mount(status, alertBox('error', errorMessage(err)));
      } finally {
        setBusy(verifyBtn, false);
      }
    });
    cpBtn?.addEventListener('click', async () => {
      setBusy(cpBtn, true);
      mount(status);
      try {
        await api('POST', '/admin/audit-integrity/checkpoint', {});
        await load();
        mount(status, alertBox('success', t('admin.integrity.checkpointDone')));
      } catch (err) {
        mount(status, alertBox('error', errorMessage(err)));
      } finally {
        setBusy(cpBtn, false);
      }
    });
    const last = d.verifications[0];
    mount(body,
      h('div', { class: 'p-grid' },
        card(t('admin.integrity.state'), dl([
          [t('admin.integrity.rows'), String(d.chain.rows)],
          [t('admin.integrity.lastSeq'), String(d.chain.lastSeq)],
          [t('admin.integrity.custody'), String(d.custodyEvents)],
          [t('admin.integrity.lastVerification'), last ? `${when(last.runAt)} · ${t(`admin.integrity.outcome.${last.outcome}`)}` : t('admin.integrity.never')],
        ])),
        card(t('admin.integrity.config'), dl([
          [t('admin.integrity.keyConfigured'), yesNo(d.configuration.checkpointKeyConfigured)],
          [t('admin.integrity.keyId'), ltr(d.configuration.checkpointKeyId)],
          [t('admin.integrity.sink'), t(`admin.integrity.sink.${d.configuration.sink}`)],
        ]), d.configuration.checkpointKeyConfigured ? null : h('p', { class: 'p-small p-muted' }, t('admin.integrity.noKey')))),
      h('div', { class: 'p-actions' }, verifyBtn, cpBtn),
      card(t('admin.integrity.verifications'), table(
        [t('admin.col.time'), t('admin.integrity.trigger'), t('admin.col.outcome'), t('admin.integrity.rows'), t('admin.integrity.checkpoints'), t('admin.integrity.findings')],
        d.verifications.map((v) => [when(v.runAt), t(`admin.integrity.trigger.${v.trigger}`), t(`admin.integrity.outcome.${v.outcome}`), String(v.chainRows), String(v.checkpointsChecked),
          v.findings.length ? h('ul', { class: 'p-small' }, v.findings.map(findingText)) : '–']))),
      card(t('admin.integrity.checkpoints'), table(
        [t('admin.col.time'), t('admin.integrity.lastSeq'), t('admin.integrity.custody'), t('admin.integrity.keyId'), t('admin.integrity.sink'), t('admin.integrity.headHash')],
        d.checkpoints.map((c) => [when(c.createdAt), String(c.auditLastSeq), String(c.custodyCount), ltr(c.keyId), t(`admin.integrity.sink.${c.sink}`), ltr(c.auditLastHash ? `${c.auditLastHash}…` : '–')]))),
      h('p', { class: 'p-small p-muted' }, t('admin.integrity.runbook')));
  };
  try {
    await load();
  } catch (err) {
    mount(body, alertBox('error', errorMessage(err)));
  }
}
