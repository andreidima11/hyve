// EventSource client for live integration entity updates.
import { apiCall } from './api.js';
let _es = null;
let _refCount = 0;
let _currentSlug = null;
let _reconnectTimer = null;
let _shuttingDown = false;
const LIVE_STREAM_SOURCES = new Set(['mosquitto']);
async function _fetchSseToken() {
    try {
        const res = await apiCall('/api/token/sse', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.sse_token)
            return null;
        return data.sse_token;
    }
    catch {
        return null;
    }
}
async function _open(slug) {
    if (_es)
        return;
    const token = await _fetchSseToken();
    if (!token) {
        console.warn('entity_live: no SSE token; aborting');
        return;
    }
    const url = `/api/integrations/events?source=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`;
    _es = new EventSource(url);
    _es.addEventListener('message', (e) => {
        try {
            const detail = JSON.parse(String(e.data));
            if (detail && detail.type === 'entity') {
                window.dispatchEvent(new CustomEvent('entity-state-changed', { detail }));
            }
        }
        catch {
            /* ignore malformed SSE payload */
        }
    });
    _es.addEventListener('refresh', () => {
        window.dispatchEvent(new CustomEvent('entity-discovery-refresh'));
    });
    _es.addEventListener('bridge', (e) => {
        try {
            const detail = JSON.parse(String(e.data));
            window.dispatchEvent(new CustomEvent('entity-bridge-status', { detail }));
        }
        catch {
            /* ignore */
        }
    });
    _es.addEventListener('error', () => {
        if (_shuttingDown)
            return;
        try {
            _es?.close();
        }
        catch { /* ignore */ }
        _es = null;
        if (_reconnectTimer)
            clearTimeout(_reconnectTimer);
        _reconnectTimer = setTimeout(() => {
            _reconnectTimer = null;
            if (_refCount > 0 && _currentSlug)
                void _open(_currentSlug);
        }, 3000);
    });
}
export async function startEntityLiveStream(slug = 'mosquitto') {
    const normalized = String(slug || 'mosquitto').trim() || 'mosquitto';
    if (!LIVE_STREAM_SOURCES.has(normalized))
        return;
    _refCount += 1;
    _currentSlug = normalized;
    _shuttingDown = false;
    if (!_es)
        await _open(normalized);
}
export function stopEntityLiveStream() {
    _refCount = Math.max(0, _refCount - 1);
    if (_refCount > 0)
        return;
    _shuttingDown = true;
    if (_reconnectTimer) {
        clearTimeout(_reconnectTimer);
        _reconnectTimer = null;
    }
    if (_es) {
        try {
            _es.close();
        }
        catch { /* ignore */ }
        _es = null;
    }
    _currentSlug = null;
}
window.addEventListener('entity-state-changed', (e) => {
    const detail = e.detail || {};
    const eid = detail.entity_id;
    if (!eid)
        return;
    const stateText = (detail.state == null || detail.state === '') ? 'unknown' : String(detail.state);
    const sel = `[data-entity-state="${CSS.escape(eid)}"]`;
    document.querySelectorAll(sel).forEach((el) => {
        const existingHtml = el.innerHTML;
        const m = existingHtml.match(/<span[^>]*class="[^"]*ml-1[^"]*"[^>]*>(.*?)<\/span>$/);
        if (m) {
            el.innerHTML = `${stateText}<span class="text-slate-400 text-base ml-1">${m[1]}</span>`;
        }
        else {
            const txt = el.textContent || '';
            const u = txt.match(/\s([^\s\d.]+)\s*$/);
            el.textContent = u ? `${stateText} ${u[1]}` : stateText;
        }
        const lower = stateText.toLowerCase();
        if (lower === 'on' || lower === 'open' || lower === 'unlocked') {
            el.classList.remove('text-slate-400', 'text-slate-200');
            el.classList.add('text-accent');
        }
        else if (lower === 'off' || lower === 'closed' || lower === 'locked') {
            el.classList.remove('text-accent', 'text-slate-200');
            el.classList.add('text-slate-400');
        }
    });
    const numericState = Number(stateText);
    if (Number.isFinite(numericState)) {
        document.querySelectorAll(`input[data-entity-control="${CSS.escape(eid)}"]`).forEach((input) => {
            if (input instanceof HTMLInputElement)
                input.value = String(numericState);
        });
    }
    const toggleSelector = [
        `.app-toggle-switch[data-entity-toggle="${CSS.escape(eid)}"]`,
        `.app-toggle-switch[data-smarthome-entity-id="${CSS.escape(eid)}"]`,
        `.app-toggle-switch[onclick*="${CSS.escape(eid)}"]`,
    ].join(', ');
    document.querySelectorAll(toggleSelector).forEach((btn) => {
        if (!(btn instanceof HTMLElement))
            return;
        const lower = String(detail.state || '').toLowerCase();
        const isOn = lower === 'on' || lower === 'open' || lower === 'unlocked' || lower === 'playing' || lower === 'heat' || lower === 'cool' || lower === 'home';
        btn.dataset.on = isOn ? 'true' : 'false';
        btn.setAttribute('aria-checked', isOn ? 'true' : 'false');
        if (btn.dataset.smarthomeDeviceAction) {
            btn.dataset.smarthomeDeviceAction = isOn ? 'turn_off' : 'turn_on';
        }
        const card = btn.closest('.hyve-dashboard-card');
        if (card instanceof HTMLElement && card.dataset.entityId === eid) {
            card.dataset.on = isOn ? 'true' : 'false';
            const stateEl = card.querySelector('.hyve-dashboard-card__state');
            if (stateEl)
                stateEl.textContent = stateText;
        }
        const cur = btn.getAttribute('onclick') || '';
        btn.setAttribute('onclick', cur.replace(/'(turn_on|turn_off)'/, `'${isOn ? 'turn_off' : 'turn_on'}'`)
            .replace(/"(turn_on|turn_off)"/, `"${isOn ? 'turn_off' : 'turn_on'}"`));
    });
});
