import { ApiError } from './api.js';
import { h, mount, nextId } from './dom.js';
import { t } from './i18n.js';

/** User-facing message for an API error. Never echoes server internals. */
export function errorMessage(err) {
  if (err instanceof ApiError) {
    if (err.code === 'RATE_LIMITED') return t('error.RATE_LIMITED', { minutes: Math.max(1, Math.ceil((err.retryAfter || 60) / 60)) });
    const key = `error.${err.code}`;
    const text = t(key);
    return text === key ? t('error.GENERIC') : text;
  }
  return t('error.GENERIC');
}

export function alertBox(type, title, body, extra) {
  const role = type === 'error' ? 'alert' : 'status';
  return h('div', { class: `p-alert p-alert--${type}`, role },
    h('div', {}, title ? h('strong', { class: 'p-alert__title' }, title) : null, body ? h('p', {}, body) : null, extra || null));
}

/** A labelled input with hint and error slots wired up with aria-describedby / aria-invalid. */
export function field({ label, name, type = 'text', value = '', hint, autocomplete, required = true, inputmode, maxlength, readonly, min, max, dir }) {
  const id = nextId(name);
  const hintId = hint ? `${id}-hint` : null;
  const errorId = `${id}-error`;
  const input = h('input', {
    class: 'p-input', id, name, type, autocomplete, inputmode, maxlength, readonly, min, max, dir,
    required: required || undefined, 'aria-required': required ? 'true' : undefined, 'aria-describedby': hintId || undefined,
  });
  input.value = value ?? '';
  const error = h('p', { class: 'p-error', id: errorId, hidden: true });
  const wrap = h('div', { class: 'p-field' }, h('label', { class: 'p-label', for: id }, label), hint ? h('p', { class: 'p-hint', id: hintId }, hint) : null, input, error);
  return withErrors({ wrap, input, error, errorId, hintId, label });
}

/** Password input with an accessible show/hide toggle. */
export function passwordField({ label, name, autocomplete, hint }) {
  const f = field({ label, name, type: 'password', autocomplete, hint, maxlength: 512 });
  const toggle = h('button', { type: 'button', class: 'p-password__toggle', 'aria-controls': f.input.id, 'aria-pressed': 'false', 'aria-label': t('common.showPasswordLabel') }, t('common.showPassword'));
  toggle.addEventListener('click', () => {
    const show = f.input.type === 'password';
    f.input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', t(show ? 'common.hidePasswordLabel' : 'common.showPasswordLabel'));
    toggle.textContent = t(show ? 'common.hidePassword' : 'common.showPassword');
  });
  const box = h('div', { class: 'p-password' });
  f.input.replaceWith(box);
  box.append(f.input, toggle);
  return f;
}

/** Radio group rendered as selectable cards. */
export function choiceGroup({ legend, name, options, value, inline = false }) {
  const id = nextId(name);
  const errorId = `${id}-error`;
  const inputs = [];
  const fs = h('fieldset', { id, 'aria-describedby': errorId },
    h('legend', {}, legend),
    h('div', { class: `p-choices${inline ? ' p-choices--inline' : ''}` },
      options.map((o) => {
        const input = h('input', { type: 'radio', name, value: o.value, checked: o.value === value || undefined });
        inputs.push(input);
        return h('label', { class: 'p-choice' }, input, h('span', {}, h('span', { class: 'p-choice__title' }, o.label), o.description ? h('span', { class: 'p-choice__desc' }, o.description) : null));
      })),
    h('p', { class: 'p-error', id: errorId, hidden: true }));
  const error = fs.querySelector(`#${CSS.escape(errorId)}`);
  const api = {
    wrap: fs, input: inputs[0], error, label: legend,
    get value() { return inputs.find((i) => i.checked)?.value ?? null; },
    setError(msg) { error.textContent = msg; error.hidden = false; fs.setAttribute('aria-invalid', 'true'); },
    clearError() { error.hidden = true; error.textContent = ''; fs.removeAttribute('aria-invalid'); },
    onChange(fn) { inputs.forEach((i) => i.addEventListener('change', () => fn(api.value))); },
  };
  return api;
}

