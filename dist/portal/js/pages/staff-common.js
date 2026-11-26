import { api } from '../core/api.js';
import { h, nextId } from '../core/dom.js';
import { formatAge, formatDateTime, lang, t } from '../core/i18n.js';
import { statusBadge } from './common.js';

// Remembered per device so staff don't re-select their branch on every page. It holds only a
// branch id (not personal data); the server re-checks the assignment on every request.
const BRANCH_KEY = 'traced-staff-branch';

export function branchLabel(b) {
  return lang === 'ar' ? `${b.nameAr} – ${b.cityAr}` : `${b.nameEn} – ${b.cityEn}`;
}

export async function loadStaff() {
  const me = await api('GET', '/staff/me');
  let saved = null;
  try {
    saved = localStorage.getItem(BRANCH_KEY);
  } catch {
    /* storage unavailable */
  }
  const branch = me.branches.find((b) => b.id === saved) ?? me.branches[0] ?? null;
  return { ...me, branch };
}

export function rememberBranch(id) {
  try {
    localStorage.setItem(BRANCH_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

/** Branch picker (only shown when the staff member has more than one branch). */
export function branchPicker(staff, onChange) {
  if (staff.branches.length < 2) {
    return h('p', { class: 'p-muted p-small' }, `${t('staff.branch')}: `, h('strong', {}, branchLabel(staff.branch)));
  }
  const id = nextId('branch');
  const select = h('select', { class: 'p-select', id },
    staff.branches.map((b) => h('option', { value: b.id, selected: b.id === staff.branch.id || undefined }, branchLabel(b))));
  select.addEventListener('change', () => {
    rememberBranch(select.value);
    onChange(staff.branches.find((b) => b.id === select.value));
  });
  return h('div', { class: 'p-field' }, h('label', { class: 'p-label', for: id }, t('staff.branch')), h('p', { class: 'p-hint' }, t('staff.branchHint')), select);
}

export const genderLabel = (g) => t(`reg.gender.${g}`);

/** One collection as staff may see it: tracking ID, age, gender, sample, status, time, branch. */
export function collectionItem(item) {
  return h('li', { class: 'p-item' },
    h('div', {},
      h('p', { class: 'p-item__title p-ltr' }, item.trackingId),
      h('p', { class: 'p-item__meta' },
        h('span', {}, formatAge(item.patientAge)),
        h('span', {}, genderLabel(item.patientGender)),
        h('span', {}, t('staff.sampleHair')),
        h('span', {}, formatDateTime(item.collectedAt)),
        h('span', {}, branchLabel(item.branch)),
        item.collectedByMe ? h('span', {}, t('staff.byMe')) : null)),
    statusBadge(item.sampleStatus));
}
