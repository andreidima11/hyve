/**
 * Server restart + reconnect polling.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { showToast, showConfirm } from '../utils.js';
import { watchServerRestartAndReload } from '../startup_status.js';
import { errMsg } from './utils.js';

export async function restartServer() {
    if (!(await showConfirm(t('config.restart_confirm')))) return;
    showToast(t('config.restart_started'), 'info', 8000);
    watchServerRestartAndReload();
    try {
        const resp = await apiCall('/api/restart', { method: 'POST' });
        if (!resp.ok) {
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
            return;
        }
    }
}
