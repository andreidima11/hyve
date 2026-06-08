/**
 * Dashboard optimistic control state — pending toggles and WS guard windows.
 */

import { DASHBOARD_PENDING_VISUAL_MS } from './constants.js';

const _pendingControls = new Map();
const _optimisticGuards = new Map();

export function controlPending(widgetId) {
    return _pendingControls.has(String(widgetId || ''));
}

export function controlVisuallyPending(widgetId) {
    const pending = _pendingControls.get(String(widgetId || ''));
    if (!pending) return false;
    return Date.now() - Number(pending.startedAt || 0) <= DASHBOARD_PENDING_VISUAL_MS;
}

export function pendingForEntity(entityId) {
    const target = String(entityId || '');
    if (!target) return null;
    for (const entry of _pendingControls.values()) {
        if (entry && entry.entityId === target) return entry;
    }
    return null;
}

function expectedStateForEntity(entityId) {
    const target = String(entityId || '');
    if (!target) return null;
    const pending = pendingForEntity(target);
    if (pending?.nextState != null) return String(pending.nextState);
    const guard = _optimisticGuards.get(target);
    if (!guard) return null;
    if (Date.now() > guard.until) {
        _optimisticGuards.delete(target);
        return null;
    }
    return String(guard.state);
}

export function shouldHoldOptimisticState(entityId, incomingState) {
    const expected = expectedStateForEntity(entityId);
    if (expected == null) return false;
    const matches = String(incomingState || '').toLowerCase() === expected.toLowerCase();
    if (matches) {
        _optimisticGuards.delete(String(entityId || ''));
        const pending = pendingForEntity(entityId);
        if (pending) _pendingControls.delete(pending.widgetId);
        return false;
    }
    return true;
}

export function getPendingControl(widgetId) {
    return _pendingControls.get(String(widgetId || ''));
}

export function setPendingControl(widgetId, data) {
    _pendingControls.set(String(widgetId || ''), data);
}

export function deletePendingControl(widgetId) {
    _pendingControls.delete(String(widgetId || ''));
}

export function clearPendingControl(widgetId) {
    deletePendingControl(widgetId);
}

export function setOptimisticGuard(entityId, data) {
    _optimisticGuards.set(String(entityId || ''), data);
}

export function deleteOptimisticGuard(entityId) {
    _optimisticGuards.delete(String(entityId || ''));
}
