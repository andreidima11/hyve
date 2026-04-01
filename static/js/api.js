export let authToken = localStorage.getItem('memini_token');
let _refreshToken = localStorage.getItem('memini_refresh_token');
let _suppressLogout = false;
let _refreshing = null; // singleton refresh promise to avoid races

export function setAuthToken(token) {
    authToken = token;
    localStorage.setItem('memini_token', token);
}

export function setRefreshToken(token) {
    _refreshToken = token;
    if (token) {
        localStorage.setItem('memini_refresh_token', token);
    } else {
        localStorage.removeItem('memini_refresh_token');
    }
}

export function clearAuthToken() {
    authToken = null;
    _refreshToken = null;
    localStorage.removeItem('memini_token');
    localStorage.removeItem('memini_refresh_token');
}

export function suppressLogout(suppress) {
    _suppressLogout = suppress;
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
                const rm = localStorage.getItem('memini_remember');
                if (rm) {
                    const parsed = JSON.parse(rm);
                    parsed.t = data.access_token;
                    parsed.rt = data.refresh_token;
                    localStorage.setItem('memini_remember', JSON.stringify(parsed));
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
 * Falls back to the regular auth token if the endpoint fails.
 */
export async function getSSEToken() {
    try {
        const res = await apiCall('/api/token/sse', { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            return data.sse_token;
        }
    } catch (_) {}
    // Fallback: use regular token (backward compat)
    return authToken || '';
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
    
    const res = await fetch(url, options);
    
    if (res.status === 401 && !_suppressLogout) {
        // Try refresh before logging out
        const refreshed = await _tryRefresh();
        if (refreshed) {
            // Retry the original request with new token
            options.headers['Authorization'] = `Bearer ${authToken}`;
            return fetch(url, options);
        }
        clearAuthToken();
        try { localStorage.removeItem('memini_remember'); } catch (e) {}
        window.location.replace('/?_expired=' + Date.now());
        throw new Error("Session expired."); 
    }
    return res;
}