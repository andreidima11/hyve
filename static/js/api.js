export let authToken = localStorage.getItem('hyve_token');
let _refreshToken = localStorage.getItem('hyve_refresh_token');
let _suppressLogout = false;
let _refreshing = null; // singleton refresh promise to avoid races

export function setAuthToken(token) {
    authToken = token;
    localStorage.setItem('hyve_token', token);
}

export function setRefreshToken(token) {
    _refreshToken = token;
    if (token) {
        localStorage.setItem('hyve_refresh_token', token);
    } else {
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

/**
 * Try to refresh the access token using the refresh token.
 * Returns true if refresh succeeded, false otherwise.
 */
async function _tryRefresh() {
    if (!_refreshToken) return false;
    // Coalesce concurrent refresh attempts
    if (_refreshing) return _refreshing;
    _refreshing = (async () => {
        try {
            const res = await fetch('/api/token/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refresh_token: _refreshToken }),
            });
            if (!res.ok) return false;
            const data = await res.json();
            setAuthToken(data.access_token);
            setRefreshToken(data.refresh_token);
            // Update remembered credentials if stored
            try {
                const rm = localStorage.getItem('hyve_remember');
                if (rm) {
                    const parsed = JSON.parse(rm);
                    parsed.t = data.access_token;
                    parsed.rt = data.refresh_token;
                    localStorage.setItem('hyve_remember', JSON.stringify(parsed));
                }
            } catch (_) {}
            return true;
        } catch (_) {
            return false;
        } finally {
            _refreshing = null;
        }
    })();
    return _refreshing;
}

/**
 * Get a short-lived SSE exchange token for EventSource/WebSocket connections.
 */
export async function getSSEToken() {
    try {
        const res = await apiCall('/api/token/sse', { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            return data.sse_token;
        }
    } catch (_) {}
    return '';
}

export async function apiCall(url, options = {}) {
    if (!options.headers) options.headers = {};
    if (authToken) {
        options.headers['Authorization'] = `Bearer ${authToken}`;
    }

    if (options.body && typeof options.body === 'object' && !options.headers['Content-Type']) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
    }

    // Optional per-call timeout. No default: long-running endpoints keep their
    // old behavior unless the caller explicitly opts into cancellation.
    const requestedTimeout = Number(options.timeout || 0);
    let timeoutId = null;
    if (requestedTimeout && !options.signal && typeof AbortController !== 'undefined') {
        const ctrl = new AbortController();
        options.signal = ctrl.signal;
        timeoutId = setTimeout(() => ctrl.abort(), requestedTimeout);
    }
    delete options.timeout;

    let res;
    try {
        res = await fetch(url, options);
    } catch (err) {
        if (err && err.name === 'AbortError') {
            const e = new Error(`Request timeout (${requestedTimeout}ms): ${url}`);
            e.name = 'TimeoutError';
            e.url = url;
            throw e;
        }
        throw err;
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }

    if (res.status === 401 && !_suppressLogout) {
        // Try refresh before logging out
        const refreshed = await _tryRefresh();
        if (refreshed) {
            // Retry the original request with new token
            options.headers['Authorization'] = `Bearer ${authToken}`;
            return fetch(url, options);
        }
        clearAuthToken();
        try { localStorage.removeItem('hyve_remember'); } catch (e) {}
        window.location.replace('/?_expired=' + Date.now());
        throw new Error("Session expired.");
    }
    return res;
}