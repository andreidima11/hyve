import { suppressLogout } from './api.js';
import { t } from './lang/index.js';
import type { StartupStatusResponse } from './types/dashboard.js';

let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _visible = false;

function _indicatorEl(): HTMLElement | null {
    return document.getElementById('nav-hub-startup-indicator');
}

function _statusMessage(data: StartupStatusResponse | null | undefined): string {
    if (!data || data.ready) return '';
    const pending = Array.isArray(data.pending) ? data.pending.filter(Boolean) : [];
    if (pending.length) {
        const taskKey = `startup.task_${pending[0]}`;
        const taskLabel = t(taskKey);
        const label = taskLabel !== taskKey ? taskLabel : (data.pending_labels?.[0] || pending[0]);
        return t('startup.loading_detail', { task: label }) || `Loading ${label}…`;
    }
    return t('startup.loading') || 'Starting up…';
}

export function setHubStartupLoading(visible: boolean, message = ''): void {
    const el = _indicatorEl();
    if (!el) return;
    _visible = !!visible;
    el.classList.toggle('hidden', !visible);
    el.setAttribute('aria-hidden', visible ? 'false' : 'true');
    const text = message || (t('startup.loading') || 'Starting up…');
    el.setAttribute('title', text);
    el.setAttribute('aria-label', text);
}

export function stopStartupStatusPolling(): void {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
}

async function _pollStartupStatus(): Promise<void> {
    try {
        const token = localStorage.getItem('hyve_token');
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (token && token !== 'null' && token !== 'undefined') {
            headers.Authorization = `Bearer ${token}`;
        }
        const res = await fetch('/api/startup/status', { method: 'GET', credentials: 'same-origin', headers });
        if (!res.ok) return;
        const data = await res.json() as StartupStatusResponse;
        if (data.ready) {
            setHubStartupLoading(false);
            stopStartupStatusPolling();
            return;
        }
        setHubStartupLoading(true, _statusMessage(data));
    } catch {
        if (_visible) {
            setHubStartupLoading(true, t('startup.reconnecting') || 'Reconnecting…');
        }
    }
}

export function startStartupStatusPolling({ immediate = true }: { immediate?: boolean } = {}): void {
    stopStartupStatusPolling();
    setHubStartupLoading(true);
    if (immediate) void _pollStartupStatus();
    _pollTimer = setInterval(() => { void _pollStartupStatus(); }, 1500);
}

export function showHubStartupLoadingAfterRestart(): void {
    setHubStartupLoading(true, t('startup.restarting') || 'Restarting…');
    startStartupStatusPolling({ immediate: false });
}

/** Show restart UI, poll until the server responds, then reload the page. */
export function watchServerRestartAndReload(): void {
    suppressLogout(true);
    showHubStartupLoadingAfterRestart();
    _startReconnectPolling();
}

function _startReconnectPolling(): void {
    const maxAttempts = 30;
    let attempts = 0;
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('hyve_token') : null;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token && token !== 'null' && token !== 'undefined') {
        headers.Authorization = `Bearer ${token}`;
    }
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
            .finally(() => {
                if (attempts < maxAttempts) setTimeout(tryReconnect, 2000);
                else suppressLogout(false);
            });
    };
    setTimeout(tryReconnect, 3000);
}
