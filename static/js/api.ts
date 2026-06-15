/** HTTP client with JWT refresh for Hyve API routes. */

export type ApiCallOptions = Omit<RequestInit, 'body'> & {
    /** Optional fetch timeout in milliseconds. */
    timeout?: number;
    body?: BodyInit | Record<string, unknown> | null;
};

interface TokenRefreshResponse {
    access_token: string;
    refresh_token: string;
}

interface SseTokenResponse {
    sse_token?: string;
}

interface RememberPayload {
    t?: string;
    rt?: string;
    [key: string]: unknown;
}

export let authToken: string | null = localStorage.getItem('hyve_token');

/** Canonical bearer token — reads localStorage so every ESM copy stays in sync. */
export function resolveAuthToken(): string | null {
    try {
        const stored = localStorage.getItem('hyve_token');
        if (stored && stored !== 'null' && stored !== 'undefined') {
            authToken = stored;
            return stored;
        }
    } catch {
        /* storage blocked */
    }
    return authToken;
}
let _refreshToken: string | null = localStorage.getItem('hyve_refresh_token');
let _suppressLogout = false;
let _refreshing: Promise<boolean> | null = null;

export function setAuthToken(token: string | null): void {
    authToken = token;
    if (token) {
        localStorage.setItem('hyve_token', token);
    } else {
        localStorage.removeItem('hyve_token');
    }
}

export function setRefreshToken(token: string | null): void {
    _refreshToken = token;
    if (token) {
        localStorage.setItem('hyve_refresh_token', token);
    } else {
        localStorage.removeItem('hyve_refresh_token');
    }
}

export function clearAuthToken(): void {
    authToken = null;
    _refreshToken = null;
    localStorage.removeItem('hyve_token');
    localStorage.removeItem('hyve_refresh_token');
}

export function suppressLogout(suppress: boolean): void {
    _suppressLogout = suppress;
}

export function isNetworkFetchError(error: unknown): boolean {
    return error instanceof TypeError && /fetch/i.test(String((error as Error)?.message || ''));
}

async function _tryRefresh(): Promise<boolean> {
    if (!_refreshToken) return false;
    if (_refreshing) return _refreshing;
    _refreshing = (async () => {
        try {
            const res = await fetch('/api/token/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: _refreshToken }),
            });
            if (!res.ok) return false;
            const data = (await res.json()) as TokenRefreshResponse;
            setAuthToken(data.access_token);
            setRefreshToken(data.refresh_token);
            try {
                const rm = localStorage.getItem('hyve_remember');
                if (rm) {
                    const parsed = JSON.parse(rm) as RememberPayload;
                    parsed.t = data.access_token;
                    parsed.rt = data.refresh_token;
                    localStorage.setItem('hyve_remember', JSON.stringify(parsed));
                }
            } catch {
                /* ignore corrupt remember payload */
            }
            return true;
        } catch {
            return false;
        } finally {
            _refreshing = null;
        }
    })();
    return _refreshing;
}

/** Get a short-lived SSE exchange token for EventSource/WebSocket connections. */
export async function getSSEToken(): Promise<string> {
    try {
        const res = await apiCall('/api/token/sse', { method: 'POST' });
        if (res.ok) {
            const data = (await res.json()) as SseTokenResponse;
            return data.sse_token || '';
        }
    } catch {
        /* fall through */
    }
    return '';
}

export async function apiCall(url: string, options: ApiCallOptions = {}): Promise<Response> {
    const { timeout: requestedTimeout = 0, body: rawBody, ...rest } = options;
    const headers: Record<string, string> = {
        ...((rest.headers as Record<string, string> | undefined) || {}),
    };
    const token = resolveAuthToken();
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }

    let body: BodyInit | null | undefined =
        rawBody === null ? null : (rawBody as BodyInit | undefined);
    if (rawBody && typeof rawBody === 'object' && !(rawBody instanceof FormData) && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(rawBody);
    }

    const fetchOpts: RequestInit = { ...rest, headers, body };

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (requestedTimeout && !fetchOpts.signal && typeof AbortController !== 'undefined') {
        const ctrl = new AbortController();
        fetchOpts.signal = ctrl.signal;
        timeoutId = setTimeout(() => ctrl.abort(), requestedTimeout);
    }

    let res: Response;
    try {
        res = await fetch(url, fetchOpts);
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            const e = new Error(`Request timeout (${requestedTimeout}ms): ${url}`) as Error & { name: string; url: string };
            e.name = 'TimeoutError';
            e.url = url;
            throw e;
        }
        throw err;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }

    if (res.status === 401 && !_suppressLogout) {
        const hadAuth = !!resolveAuthToken();
        if (!hadAuth) {
            return res;
        }
        const refreshed = await _tryRefresh();
        if (refreshed) {
            const retryToken = resolveAuthToken();
            if (retryToken) headers.Authorization = `Bearer ${retryToken}`;
            return fetch(url, fetchOpts);
        }
        clearAuthToken();
        try { localStorage.removeItem('hyve_remember'); } catch { /* ignore */ }
        if (!window.location.search.includes('_expired=')) {
            window.location.replace(`/?_expired=${Date.now()}`);
        }
        throw new Error('Session expired.');
    }
    return res;
}
