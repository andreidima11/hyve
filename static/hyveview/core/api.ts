/**
 * Tiny authed fetch wrapper for Hyveview API calls.
 */

export async function hvFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const jwt = localStorage.getItem('hyve_token');
    const headers: Record<string, string> = { ...(options.headers as Record<string, string> || {}) };
    if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
    const next: RequestInit = { ...options, headers };
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
        next.body = JSON.stringify(options.body);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, next);
    if (res.status === 401) {
        location.href = '/';
        throw new Error('unauthorized');
    }
    return res;
}

export async function hvJson<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
    const res = await hvFetch(url, options);
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`${res.status} ${res.statusText} — ${text}`);
    }
    return res.json() as Promise<T>;
}
