/**
 * Reset dashboard edit UI when leaving the tab or aborting load.
 */
let _deps = null;
function deps() {
    if (!_deps)
        throw new Error('Dashboard editing state not initialized');
    return _deps;
}
export function initDashboardEditingState(depsIn) {
    _deps = depsIn;
}
export function resetDashboardEditingState() {
    const d = deps();
    try {
        d.abortDashboardPageNavigation();
    }
    catch { /* ignore */ }
    try {
        d.setDashboardRefreshIndicator(false);
    }
    catch { /* ignore */ }
    d.setEditMode(false);
    document.documentElement.removeAttribute('data-dashboard-editing');
    d.setCurrentEditorId(null);
    d.closeDashboardMenu();
    d.closeDashboardPageModal();
    const grid = document.getElementById('dashboard-grid');
    const view = document.getElementById('view-dashboard');
    const onDashboardTab = !!view && !view.classList.contains('hidden');
    if (grid && onDashboardTab)
        d.renderDashboard();
}
