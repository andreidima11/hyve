/** Boot overlay progress bar — monotonic client + optional server startup blend. */
let _current = 0;
function _barEl() {
    return document.getElementById('boot-overlay-progress');
}
function _fillEl() {
    return document.getElementById('boot-overlay-progress-fill');
}
export function resetBootProgress() {
    _current = 0;
    const fill = _fillEl();
    const bar = _barEl();
    if (fill)
        fill.style.width = '0%';
    if (bar) {
        bar.classList.add('is-indeterminate');
        bar.setAttribute('aria-valuenow', '0');
    }
}
export function setBootProgress(percent, message) {
    const next = Math.max(_current, Math.max(0, Math.min(100, percent)));
    _current = next;
    const fill = _fillEl();
    const bar = _barEl();
    if (fill)
        fill.style.width = `${next}%`;
    if (bar) {
        bar.classList.toggle('is-indeterminate', next <= 0);
        bar.setAttribute('aria-valuenow', String(Math.round(next)));
    }
    if (typeof message === 'string' && message.trim()) {
        const text = document.getElementById('boot-overlay-text');
        if (text)
            text.textContent = message.trim();
    }
}
/** Blend client boot steps (dominant) with server `/api/startup/status` progress. */
export function mergeBootProgress(clientPercent, serverPercent, message) {
    const server = Math.max(0, Math.min(100, serverPercent));
    const client = Math.max(0, Math.min(100, clientPercent));
    const blended = Math.min(100, Math.round(client * 0.72 + server * 0.28));
    setBootProgress(blended, message);
}
export async function pollServerBootProgressOnce() {
    try {
        const token = localStorage.getItem('hyve_token');
        const headers = { Accept: 'application/json' };
        if (token && token !== 'null' && token !== 'undefined') {
            headers.Authorization = `Bearer ${token}`;
        }
        const res = await fetch('/api/startup/status', {
            method: 'GET',
            credentials: 'same-origin',
            headers,
        });
        if (!res.ok)
            return 0;
        const data = await res.json();
        return typeof data.progress === 'number' ? data.progress : 0;
    }
    catch {
        return 0;
    }
}
export async function refreshBootProgress(clientPercent, message) {
    const server = await pollServerBootProgressOnce();
    mergeBootProgress(clientPercent, server, message);
}
export function completeBootProgress(message) {
    setBootProgress(100, message);
    const bar = _barEl();
    bar?.classList.remove('is-indeterminate');
}
