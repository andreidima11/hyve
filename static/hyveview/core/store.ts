/**
 * HyveviewStore — in-memory entity state for Hyveview cards.
 * Live updates are fed by the dashboard live bridge (not a second WebSocket).
 */

/// <reference path="../types/global.d.ts" />

import type {
    EntityChangeCallback,
    EntityStateCallback,
    HyveviewStoreApi,
    UnsubscribeFn,
} from '../types/store.js';
import type { HyveviewEntityState } from '../types/card.js';

const _state = new Map<string, HyveviewEntityState>();
const _subs = new Map<string, Set<EntityStateCallback>>();
const _allSubs = new Set<EntityChangeCallback>();

function _emit(entityId: string, state: HyveviewEntityState | null): void {
    const subs = _subs.get(entityId);
    if (subs) for (const cb of subs) { try { cb(state); } catch (e) { console.error(e); } }
    for (const cb of _allSubs) { try { cb(entityId, state); } catch (e) { console.error(e); } }
}

export function applySnapshot(items: HyveviewEntityState[] | null | undefined): void {
    _state.clear();
    for (const e of items || []) {
        if (e && e.entity_id) _state.set(e.entity_id, e);
    }
    for (const [eid, st] of _state) _emit(eid, st);
}

export function applyDiff(items: HyveviewEntityState[] | null | undefined): void {
    for (const e of items || []) {
        if (!e || !e.entity_id) continue;
        _state.set(e.entity_id, e);
        _emit(e.entity_id, e);
    }
}

export function applyRemoved(ids: string[] | null | undefined): void {
    for (const id of ids || []) {
        _state.delete(id);
        _emit(id, null);
    }
}

export function getState(entityId: string): HyveviewEntityState | null {
    return _state.get(entityId) || null;
}

export function subscribe(entityId: string, cb: EntityStateCallback): UnsubscribeFn {
    if (!_subs.has(entityId)) _subs.set(entityId, new Set());
    _subs.get(entityId)!.add(cb);
    const cur = _state.get(entityId);
    if (cur) queueMicrotask(() => cb(cur));
    return () => {
        const s = _subs.get(entityId);
        if (s) { s.delete(cb); if (!s.size) _subs.delete(entityId); }
    };
}

export function subscribeAll(cb: EntityChangeCallback): UnsubscribeFn {
    _allSubs.add(cb);
    return () => _allSubs.delete(cb);
}

export function listEntities(): HyveviewEntityState[] {
    return [..._state.values()];
}

export function seedEntities(items: HyveviewEntityState[] | null | undefined): void {
    for (const e of items || []) {
        if (!e || !e.entity_id) continue;
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

export const HyveviewStore: HyveviewStoreApi = {
    getState, subscribe, subscribeAll, listEntities, seedEntities,
    applySnapshot, applyDiff, applyRemoved,
};

window.HyveviewStore = HyveviewStore;
