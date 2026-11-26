// Client for the TRACED API. The session lives in an HttpOnly cookie the page can't read;
// the CSRF token is kept in memory only (never localStorage) and sent on every write.

let csrfToken = null;

export class ApiError extends Error {
  constructor(status, code, message, details, retryAfter) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details || null;
    this.retryAfter = retryAfter || null;
  }
}

export function setCsrf(token) {
  csrfToken = token || null;
}

export async function api(method, path, body, options = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

  let res;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }

  let data = null;
  if (res.status !== 204) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }
  if (data && typeof data.csrfToken === 'string') setCsrf(data.csrfToken);
  if (!res.ok) {
    const err = (data && data.error) || {};
    throw new ApiError(res.status, err.code || `HTTP_${res.status}`, err.message, err.details, Number(res.headers.get('Retry-After')) || null);
  }
  return data;
}

/**
 * POST that returns a file (Phase 7 personal-data export). The file stays in memory: it is handed
 * to the browser as a one-off object URL and the URL is revoked straight away.
 */
export async function apiDownload(path, body) {
  const headers = { Accept: 'text/csv, application/json', 'Content-Type': 'application/json' };
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let res;
  try {
    res = await fetch(`/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Network error');
  }
  if (!res.ok) {
    let err = {};
    try { err = (await res.json()).error || {}; } catch { /* not JSON */ }
    throw new ApiError(res.status, err.code || `HTTP_${res.status}`, err.message, err.details, Number(res.headers.get('Retry-After')) || null);
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'export.csv';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return { name, rows: Number(res.headers.get('X-Export-Rows')) || 0, sha256: res.headers.get('X-Export-Sha256') || '' };
}

/** The signed-in user, or null. */
export async function loadSession() {
  try {
    const data = await api('GET', '/auth/me');
    return data.user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function newIdempotencyKey() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
