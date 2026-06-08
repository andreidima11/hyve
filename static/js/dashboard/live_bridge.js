/**
 * Dashboard live entity stack — lazy entity patcher + WebSocket transport.
 */

import { apiCall } from '../api.js';
import { dashDebug, DASH_DEBUG_ENABLED } from './debug.js';
import { createDashboardEntityPatcher } from './entity_patch.js';
import { createDashboardLiveWs } from './live_ws.js';
import { pendingForEntity, shouldHoldOptimisticState, clearPendingControl } from './control_state.js';

/** @type {object | null} */
let _deps = null;
let _entityPatcher = null;
let _dashboardLive = null;

function deps() {
    if (!_deps) throw new Error('Dashboard live bridge not initialized');
    return _deps;
}

export function initDashboardLiveBridge(depsIn) {
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
        onLiveItems: (items, isSnapshot) => _entityPatcher.applyLiveItems(items, isSnapshot),
        onLiveRemoved: (entityIds) => _entityPatcher.removeLiveItems(entityIds),
    });
    _dashboardLive.initTabWatch();
    return { patcher: _entityPatcher, live: _dashboardLive };
}

export function dashboardWidgetEntityIds(widget) {
    return ensureEntityLive().patcher.widgetEntityIds(widget);
}

export function configureHyveviewMounted(root) {
    ensureEntityLive().patcher.configureHyveviewMounted(root);
}

export function tryFastPathForEntities(entityIds) {
    return ensureEntityLive().patcher.tryFastPathForEntities(entityIds);
}

export function connectDashboardLive() {
    ensureEntityLive().live.connectDashboardLive();
}

export function disconnectDashboardLive() {
    if (_dashboardLive) _dashboardLive.disconnectDashboardLive();
}

export function resumeDashboardCameras() {
    if (_dashboardLive) _dashboardLive.resumeDashboardCameras();
}
