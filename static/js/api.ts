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

/** Refresh access token this often while the tab is open (access token default: 24 h). */
const PROACTIVE_REFRESH_MS = 45 * 60 * 1000;
/** Default timeout for auth/refresh calls so boot cannot hang forever on a stalled network. */
const AUTH_FETCH_TIMEOUT_MS = 12_000;

export async function fetchWithTimeout(
    url: string,
    options: RequestInit = {},
    timeoutMs = AUTH_FETCH_TIMEOUT_MS,
): Promise<Response> {
    if (!timeoutMs || timeoutMs <= 0 || options.signal || typeof AbortController === 'undefined') {
        return fetch(url, options);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: ctrl.signal });
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            const e = new Error(`Request timeout (${timeoutMs}ms): ${url}`) as Error & { name: string; url: string };
            e.name = 'TimeoutError';
            e.url = url;
            throw e;
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function _safeStorageGet(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

export let authToken: string | null = _safeStorageGet('hyve_token');

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

function resolveRefreshToken(): string | null {
    try {
        const stored = localStorage.getItem('hyve_refresh_token');
        if (stored && stored !== 'null' && stored !== 'undefined') {
            _refreshToken = stored;
            return stored;
        }
    } catch {
        /* storage blocked */
    }
    return _refreshToken;
}

let _refreshToken: string | null = _safeStorageGet('hyve_refresh_token');
let _suppressLogout = false;
let _refreshing: Promise<boolean> | null = null;

function _notifyAuthChanged(loggedIn: boolean): void {
    try {
        window.dispatchEvent(new CustomEvent('hyve:auth-changed', { detail: { loggedIn } }));
    } catch {
        /* ignore */
    }
}

export function setAuthToken(token: string | null): void {
    authToken = token;
    try {
        if (token) localStorage.setItem('hyve_token', token);
        else localStorage.removeItem('hyve_token');
    } catch {
        /* storage blocked */
    }
    _notifyAuthChanged(!!token);
}

export function setRefreshToken(token: string | null): void {
    _refreshToken = token;
    try {
        if (token) localStorage.setItem('hyve_refresh_token', token);
        else localStorage.removeItem('hyve_refresh_token');
    } catch {
        /* storage blocked */
    }
}

export function clearAuthToken(): void {
    authToken = null;
    _refreshToken = null;
    try {
        localStorage.removeItem('hyve_token');
        localStorage.removeItem('hyve_refresh_token');
    } catch {
        /* storage blocked */
    }
    _notifyAuthChanged(false);
}

export function suppressLogout(suppress: boolean): void {
    _suppressLogout = suppress;
}

export function isNetworkFetchError(error: unknown): boolean {
    return error instanceof TypeError && /fetch/i.test(String((error as Error)?.message || ''));
}

async function _probeAccessToken(access: string): Promise<boolean> {
    try {
        const res = await fetch('/api/users/me', { headers: { Authorization: `Bearer ${access}` } });
        return res.ok;
    } catch {
        return false;
    }
}

async function _tryRefresh(): Promise<boolean> {
    const tokenUsed = resolveRefreshToken();
    if (!tokenUsed) return false;
    if (_refreshing) return _refreshing;
    _refreshing = (async () => {
        try {
            const res = await fetchWithTimeout('/api/token/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: tokenUsed }),
            });
            if (!res.ok) {
                // Another tab may have rotated tokens — adopt fresh pair if valid.
                const latestRt = localStorage.getItem('hyve_refresh_token');
                const latestAt = localStorage.getItem('hyve_token');
                if (latestRt && latestRt !== tokenUsed && latestAt) {
                    if (await _probeAccessToken(latestAt)) {
                        authToken = latestAt;
                        _refreshToken = latestRt;
                        return true;
                    }
                }
                return false;
            }
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

/** Exchange refresh token for a new access token (shared single-flight). */
export async function refreshSession(): Promise<boolean> {
    return _tryRefresh();
}

/** Keep sessions alive while the UI stays open (and on tab focus). */
export function initProactiveSessionRefresh(): void {
    if (typeof window === 'undefined') return;
    const w = window as Window & { __hyveSessionRefreshInit?: boolean };
    if (w.__hyveSessionRefreshInit) return;
    w.__hyveSessionRefreshInit = true;

    const tick = () => {
        if (document.hidden) return;
        if (!resolveRefreshToken()) return;
        void refreshSession();
    };
    window.setInterval(tick, PROACTIVE_REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) tick();
    });
    window.addEventListener('focus', tick);
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
        const hadAuth = !!resolveAuthToken() || !!resolveRefreshToken();
        if (!hadAuth) {
            return res;
        }
        const refreshed = await _tryRefresh();
        if (refreshed) {
            const retryToken = resolveAuthToken();
            if (retryToken) headers.Authorization = `Bearer ${retryToken}`;
            const { signal: _drop, ...retryRest } = fetchOpts;
            return fetch(url, { ...retryRest, headers: { ...headers } });
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
