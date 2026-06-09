import { t } from './lang/index.js';
let _pollTimer = null;
let _visible = false;
function _indicatorEl() {
    return document.getElementById('nav-hub-startup-indicator');
}
function _statusMessage(data) {
    if (!data || data.ready)
        return '';
    const pending = Array.isArray(data.pending) ? data.pending.filter(Boolean) : [];
    if (pending.length) {
        const taskKey = `startup.task_${pending[0]}`;
        const taskLabel = t(taskKey);
        const label = taskLabel !== taskKey ? taskLabel : (data.pending_labels?.[0] || pending[0]);
        return t('startup.loading_detail', { task: label }) || `Loading ${label}…`;
    }
    return t('startup.loading') || 'Starting up…';
}
export function setHubStartupLoading(visible, message = '') {
    const el = _indicatorEl();
    if (!el)
        return;
    _visible = !!visible;
    el.classList.toggle('hidden', !visible);
    el.setAttribute('aria-hidden', visible ? 'false' : 'true');
    const text = message || (t('startup.loading') || 'Starting up…');
    el.setAttribute('title', text);
    el.setAttribute('aria-label', text);
}
export function stopStartupStatusPolling() {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
}
async function _pollStartupStatus() {
    try {
        const token = localStorage.getItem('hyve_token');
        const headers = { Accept: 'application/json' };
        if (token && token !== 'null' && token !== 'undefined') {
            headers.Authorization = `Bearer ${token}`;
        }
        const res = await fetch('/api/startup/status', { method: 'GET', credentials: 'same-origin', headers });
        if (!res.ok)
            return;
        const data = await res.json();
        if (data.ready) {
            setHubStartupLoading(false);
            stopStartupStatusPolling();
            return;
        }
        setHubStartupLoading(true, _statusMessage(data));
    }
    catch {
        if (_visible) {
            setHubStartupLoading(true, t('startup.reconnecting') || 'Reconnecting…');
        }
    }
}
export function startStartupStatusPolling({ immediate = true } = {}) {
    stopStartupStatusPolling();
    setHubStartupLoading(true);
    if (immediate)
        void _pollStartupStatus();
    _pollTimer = setInterval(() => { void _pollStartupStatus(); }, 1500);
}
export function showHubStartupLoadingAfterRestart() {
    setHubStartupLoading(true, t('startup.restarting') || 'Restarting…');
    startStartupStatusPolling({ immediate: false });
}
