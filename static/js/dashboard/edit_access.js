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
    const ids = [
        'dashboard-menu-button',
        'dashboard-layout-toggle',
        'dashboard-hide-unavailable',
    ];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('hidden', !canEdit);
        const label = el.closest('label');
        if (label) label.classList.toggle('hidden', !canEdit);
    });
    document.querySelectorAll(
        '#dashboard-more-menu [data-dashboard-admin-only="true"], .dashboard-page-nav__add'
    ).forEach((el) => el.classList.toggle('hidden', !canEdit));
    if (!canEdit) {
        document.getElementById('dashboard-edit-banner')?.classList.add('hidden');
        document.documentElement.removeAttribute('data-dashboard-editing');
    }
}

export function requireDashboardEditAccess() {
    if (!canEditDashboard()) return false;
    return true;
}
