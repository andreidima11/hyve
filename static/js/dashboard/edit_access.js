/** Dashboard layout editing is admin-only; card toggles stay available to all users. */

export function canEditDashboard() {
    return window.__isAdmin === true;
}

export function applyDashboardEditAccess() {
    const canEdit = canEditDashboard();
    const wrap = document.getElementById('dashboard-header-menu-wrap');
    if (wrap) {
        wrap.classList.toggle('hidden', !canEdit);
        wrap.classList.toggle('flex', canEdit);
    }
    if (!canEdit) {
        document.getElementById('dashboard-edit-banner')?.classList.add('hidden');
        document.documentElement.removeAttribute('data-dashboard-editing');
    }
}

export function requireDashboardEditAccess() {
    if (!canEditDashboard()) return false;
    return true;
}
