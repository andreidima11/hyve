/** Boot overlay progress bar — monotonic client + optional server startup blend. */

import { fetchWithTimeout } from './api.js';

let _current = 0;
const _BOOT_STATUS_TIMEOUT_MS = 5000;

function _barEl(): HTMLElement | null {
    return document.getElementById('boot-overlay-progress');
}

function _fillEl(): HTMLElement | null {
    return document.getElementById('boot-overlay-progress-fill');
}

export function resetBootProgress(): void {
    _current = 0;
    const fill = _fillEl();
    const bar = _barEl();
    if (fill) fill.style.width = '0%';
    if (bar) {
        bar.classList.add('is-indeterminate');
        bar.setAttribute('aria-valuenow', '0');
    }
}

export function setBootProgress(percent: number, message?: string): void {
    const next = Math.max(_current, Math.max(0, Math.min(100, percent)));
    _current = next;
    const fill = _fillEl();
    const bar = _barEl();
    if (fill) fill.style.width = `${next}%`;
    if (bar) {
        bar.classList.toggle('is-indeterminate', next <= 0);
        bar.setAttribute('aria-valuenow', String(Math.round(next)));
    }
    if (typeof message === 'string' && message.trim()) {
        const text = document.getElementById('boot-overlay-text');
        if (text) text.textContent = message.trim();
    }
}

/** Blend client boot steps (dominant) with server `/api/startup/status` progress. */
export function mergeBootProgress(clientPercent: number, serverPercent: number, message?: string): void {
    const server = Math.max(0, Math.min(100, serverPercent));
    const client = Math.max(0, Math.min(100, clientPercent));
    const blended = Math.min(100, Math.round(client * 0.72 + server * 0.28));
    setBootProgress(blended, message);
}

export async function pollServerBootProgressOnce(): Promise<number> {
    try {
        const res = await fetchWithTimeout('/api/startup/status', {
            method: 'GET',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
        }, _BOOT_STATUS_TIMEOUT_MS);
        if (!res.ok) return 0;
        const data = await res.json() as { progress?: number };
        return typeof data.progress === 'number' ? data.progress : 0;
    } catch {
        return 0;
    }
}

export async function refreshBootProgress(clientPercent: number, message?: string): Promise<void> {
    mergeBootProgress(clientPercent, 0, message);
    void pollServerBootProgressOnce().then((server) => {
        mergeBootProgress(clientPercent, server, message);
    });
}

export function completeBootProgress(message?: string): void {
    setBootProgress(100, message);
    const bar = _barEl();
    bar?.classList.remove('is-indeterminate');
}
