/**
 * Reset dashboard edit UI when leaving the tab or aborting load.
 */

/** @type {object | null} */
let _deps = null;

function deps() {
    if (!_deps) throw new Error('Dashboard editing state not initialized');
    return _deps;
}

export function initDashboardEditingState(depsIn) {
    _deps = depsIn;
}

export function resetDashboardEditingState() {
    const d = deps();
    try { d.abortDashboardPageNavigation(); } catch (_) {}
    try { d.setDashboardRefreshIndicator(false); } catch (_) {}
    d.setEditMode(false);
    document.documentElement.removeAttribute('data-dashboard-editing');
    d.setCurrentEditorId(null);
    d.closeDashboardMenu();
    d.closeDashboardAddModal();
    d.closeDashboardPageModal();
    d.closeDashboardWidgetEditor();
    const grid = document.getElementById('dashboard-grid');
    const view = document.getElementById('view-dashboard');
    const onDashboardTab = !!view && !view.classList.contains('hidden');
    if (grid && onDashboardTab) d.renderDashboard();
}
