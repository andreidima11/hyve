import { apiCall, setAuthToken, setRefreshToken, clearAuthToken } from './api.js';

const _RM_KEY = 'memini_remember';

/** Push auth token to native Android bridge with retry (bridge may load after auth.js). */
function _pushTokenToNative(token) {
    function _try() {
        if (window.__saveNativeAuthToken) {
            window.__saveNativeAuthToken(token);
            return true;
        }
        return false;
    }
    if (!_try()) {
        // Bridge script might not be injected yet — retry a few times
        setTimeout(() => { if (!_try()) setTimeout(_try, 2000); }, 500);
    }
}

export async function handleLogin(e) {
    e.preventDefault();
    const user = document.getElementById('login-user').value;
    const pass = document.getElementById('login-pass').value;
    const remember = document.getElementById('login-remember')?.checked;
    const err = document.getElementById('login-error');
    const btn = e.target.querySelector('button');
    
    if(btn) btn.disabled = true;
    if(err) err.classList.add('hidden');

    try {
        const formData = new FormData();
        formData.append('username', user);
        formData.append('password', pass);
        
        const res = await fetch('/api/token', { method: 'POST', body: formData });
        if (!res.ok) throw new Error();
        
        const data = await res.json();
        setAuthToken(data.access_token);
        if (data.refresh_token) setRefreshToken(data.refresh_token);
        
        // Save token to native Android app if present
        _pushTokenToNative(data.access_token);
        
        if (remember) {
            // Store only username + tokens (never the password)
            localStorage.setItem(_RM_KEY, JSON.stringify({ u: user, t: data.access_token, rt: data.refresh_token }));
        } else {
            localStorage.removeItem(_RM_KEY);
        }
        location.reload();
    } catch (e) {
        if(err) err.classList.remove('hidden');
        if(btn) btn.disabled = false;
    }
}

export function restoreRememberedCredentials() {
    try {
        const raw = localStorage.getItem(_RM_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        const userEl = document.getElementById('login-user');
        const remEl = document.getElementById('login-remember');
        if (userEl && data.u) userEl.value = data.u;
        if (remEl) remEl.checked = true;
        // Legacy migration: clear stored password if present
        if (data.p) {
            localStorage.removeItem(_RM_KEY);
        }
    } catch (e) { /* ignore */ }
}

export async function tryAutoLogin() {
    try {
        const raw = localStorage.getItem(_RM_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data.u) return false;
        // Legacy migration: if password was stored, clear it
        if (data.p) {
            localStorage.removeItem(_RM_KEY);
            return false;
        }
        // Use stored token directly
        if (data.t) {
            // Restore refresh token if present
            if (data.rt) setRefreshToken(data.rt);
            // Validate token is still good BEFORE storing it
            const res = await fetch('/api/users/me', { headers: { 'Authorization': `Bearer ${data.t}` } });
            if (res.ok) {
                setAuthToken(data.t);
                // Save token to native Android app if present
                _pushTokenToNative(data.t);
                return true;
            }
            // Access token expired — try refresh
            if (data.rt) {
                try {
                    const rr = await fetch('/api/token/refresh', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ refresh_token: data.rt }),
                    });
                    if (rr.ok) {
                        const rd = await rr.json();
                        setAuthToken(rd.access_token);
                        if (rd.refresh_token) setRefreshToken(rd.refresh_token);
                        localStorage.setItem(_RM_KEY, JSON.stringify({ u: data.u, t: rd.access_token, rt: rd.refresh_token }));
                        _pushTokenToNative(rd.access_token);
                        return true;
                    }
                } catch (_) {}
            }
            // Refresh also failed — clear everything
            localStorage.removeItem(_RM_KEY);
            clearAuthToken();
            return false;
        }
        return false;
    } catch (e) { return false; }
}

export async function loadUserProfile() {
    try {
        const res = await apiCall('/api/users/me');
        if(res.ok) {
            const userProfile = await res.json();
            const displayNameEl = document.getElementById('user-display-name');
            const initialsEl = document.getElementById('user-initials');
            const initialsDesktopEl = document.getElementById('user-initials-desktop');
            const profileUserEl = document.getElementById('profile-username');
            const profileInitEl = document.getElementById('profile-initial');

            if (displayNameEl) displayNameEl.innerText = userProfile.username;
            if (initialsEl && userProfile.username) {
                initialsEl.innerText = userProfile.username[0].toUpperCase();
            }
            if (initialsDesktopEl && userProfile.username) {
                initialsDesktopEl.innerText = userProfile.username[0].toUpperCase();
            }
            if (profileUserEl) profileUserEl.innerText = userProfile.username;
            if (profileInitEl && userProfile.username) {
                profileInitEl.innerText = userProfile.username[0].toUpperCase();
            }
            
            const waStatus = document.getElementById('wa-link-status');
            const waNumber = document.getElementById('wa-linked-number');
            if (userProfile.phones?.length > 0) {
                if(waStatus) waStatus.classList.remove('hidden');
                if(waNumber) waNumber.innerText = userProfile.phones.join(', ');
            }
            return userProfile;
        }
    } catch(e) {}
}

export async function handleLinkWhatsApp(e) {
    e.preventDefault();
    const phone = document.getElementById('wa-phone-input').value;
    if(!phone) return;
    const res = await apiCall('/api/users/link-whatsapp', { method: 'POST', body: { phone_number: phone } });
    if(res.ok) { loadUserProfile(); }
}