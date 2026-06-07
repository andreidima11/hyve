// EventSource client for live integration entity updates.
//
// Subscribes to /api/integrations/events?source=mosquitto&token=<sse> and
// dispatches `entity-state-changed` CustomEvents on `window` with detail:
//   { entity_id, state, raw, attributes_delta }
//
// Consumers (cards, modal) listen and patch the DOM in place. The connection
// is lazy: started by `startEntityLiveStream(slug)` and torn down by
// `stopEntityLiveStream()`. Reference-counted so multiple views can share it.

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
        if (!res.ok || !data.sse_token) return null;
        return data.sse_token;
    } catch (_) {
        return null;
    }
}

async function _open(slug) {
    if (_es) return;
    const token = await _fetchSseToken();
    if (!token) {
        console.warn('entity_live: no SSE token; aborting');
        return;
    }
    const url = `/api/integrations/events?source=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`;
    _es = new EventSource(url);

    _es.addEventListener('message', (e) => {
        try {
            const detail = JSON.parse(e.data);
            if (detail && detail.type === 'entity') {
                window.dispatchEvent(new CustomEvent('entity-state-changed', { detail }));
            }
        } catch (_) {}
    });

    _es.addEventListener('refresh', () => {
        window.dispatchEvent(new CustomEvent('entity-discovery-refresh'));
    });

    _es.addEventListener('bridge', (e) => {
        try {
            const detail = JSON.parse(e.data);
            window.dispatchEvent(new CustomEvent('entity-bridge-status', { detail }));
        } catch (_) {}
    });

    _es.addEventListener('error', () => {
        // Browser auto-retries, but if the token expired we need a fresh one.
        if (_shuttingDown) return;
        try { _es && _es.close(); } catch (_) {}
        _es = null;
        if (_reconnectTimer) clearTimeout(_reconnectTimer);
        _reconnectTimer = setTimeout(() => {
            _reconnectTimer = null;
            if (_refCount > 0 && _currentSlug) _open(_currentSlug);
        }, 3000);
    });
}

export async function startEntityLiveStream(slug = 'mosquitto') {
    slug = String(slug || 'mosquitto').trim() || 'mosquitto';
    if (!LIVE_STREAM_SOURCES.has(slug)) return;
    _refCount += 1;
    _currentSlug = slug;
    _shuttingDown = false;
    if (!_es) await _open(slug);
}

export function stopEntityLiveStream() {
    _refCount = Math.max(0, _refCount - 1);
    if (_refCount > 0) return;
    _shuttingDown = true;
    if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
    if (_es) {
        try { _es.close(); } catch (_) {}
        _es = null;
    }
    _currentSlug = null;
}

// ── DOM patching helpers ────────────────────────────────────────────────────

window.addEventListener('entity-state-changed', (e) => {
    const d = e.detail || {};
    const eid = d.entity_id;
    if (!eid) return;
    const stateText = (d.state == null || d.state === '') ? 'unknown' : String(d.state);
    const sel = `[data-entity-state="${CSS.escape(eid)}"]`;
    document.querySelectorAll(sel).forEach((el) => {
        // Preserve unit if it was already shown after the value
        const existingHtml = el.innerHTML;
        const m = existingHtml.match(/<span[^>]*class="[^"]*ml-1[^"]*"[^>]*>(.*?)<\/span>$/);
        if (m) {
            el.innerHTML = `${stateText}<span class="text-slate-400 text-base ml-1">${m[1]}</span>`;
        } else {
            // Try to keep " <unit>" suffix in plain text
            const txt = el.textContent || '';
            const u = txt.match(/\s([^\s\d\.]+)\s*$/);
            el.textContent = u ? `${stateText} ${u[1]}` : stateText;
        }
        // Recolor switch-like states
        const lower = stateText.toLowerCase();
        if (lower === 'on' || lower === 'open' || lower === 'unlocked') {
            el.classList.remove('text-slate-400', 'text-slate-200');
            el.classList.add('text-accent');
        } else if (lower === 'off' || lower === 'closed' || lower === 'locked') {
            el.classList.remove('text-accent', 'text-slate-200');
            el.classList.add('text-slate-400');
        }
    });
    const numericState = Number(stateText);
    if (Number.isFinite(numericState)) {
        document.querySelectorAll(`input[data-entity-control="${CSS.escape(eid)}"]`).forEach((input) => {
            input.value = String(numericState);
        });
    }
    // Update toggle switches
    const toggleSelector = `.app-toggle-switch[data-entity-toggle="${CSS.escape(eid)}"], .app-toggle-switch[onclick*="${CSS.escape(eid)}"]`;
    document.querySelectorAll(toggleSelector).forEach((btn) => {
        const lower = String(d.state || '').toLowerCase();
        const isOn = lower === 'on' || lower === 'open' || lower === 'unlocked' || lower === 'playing' || lower === 'heat' || lower === 'cool' || lower === 'home';
        btn.dataset.on = isOn ? 'true' : 'false';
        btn.setAttribute('aria-checked', isOn ? 'true' : 'false');
        const card = btn.closest('.hyve-dashboard-card');
        if (card && card.dataset.entityId === eid) {
            card.dataset.on = isOn ? 'true' : 'false';
            const stateEl = card.querySelector('.hyve-dashboard-card__state');
            if (stateEl) stateEl.textContent = stateText;
        }
        // Rewrite onclick verb
        const cur = btn.getAttribute('onclick') || '';
        btn.setAttribute('onclick', cur.replace(/'(turn_on|turn_off)'/, `'${isOn ? 'turn_off' : 'turn_on'}'`)
                                       .replace(/"(turn_on|turn_off)"/, `"${isOn ? 'turn_off' : 'turn_on'}"`));
    });
});
