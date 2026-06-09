/**
 * Navigation callbacks registered once from app.js — avoids circular imports
 * (e.g. dashboard.js ↔ ui.js) while replacing window.switchTab bridges.
 */

import type { DelegatedEventHandlers } from './types/integration.js';

const _handlers: DelegatedEventHandlers = {};

export function registerNavBridge(handlers: DelegatedEventHandlers): void {
    Object.assign(_handlers, handlers || {});
}

export function switchTab(tabId: string, options?: unknown): unknown {
    return _handlers.switchTab?.(tabId, options);
}

export function closeSidebar(): unknown {
    return _handlers.closeSidebar?.();
}

export function toggleSidebar(): unknown {
    return _handlers.toggleSidebar?.();
}

export function isSidebarOpen(): unknown {
    return _handlers.isSidebarOpen?.();
}

export function openConfigSection(section: string): unknown {
    return _handlers.openConfigSection?.(section);
}

export function switchUserProfileTab(tab: string): unknown {
    return _handlers.switchUserProfileTab?.(tab);
}

export function loadUserProfilePage(): unknown {
    return _handlers.loadUserProfilePage?.();
}

export function populateAppTab(): unknown {
    return _handlers.populateAppTab?.();
}

export function loadPlanner(): unknown {
    return _handlers.loadPlanner?.();
}

export function loadApps(): unknown {
    return _handlers.loadApps?.();
}

export function loadScenes(): unknown {
    return _handlers.loadScenes?.();
}

export function loadAreas(): unknown {
    return _handlers.loadAreas?.();
}

export function closeAddonWebUI(): unknown {
    return _handlers.closeAddonWebUI?.();
}

export function loadSessionsList(): unknown {
    return _handlers.loadSessionsList?.();
}

export function initDashboardSidebarNav(): unknown {
    return _handlers.initDashboardSidebarNav?.();
}
