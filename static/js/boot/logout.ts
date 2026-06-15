/** Logout flow — available before async boot completes. */

import { clearAuthToken, suppressLogout } from '../api.js';
import { showConfirm } from '../utils.js';
import { t } from '../lang/index.js';

async function doLogout() {
    // Show confirmation dialog
    const confirmMessage = t('header.logout_confirm');
    if (!(await showConfirm(confirmMessage))) {
        return;
    }

    const token = localStorage.getItem('hyve_token');

    const finalizeLogout = () => {
    try {
        if (window.__clearNativeAuthToken) {
            window.__clearNativeAuthToken();
        }
    } catch (e) {}
    try { clearAuthToken(); } catch (e) {}
    try {
        localStorage.removeItem('hyve_token');
        localStorage.removeItem('hyve_session_id');
        localStorage.removeItem('hyve_remember');
        sessionStorage.clear();
    } catch (e) {}

    const overlay = document.getElementById('login-overlay');
    if (overlay) overlay.classList.remove('hidden');

    // Force a fresh page load (bypass Cloudflare / browser cache)
    const logoutUrl = '/?_logout=' + Date.now();
    window.location.replace(logoutUrl);
    setTimeout(() => {
        if (!window.location.search.includes('_logout=')) {
            window.location.href = logoutUrl;
        }
    }, 250);
    };

    if (!token) {
        finalizeLogout();
        return;
    }

    const logoutRequest = fetch('/api/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        keepalive: true,
    }).catch(() => {});

    Promise.race([
        logoutRequest,
        new Promise(resolve => setTimeout(resolve, 300)),
    ]).finally(finalizeLogout);
}

window.doLogout = doLogout;

export { doLogout };
