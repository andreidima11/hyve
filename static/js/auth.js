import { apiCall, clearAuthToken, refreshSession, setAuthToken, setRefreshToken } from './api.js';
const _RM_KEY = 'hyve_remember';
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
        setTimeout(() => { if (!_try())
            setTimeout(_try, 2000); }, 500);
    }
}
export async function handleLogin(e) {
    e.preventDefault();
    const user = document.getElementById('login-user')?.value || '';
    const pass = document.getElementById('login-pass')?.value || '';
    const remember = document.getElementById('login-remember')?.checked;
    const err = document.getElementById('login-error');
    const btn = e.target?.querySelector('button');
    if (btn)
        btn.disabled = true;
    err?.classList.add('hidden');
    try {
        const formData = new FormData();
        formData.append('username', user);
        formData.append('password', pass);
        const res = await fetch('/api/token', { method: 'POST', body: formData });
        if (!res.ok)
            throw new Error('login failed');
        const data = await res.json();
        setAuthToken(data.access_token);
        if (data.refresh_token)
            setRefreshToken(data.refresh_token);
        _pushTokenToNative(data.access_token);
        if (remember) {
            localStorage.setItem(_RM_KEY, JSON.stringify({ u: user, t: data.access_token, rt: data.refresh_token }));
        }
        else {
            localStorage.removeItem(_RM_KEY);
        }
        if (typeof window.bootHyve === 'function') {
            try {
                await window.bootHyve();
                return;
            }
            catch { /* fall through to reload */ }
        }
        location.reload();
    }
    catch {
        err?.classList.remove('hidden');
        if (btn)
            btn.disabled = false;
    }
}
export function restoreRememberedCredentials() {
    try {
        const raw = localStorage.getItem(_RM_KEY);
        if (!raw)
            return;
        const data = JSON.parse(raw);
        const userEl = document.getElementById('login-user');
        const remEl = document.getElementById('login-remember');
        if (userEl && data.u)
            userEl.value = data.u;
        if (remEl)
            remEl.checked = true;
        if (data.p) {
            localStorage.removeItem(_RM_KEY);
        }
    }
    catch { /* ignore */ }
}
export async function tryAutoLogin() {
    try {
        if (await refreshSession()) {
            const access = localStorage.getItem('hyve_token');
            if (access)
                _pushTokenToNative(access);
            return true;
        }
        const raw = localStorage.getItem(_RM_KEY);
        if (!raw)
            return false;
        const data = JSON.parse(raw);
        if (!data.u)
            return false;
        if (data.p) {
            localStorage.removeItem(_RM_KEY);
            return false;
        }
        if (data.t) {
            if (data.rt)
                setRefreshToken(data.rt);
            const res = await fetch('/api/users/me', { headers: { Authorization: `Bearer ${data.t}` } });
            if (res.ok) {
                setAuthToken(data.t);
                _pushTokenToNative(data.t);
                return true;
            }
            if (data.rt && await refreshSession()) {
                const access = localStorage.getItem('hyve_token');
                if (access) {
                    localStorage.setItem(_RM_KEY, JSON.stringify({
                        u: data.u,
                        t: access,
                        rt: localStorage.getItem('hyve_refresh_token') || data.rt,
                    }));
                    _pushTokenToNative(access);
                    return true;
                }
            }
            localStorage.removeItem(_RM_KEY);
            clearAuthToken();
            return false;
        }
        return false;
    }
    catch {
        return false;
    }
}
export async function loadUserProfile() {
    try {
        const res = await apiCall('/api/users/me');
        if (res.ok) {
            const userProfile = await res.json();
            const displayNameEl = document.getElementById('user-display-name');
            const initialsEl = document.getElementById('user-initials');
            const initialsDesktopEl = document.getElementById('user-initials-desktop');
            const profileUserEl = document.getElementById('profile-username');
            const profileInitEl = document.getElementById('profile-initial');
            if (displayNameEl && userProfile.username)
                displayNameEl.innerText = userProfile.username;
            if (initialsEl && userProfile.username) {
                initialsEl.innerText = userProfile.username[0].toUpperCase();
            }
            if (initialsDesktopEl && userProfile.username) {
                initialsDesktopEl.innerText = userProfile.username[0].toUpperCase();
            }
            if (profileUserEl && userProfile.username)
                profileUserEl.innerText = userProfile.username;
            if (profileInitEl && userProfile.username) {
                profileInitEl.innerText = userProfile.username[0].toUpperCase();
            }
            const waStatus = document.getElementById('wa-link-status');
            const waNumber = document.getElementById('wa-linked-number');
            if (userProfile.phones && userProfile.phones.length > 0) {
                waStatus?.classList.remove('hidden');
                if (waNumber)
                    waNumber.innerText = userProfile.phones.join(', ');
            }
            return userProfile;
        }
    }
    catch { /* ignore */ }
    return undefined;
}
export async function handleLinkWhatsApp(e) {
    e.preventDefault();
    const phone = document.getElementById('wa-phone-input')?.value;
    if (!phone)
        return;
    const res = await apiCall('/api/users/link-whatsapp', { method: 'POST', body: { phone_number: phone } });
    if (res.ok) {
        void loadUserProfile();
    }
}
