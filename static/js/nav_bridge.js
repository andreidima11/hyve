/**
 * Navigation callbacks registered once from app.js — avoids circular imports
 * (e.g. dashboard.js ↔ ui.js) while replacing window.switchTab bridges.
 */
const _handlers = {};
export function registerNavBridge(handlers) {
    Object.assign(_handlers, handlers || {});
}
export function switchTab(tabId, options) {
    return _handlers.switchTab?.(tabId, options);
}
export function closeSidebar() {
    return _handlers.closeSidebar?.();
}
export function toggleSidebar() {
    return _handlers.toggleSidebar?.();
}
export function isSidebarOpen() {
    return _handlers.isSidebarOpen?.();
}
export function openConfigSection(section) {
    return _handlers.openConfigSection?.(section);
}
export function switchUserProfileTab(tab) {
    return _handlers.switchUserProfileTab?.(tab);
}
export function loadUserProfilePage() {
    return _handlers.loadUserProfilePage?.();
}
export function populateAppTab() {
    return _handlers.populateAppTab?.();
}
export function loadPlanner() {
    return _handlers.loadPlanner?.();
}
export function loadApps() {
    return _handlers.loadApps?.();
}
export function loadScenes() {
    return _handlers.loadScenes?.();
}
export function loadAreas() {
    return _handlers.loadAreas?.();
}
export function closeAddonWebUI() {
    return _handlers.closeAddonWebUI?.();
}
export function loadSessionsList() {
    return _handlers.loadSessionsList?.();
}
export function initDashboardSidebarNav() {
    return _handlers.initDashboardSidebarNav?.();
}