/** A required checkbox (e.g. a confirmation) that works with validate(). */
export function checkboxField({ label, name }) {
  const id = nextId(name);
  const errorId = `${id}-error`;
  const input = h('input', { type: 'checkbox', id, name, required: true, 'aria-describedby': errorId });
  const error = h('p', { class: 'p-error', id: errorId, hidden: true });
  const wrap = h('div', { class: 'p-field p-mt-m' }, h('label', { class: 'p-check', for: id }, input, h('span', {}, label)), error);
  const f = {
    wrap, input, error, label,
    setError(msg) { error.textContent = msg; error.hidden = false; input.setAttribute('aria-invalid', 'true'); },
    clearError() { error.hidden = true; error.textContent = ''; input.removeAttribute('aria-invalid'); },
  };
  input.addEventListener('change', () => f.clearError());
  return f;
}

function withErrors(f) {
  const base = f.hintId;
  f.setError = (msg) => {
    f.error.textContent = msg;
    f.error.hidden = false;
    f.input.setAttribute('aria-invalid', 'true');
    f.input.setAttribute('aria-describedby', [base, f.errorId].filter(Boolean).join(' '));
  };
  f.clearError = () => {
    f.error.hidden = true;
    f.error.textContent = '';
    f.input.removeAttribute('aria-invalid');
    if (base) f.input.setAttribute('aria-describedby', base);
    else f.input.removeAttribute('aria-describedby');
  };
  f.input.addEventListener('input', () => f.clearError());
  return f;
}

/**
 * Runs validators ([fieldApi, message|null]) and shows an error summary linking to each problem.
 * Returns true when everything is valid.
 */
export function validate(summaryHost, checks) {
  const problems = [];
  for (const [f, message] of checks) {
    if (message) {
      f.setError(message);
      problems.push([f, message]);
    } else f.clearError();
  }
  if (!problems.length) {
    mount(summaryHost);
    return true;
  }
  const summary = h('div', { class: 'p-alert p-alert--error p-error-summary', role: 'alert', tabindex: '-1' },
    h('div', {}, h('strong', { class: 'p-alert__title' }, t('common.fixErrors')),
      h('ul', {}, problems.map(([f, msg]) => h('li', {}, h('a', {
        href: `#${f.input.id}`,
        onclick: (e) => { e.preventDefault(); f.input.focus(); },
      }, msg))))));
  mount(summaryHost, summary);
  summary.focus();
  return false;
}

export function setBusy(button, busy, busyText) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = busyText || t('common.pleaseWait');
  } else {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.label) button.textContent = button.dataset.label;
  }
}

export function loading() {
  return h('p', { class: 'p-loading', role: 'status' }, t('app.loading'));
}

export function pageHeading(text, lead) {
  return [h('h1', { class: 'p-h1', tabindex: '-1', id: 'page-title' }, text), lead ? h('p', { class: 'p-lead' }, lead) : null];
}

export function focusTitle() {
  document.getElementById('page-title')?.focus({ preventScroll: false });
}

// ---- Shared client-side checks (the server validates again) -----------------------------------
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function emailProblem(value) {
  if (!value.trim()) return t('v.required', { field: t('field.email') });
  return EMAIL_RE.test(value.trim()) ? null : t('v.email');
}

export function newPasswordProblem(password, email) {
  const length = [...password].length;
  if (!password) return t('v.required', { field: t('field.password') });
  if (length < 12) return t('v.passwordShort');
  if (length > 128) return t('v.passwordLong');
  if (/^(.)\1+$/.test(password)) return t('v.passwordSimple');
  if (email) {
    const lower = password.toLowerCase();
    const local = email.toLowerCase().split('@')[0] || '';
    if (lower === email.toLowerCase() || (local.length >= 4 && lower.includes(local))) return t('v.passwordEmail');
  }
  return null;
}
