/** HTTP client with JWT refresh for Hyve API routes. */
export let authToken = localStorage.getItem('hyve_token');
let _refreshToken = localStorage.getItem('hyve_refresh_token');
let _suppressLogout = false;
let _refreshing = null;
export function setAuthToken(token) {
    authToken = token;
    if (token) {
        localStorage.setItem('hyve_token', token);
    }
    else {
        localStorage.removeItem('hyve_token');
    }
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
}
export function suppressLogout(suppress) {
    _suppressLogout = suppress;
}
export function isNetworkFetchError(error) {
    return error instanceof TypeError && /fetch/i.test(String(error?.message || ''));
}
async function _tryRefresh() {
    if (!_refreshToken)
        return false;
    if (_refreshing)
        return _refreshing;
    _refreshing = (async () => {
        try {
            const res = await fetch('/api/token/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: _refreshToken }),
            });
            if (!res.ok)
                return false;
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
    if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
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
        const hadAuth = !!(authToken || headers.Authorization);
        if (!hadAuth) {
            return res;
        }
        const refreshed = await _tryRefresh();
        if (refreshed) {
            headers.Authorization = `Bearer ${authToken}`;
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
