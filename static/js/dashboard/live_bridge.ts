/**
 * Dashboard live entity stack — lazy entity patcher + WebSocket transport.
 */

import { apiCall } from '../api.js';
import { dashDebug, DASH_DEBUG_ENABLED } from './debug.js';
import { createDashboardEntityPatcher, type DashboardLiveEntityUpdate } from './entity_patch.js';
import { createDashboardLiveWs } from './live_ws.js';
import { pendingForEntity, shouldHoldOptimisticState, clearPendingControl } from './control_state.js';
import type { DashboardLiveBridgeDeps, DashboardWidget } from '../types/dashboard.js';

let _deps: DashboardLiveBridgeDeps | null = null;
/** @type {ReturnType<typeof createDashboardEntityPatcher> | null} */
let _entityPatcher: ReturnType<typeof createDashboardEntityPatcher> | null = null;
/** @type {ReturnType<typeof createDashboardLiveWs> | null} */
let _dashboardLive: ReturnType<typeof createDashboardLiveWs> | null = null;

function deps(): DashboardLiveBridgeDeps {
    if (!_deps) throw new Error('Dashboard live bridge not initialized');
    return _deps;
}

export function initDashboardLiveBridge(depsIn: DashboardLiveBridgeDeps): void {
    _deps = depsIn;
}

function ensureEntityLive() {
    if (_entityPatcher && _dashboardLive) {
        return { patcher: _entityPatcher, live: _dashboardLive };
    }
    const d = deps();
    _entityPatcher = createDashboardEntityPatcher({
        HVBridge: d.HVBridge,
        getCache: d.getCache,
        shouldHoldOptimisticState,
        pendingForEntity,
        clearPendingControl,
        climateConfiguredIds: d.climateConfiguredIds,
        cameraWidgetEntities: d.cameraWidgetEntities,
        widgetRenderer: d.widgetRenderer,
        widgetById: d.widgetById,
        renderDashboard: d.renderDashboard,
    });
    _dashboardLive = createDashboardLiveWs({
        apiCall,
        dashDebug,
        DASH_DEBUG_ENABLED,
        onLiveItems: (items: unknown[], isSnapshot: boolean) => {
            _entityPatcher!.applyLiveItems(items as DashboardLiveEntityUpdate[], isSnapshot);
        },
        onLiveRemoved: (entityIds: string[]) => _entityPatcher!.removeLiveItems(entityIds),
    });
    _dashboardLive.initTabWatch();
    return { patcher: _entityPatcher, live: _dashboardLive };
}

export function dashboardWidgetEntityIds(widget: unknown): string[] {
    return ensureEntityLive().patcher.widgetEntityIds(widget as DashboardWidget | null | undefined);
}

export function configureHyveviewMounted(root: Element): void {
    ensureEntityLive().patcher.configureHyveviewMounted(root);
}

export function tryFastPathForEntities(entityIds: string[]): boolean {
    return ensureEntityLive().patcher.tryFastPathForEntities(entityIds);
}

export function connectDashboardLive(): void {
    ensureEntityLive().live.connectDashboardLive();
}

export function disconnectDashboardLive(): void {
    _dashboardLive?.disconnectDashboardLive();
}

export function resumeDashboardCameras(): void {
    _dashboardLive?.resumeDashboardCameras();
}
