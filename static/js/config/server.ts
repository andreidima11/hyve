/**
 * Server restart + reconnect polling.
 */
import { apiCall, suppressLogout } from '../api.js';
import { t } from '../lang/index.js';
import { showToast, showConfirm } from '../utils.js';
import { showHubStartupLoadingAfterRestart } from '../startup_status.js';
import { errMsg } from './utils.js';

export async function restartServer() {
    if (!(await showConfirm(t('config.restart_confirm')))) return;
    suppressLogout(true);
    showHubStartupLoadingAfterRestart();
    showToast(t('config.restart_started'), 'info', 8000);
    try {
        const resp = await apiCall('/api/restart', { method: 'POST' });
        if (!resp.ok) {
            suppressLogout(false);
            let detail = `HTTP ${resp.status}`;
            try {
                const data = await resp.json();
                detail = data.detail || data.message || detail;
                if (typeof detail === 'object') detail = JSON.stringify(detail);
            } catch (_) {}
            showToast(String(detail), 'error');
            return;
        }
    } catch (e) {
        // Network error after restart starts is expected; keep polling
        if (errMsg(e) === 'Session expired.') {
            suppressLogout(false);
            return;
        }
    }
    startReconnectPolling();
}
function startReconnectPolling() {
    const maxAttempts = 30;
    let attempts = 0;
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('hyve_token') : null;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const tryReconnect = () => {
        attempts++;
        fetch('/api/config', { method: 'GET', credentials: 'same-origin', headers })
            .then(r => {
                if (r.ok) {
                    suppressLogout(false);
                    location.reload();
                }
            })
            .catch(() => {})
            .finally(() => { if (attempts < maxAttempts) setTimeout(tryReconnect, 2000); else suppressLogout(false); });
    };
    setTimeout(tryReconnect, 3000);
}
