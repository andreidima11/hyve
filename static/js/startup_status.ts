import { suppressLogout } from './api.js';
import { t } from './lang/index.js';
import type { StartupStatusResponse, StartupSubsystemIssue } from './types/dashboard.js';

let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _visible = false;

function _indicatorEl(): HTMLElement | null {
    return document.getElementById('nav-hub-startup-indicator');
}

function _indicatorIconEl(): HTMLElement | null {
    return document.getElementById('nav-hub-startup-icon');
}

function _subsystemLabel(issue: StartupSubsystemIssue): string {
    const key = `startup.subsystem_${issue.name}`;
    const translated = t(key);
    return translated !== key ? translated : (issue.label || issue.name || '');
}

function _issuesMessage(data: StartupStatusResponse): string {
    const issues = Array.isArray(data.issues) ? data.issues : [];
    if (!issues.length) {
        return data.health === 'fatal'
            ? (t('startup.fatal_summary') || 'Critical startup failure')
            : (t('startup.degraded_summary') || 'Some services started with issues');
    }
    const first = issues[0];
    const label = _subsystemLabel(first);
    const detail = String(first.message || '').trim();
    if (detail) {
        return t('startup.issue_detail', { subsystem: label, message: detail })
            || `${label}: ${detail}`;
    }
    return t('startup.issue_one', { subsystem: label }) || label;
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

function _setIndicatorMode(mode: 'loading' | 'degraded' | 'fatal' | 'hidden', message = ''): void {
    const el = _indicatorEl();
    const icon = _indicatorIconEl();
    if (!el) return;

    if (mode === 'hidden') {
        _visible = false;
        el.classList.add('hidden');
        el.classList.remove('hub-startup-indicator--degraded', 'hub-startup-indicator--fatal');
        el.setAttribute('aria-hidden', 'true');
        if (icon) {
            icon.className = 'fas fa-circle-notch fa-spin';
        }
        return;
    }

    _visible = true;
    el.classList.remove('hidden');
    el.classList.toggle('hub-startup-indicator--degraded', mode === 'degraded');
    el.classList.toggle('hub-startup-indicator--fatal', mode === 'fatal');
    el.setAttribute('aria-hidden', 'false');
    if (icon) {
        if (mode === 'loading') {
            icon.className = 'fas fa-circle-notch fa-spin';
        } else if (mode === 'fatal') {
            icon.className = 'fas fa-circle-exclamation';
        } else {
            icon.className = 'fas fa-triangle-exclamation';
        }
    }
    const text = message || (t('startup.loading') || 'Starting up…');
    el.setAttribute('title', text);
    el.setAttribute('aria-label', text);
}

export function setHubStartupLoading(visible: boolean, message = ''): void {
    if (!visible) {
        _setIndicatorMode('hidden');
        return;
    }
    _setIndicatorMode('loading', message);
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
            stopStartupStatusPolling();
            const health = data.health || 'ok';
            if (health === 'ok') {
                _setIndicatorMode('hidden');
                return;
            }
            _setIndicatorMode(health === 'fatal' ? 'fatal' : 'degraded', _issuesMessage(data));
            return;
        }
        _setIndicatorMode('loading', _statusMessage(data));
    } catch {
        if (_visible) {
            _setIndicatorMode('loading', t('startup.reconnecting') || 'Reconnecting…');
        }
    }
}

export function startStartupStatusPolling({ immediate = true }: { immediate?: boolean } = {}): void {
    stopStartupStatusPolling();
    _setIndicatorMode('loading');
    if (immediate) void _pollStartupStatus();
    _pollTimer = setInterval(() => { void _pollStartupStatus(); }, 1500);
}

export function showHubStartupLoadingAfterRestart(): void {
    _setIndicatorMode('loading', t('startup.restarting') || 'Restarting…');
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
