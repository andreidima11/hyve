/**
 * HyveviewStore — in-memory entity state for Hyveview cards.
 * Live updates are fed by the dashboard live bridge (not a second WebSocket).
 */
const _state = new Map();
const _subs = new Map();
const _allSubs = new Set();
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
export function applySnapshot(items) {
    _state.clear();
    for (const e of items || []) {
        if (e && e.entity_id)
            _state.set(e.entity_id, e);
    }
    for (const [eid, st] of _state)
        _emit(eid, st);
}
export function applyDiff(items) {
    for (const e of items || []) {
        if (!e || !e.entity_id)
            continue;
        _state.set(e.entity_id, e);
        _emit(e.entity_id, e);
    }
}
export function applyRemoved(ids) {
    for (const id of ids || []) {
        _state.delete(id);
        _emit(id, null);
    }
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
    getState, subscribe, subscribeAll, listEntities, seedEntities,
    applySnapshot, applyDiff, applyRemoved,
};
window.HyveviewStore = HyveviewStore;
