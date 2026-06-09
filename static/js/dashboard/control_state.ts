/**
 * Dashboard optimistic control state — pending toggles and WS guard windows.
 */

import { DASHBOARD_PENDING_VISUAL_MS } from './constants.js';
import type { OptimisticGuardEntry, PendingControlEntry } from '../types/dashboard.js';

const _pendingControls = new Map<string, PendingControlEntry>();
const _optimisticGuards = new Map<string, OptimisticGuardEntry>();

export function controlPending(widgetId: string): boolean {
    return _pendingControls.has(String(widgetId || ''));
}

export function controlVisuallyPending(widgetId: string): boolean {
    const pending = _pendingControls.get(String(widgetId || ''));
    if (!pending) return false;
    return Date.now() - Number(pending.startedAt || 0) <= DASHBOARD_PENDING_VISUAL_MS;
}

export function pendingForEntity(entityId: string): PendingControlEntry | null {
    const target = String(entityId || '');
    if (!target) return null;
    for (const entry of _pendingControls.values()) {
        if (entry && entry.entityId === target) return entry;
    }
    return null;
}

function expectedStateForEntity(entityId: string): string | null {
    const target = String(entityId || '');
    if (!target) return null;
    const pending = pendingForEntity(target);
    if (pending?.nextState != null) return String(pending.nextState);
    const guard = _optimisticGuards.get(target);
    if (!guard) return null;
    if (Date.now() > Number(guard.until || 0)) {
        _optimisticGuards.delete(target);
        return null;
    }
    return String(guard.state);
}

export function shouldHoldOptimisticState(entityId: string, incomingState: unknown): boolean {
    const expected = expectedStateForEntity(entityId);
    if (expected == null) return false;
    const matches = String(incomingState || '').toLowerCase() === expected.toLowerCase();
    if (matches) {
        _optimisticGuards.delete(String(entityId || ''));
        const pending = pendingForEntity(entityId);
        if (pending?.widgetId) _pendingControls.delete(String(pending.widgetId));
        return false;
    }
    return true;
}

export function getPendingControl(widgetId: string): PendingControlEntry | undefined {
    return _pendingControls.get(String(widgetId || ''));
}

export function setPendingControl(widgetId: string, data: PendingControlEntry): void {
    _pendingControls.set(String(widgetId || ''), data);
}

export function deletePendingControl(widgetId: string): void {
    _pendingControls.delete(String(widgetId || ''));
}

export function clearPendingControl(widgetId: string): void {
    deletePendingControl(widgetId);
}

export function setOptimisticGuard(entityId: string, data: OptimisticGuardEntry): void {
    _optimisticGuards.set(String(entityId || ''), data);
}

export function deleteOptimisticGuard(entityId: string): void {
    _optimisticGuards.delete(String(entityId || ''));
}
