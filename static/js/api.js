/** HTTP client with JWT refresh for Hyve API routes. */
/** Refresh access token this often while the tab is open (access token default: 24 h). */
const PROACTIVE_REFRESH_MS = 45 * 60 * 1000;
export let authToken = localStorage.getItem('hyve_token');
/** Canonical bearer token — reads localStorage so every ESM copy stays in sync. */
export function resolveAuthToken() {
    try {
        const stored = localStorage.getItem('hyve_token');
        if (stored && stored !== 'null' && stored !== 'undefined') {
            authToken = stored;
            return stored;
        }
    }
    catch {
        /* storage blocked */
    }
    return authToken;
}
function resolveRefreshToken() {
    try {
        const stored = localStorage.getItem('hyve_refresh_token');
        if (stored && stored !== 'null' && stored !== 'undefined') {
            _refreshToken = stored;
            return stored;
        }
    }
    catch {
        /* storage blocked */
    }
    return _refreshToken;
}
let _refreshToken = localStorage.getItem('hyve_refresh_token');
let _suppressLogout = false;
let _refreshing = null;
function _notifyAuthChanged(loggedIn) {
    try {
        window.dispatchEvent(new CustomEvent('hyve:auth-changed', { detail: { loggedIn } }));
    }
    catch {
        /* ignore */
    }
}
export function setAuthToken(token) {
    authToken = token;
    if (token) {
        localStorage.setItem('hyve_token', token);
    }
    else {
        localStorage.removeItem('hyve_token');
    }
    _notifyAuthChanged(!!token);
}
export function setRefreshToken(token) {
    _refreshToken = token;
    if (token) {
        localStorage.setItem('hyve_refresh_token', token);
    }
    else {
        localStorage.removeItem('hyve_refresh_token');
    }
}
export function clearAuthToken() {
    authToken = null;
    _refreshToken = null;
    localStorage.removeItem('hyve_token');
    localStorage.removeItem('hyve_refresh_token');
    _notifyAuthChanged(false);
}
export function suppressLogout(suppress) {
    _suppressLogout = suppress;
}
export function isNetworkFetchError(error) {
    return error instanceof TypeError && /fetch/i.test(String(error?.message || ''));
}
async function _probeAccessToken(access) {
    try {
        const res = await fetch('/api/users/me', { headers: { Authorization: `Bearer ${access}` } });
        return res.ok;
    }
    catch {
        return false;
    }
}
async function _tryRefresh() {
    const tokenUsed = resolveRefreshToken();
    if (!tokenUsed)
        return false;
    if (_refreshing)
        return _refreshing;
    _refreshing = (async () => {
        try {
            const res = await fetch('/api/token/refresh', {
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
            const data = (await res.json());
            setAuthToken(data.access_token);
            setRefreshToken(data.refresh_token);
            try {
                const rm = localStorage.getItem('hyve_remember');
                if (rm) {
                    const parsed = JSON.parse(rm);
                    parsed.t = data.access_token;
                    parsed.rt = data.refresh_token;
                    localStorage.setItem('hyve_remember', JSON.stringify(parsed));
                }
            }
            catch {
                /* ignore corrupt remember payload */
            }
            return true;
        }
        catch {
            return false;
        }
        finally {
            _refreshing = null;
        }
    })();
    return _refreshing;
}
/** Exchange refresh token for a new access token (shared single-flight). */
export async function refreshSession() {
    return _tryRefresh();
}
/** Keep sessions alive while the UI stays open (and on tab focus). */
export function initProactiveSessionRefresh() {
    if (typeof window === 'undefined')
        return;
    const w = window;
    if (w.__hyveSessionRefreshInit)
        return;
    w.__hyveSessionRefreshInit = true;
    const tick = () => {
        if (document.hidden)
            return;
        if (!resolveRefreshToken())
            return;
        void refreshSession();
    };
    window.setInterval(tick, PROACTIVE_REFRESH_MS);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden)
            tick();
    });
    window.addEventListener('focus', tick);
}
/** Get a short-lived SSE exchange token for EventSource/WebSocket connections. */
export async function getSSEToken() {
    try {
        const res = await apiCall('/api/token/sse', { method: 'POST' });
        if (res.ok) {
            const data = (await res.json());
            return data.sse_token || '';
        }
    }
    catch {
        /* fall through */
    }
    return '';
}
export async function apiCall(url, options = {}) {
    const { timeout: requestedTimeout = 0, body: rawBody, ...rest } = options;
    const headers = {
        ...(rest.headers || {}),
    };
    const token = resolveAuthToken();
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }
    let body = rawBody === null ? null : rawBody;
    if (rawBody && typeof rawBody === 'object' && !(rawBody instanceof FormData) && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(rawBody);
    }
    const fetchOpts = { ...rest, headers, body };
    let timeoutId = null;
    if (requestedTimeout && !fetchOpts.signal && typeof AbortController !== 'undefined') {
        const ctrl = new AbortController();
        fetchOpts.signal = ctrl.signal;
        timeoutId = setTimeout(() => ctrl.abort(), requestedTimeout);
    }
    let res;
    try {
        res = await fetch(url, fetchOpts);
    }
    catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            const e = new Error(`Request timeout (${requestedTimeout}ms): ${url}`);
            e.name = 'TimeoutError';
            e.url = url;
            throw e;
        }
        throw err;
    }
    finally {
        if (timeoutId)
            clearTimeout(timeoutId);
    }
    if (res.status === 401 && !_suppressLogout) {
        const hadAuth = !!resolveAuthToken() || !!resolveRefreshToken();
        if (!hadAuth) {
            return res;
        }
        const refreshed = await _tryRefresh();
        if (refreshed) {
            const retryToken = resolveAuthToken();
            if (retryToken)
                headers.Authorization = `Bearer ${retryToken}`;
            return fetch(url, fetchOpts);
        }
        clearAuthToken();
        try {
            localStorage.removeItem('hyve_remember');
        }
        catch { /* ignore */ }
        if (!window.location.search.includes('_expired=')) {
            window.location.replace(`/?_expired=${Date.now()}`);
        }
        throw new Error('Session expired.');
    }
    return res;
}
