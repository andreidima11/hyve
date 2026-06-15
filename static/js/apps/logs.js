import { apiCall } from '../api.js';
import { escapeHtml, openSubPage, closeSubPage } from '../utils.js';
import { t } from '../lang/index.js';
import { appsState } from './state.js';
import * as render from './render.js';
let _logPollTimer = null;
export function openAppLogModal(slug, name) {
    appsState.currentLogSlug = slug;
    const title = document.getElementById('app-log-title');
    if (title)
        title.innerHTML = `<i class="fas fa-terminal"></i><span>${escapeHtml(t('apps.log_title', { name }))}</span>`;
    openSubPage('app-log-modal');
    refreshAppLogs();
    _stopLogPoll();
    _logPollTimer = setInterval(refreshAppLogs, 3000);
}
export function closeAppLogModal() {
    appsState.currentLogSlug = null;
    _stopLogPoll();
    closeSubPage('app-log-modal');
}
function _stopLogPoll() {
    if (_logPollTimer) {
        clearInterval(_logPollTimer);
        _logPollTimer = null;
    }
}
export async function refreshAppLogs() {
    if (!appsState.currentLogSlug)
        return;
    const pre = document.getElementById('app-log-content');
    if (!pre)
        return;
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(appsState.currentLogSlug)}/logs?tail=300`);
        const data = await res.json();
        const lines = data.lines || [];
        pre.textContent = lines.length ? lines.join('\n') : t('apps.logs_empty');
        pre.scrollTop = pre.scrollHeight;
    }
    catch (e) {
        pre.textContent = t('apps.logs_error', { message: render._errMsg(e) });
    }
}
