/**
 * Tiny authed fetch wrapper for Hyveview API calls.
 */
export async function hvFetch(url, options = {}) {
    const jwt = localStorage.getItem('hyve_token');
    const headers = { ...(options.headers || {}) };
    if (jwt)
        headers['Authorization'] = `Bearer ${jwt}`;
    const next = { ...options, headers };
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
        next.body = JSON.stringify(options.body);
        if (!headers['Content-Type'])
            headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, next);
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
