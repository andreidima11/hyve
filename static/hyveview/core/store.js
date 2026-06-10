/**
 * HyveviewStore — single source of entity state for all cards.
 */
const _state = new Map();
const _subs = new Map();
const _allSubs = new Set();
let _ws = null;
let _wsReady = false;
let _reconnectDelay = 1000;
let _reconnectTimer = null;
let _connectingPromise = null;
function _emit(entityId, state) {
    const subs = _subs.get(entityId);
    if (subs)
        for (const cb of subs) {
            try {
                cb(state);
            }
            catch (e) {
                console.error(e);
            }
        }
    for (const cb of _allSubs) {
        try {
            cb(entityId, state);
        }
        catch (e) {
            console.error(e);
        }
    }
}
function _applySnapshot(items) {
    _state.clear();
    for (const e of items || []) {
        if (e && e.entity_id)
            _state.set(e.entity_id, e);
    }
    for (const [eid, st] of _state)
        _emit(eid, st);
}
function _applyDiff(items) {
    for (const e of items || []) {
        if (!e || !e.entity_id)
            continue;
        _state.set(e.entity_id, e);
        _emit(e.entity_id, e);
    }
}
function _applyRemoved(ids) {
    for (const id of ids || []) {
        _state.delete(id);
        _emit(id, null);
    }
}
function _scheduleReconnect() {
    if (_reconnectTimer)
        return;
    _reconnectTimer = setTimeout(() => {
        _reconnectTimer = null;
        _reconnectDelay = Math.min(_reconnectDelay * 1.6, 15000);
        void connect();
    }, _reconnectDelay);
}
function _wsUrl(token) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/api/dashboard/ws/live?token=${encodeURIComponent(token || '')}`;
}
async function _fetchSseToken() {
    const jwt = localStorage.getItem('hyve_token');
    if (!jwt)
        return '';
    try {
        const res = await fetch('/api/token/sse', {
            method: 'POST',
            headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!res.ok)
            return '';
        const data = await res.json();
        return data.sse_token || '';
    }
    catch {
        return '';
    }
}
export async function connect() {
    if (_wsReady)
        return true;
    if (_connectingPromise)
        return _connectingPromise;
    _connectingPromise = (async () => {
        const token = await _fetchSseToken();
        if (!token) {
            console.warn('[hyveview] no auth token; redirecting to /');
            location.href = '/';
            return false;
        }
        return new Promise((resolve) => {
            try {
                _ws = new WebSocket(_wsUrl(token));
            }
            catch (e) {
                console.error('[hyveview] ws open failed', e);
                _scheduleReconnect();
                resolve(false);
                return;
            }
            _ws.addEventListener('open', () => { _wsReady = true; _reconnectDelay = 1000; resolve(true); });
            _ws.addEventListener('message', (ev) => {
                let msg;
                try {
                    msg = JSON.parse(String(ev.data));
                }
                catch {
                    return;
                }
                if (!msg || typeof msg !== 'object')
                    return;
                const t = msg.type;
                if (t === 'snapshot')
                    _applySnapshot(msg.items);
                else if (t === 'diff')
                    _applyDiff(msg.items);
                else if (t === 'removed')
                    _applyRemoved(msg.entity_ids);
            });
            _ws.addEventListener('close', () => { _wsReady = false; _ws = null; _scheduleReconnect(); });
            _ws.addEventListener('error', () => { try {
                _ws && _ws.close();
            }
            catch { /* ignore */ } });
        });
    })();
    const result = await _connectingPromise;
    _connectingPromise = null;
    return result;
}
export function getState(entityId) {
    return _state.get(entityId) || null;
}
export function subscribe(entityId, cb) {
    if (!_subs.has(entityId))
        _subs.set(entityId, new Set());
    _subs.get(entityId).add(cb);
    const cur = _state.get(entityId);
    if (cur)
        queueMicrotask(() => cb(cur));
    return () => {
        const s = _subs.get(entityId);
        if (s) {
            s.delete(cb);
            if (!s.size)
                _subs.delete(entityId);
        }
    };
}
export function subscribeAll(cb) {
    _allSubs.add(cb);
    return () => _allSubs.delete(cb);
}
export function listEntities() {
    return [..._state.values()];
}
export function seedEntities(items) {
    for (const e of items || []) {
        if (!e || !e.entity_id)
            continue;
        if (!_state.has(e.entity_id)) {
            _state.set(e.entity_id, {
                ...e,
                entity_id: e.entity_id,
                friendly_name: e.name || e.friendly_name || e.entity_id,
                state: e.state ?? null,
                attributes: e.attributes || {},
            });
        }
    }
}
export const HyveviewStore = {
    connect, getState, subscribe, subscribeAll, listEntities, seedEntities,
};
window.HyveviewStore = HyveviewStore;
