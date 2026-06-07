/**
 * Tiny authed fetch wrapper for Hyveview API calls.
 * Reuses the same hyve_token JWT that the main app stores.
 */

export async function hvFetch(url, options = {}) {
  const jwt = localStorage.getItem('hyve_token');
  const headers = { ...(options.headers || {}) };
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    options.body = JSON.stringify(options.body);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    location.href = '/';
    throw new Error('unauthorized');
  }
  return res;
}

export async function hvJson(url, options = {}) {
  const res = await hvFetch(url, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} — ${text}`);
  }
  return res.json();
}
