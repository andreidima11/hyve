/**
 * Reset dashboard edit UI when leaving the tab or aborting load.
 */

import type { DashboardEditingStateDeps } from '../types/dashboard.js';

let _deps: DashboardEditingStateDeps | null = null;

function deps(): DashboardEditingStateDeps {
    if (!_deps) throw new Error('Dashboard editing state not initialized');
    return _deps;
}

export function initDashboardEditingState(depsIn: DashboardEditingStateDeps): void {
    _deps = depsIn;
}

export function resetDashboardEditingState(): void {
    const d = deps();
    try { d.abortDashboardPageNavigation(); } catch { /* ignore */ }
    try { d.setDashboardRefreshIndicator(false); } catch { /* ignore */ }
    d.setEditMode(false);
    document.documentElement.removeAttribute('data-dashboard-editing');
    d.setCurrentEditorId(null);
    d.closeDashboardMenu();
    d.closeDashboardPageModal();
    const grid = document.getElementById('dashboard-grid');
    const view = document.getElementById('view-dashboard');
    const onDashboardTab = !!view && !view.classList.contains('hidden');
    if (grid && onDashboardTab) d.renderDashboard();
}
