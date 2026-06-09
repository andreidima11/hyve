/** Dashboard layout editing is admin-only; card toggles stay available to all users. */

import { isAdmin } from '../user_context.js';

export function canEditDashboard(): boolean {
    return isAdmin();
}

function _removeLegacyDashboardHeaderControls(): void {
    document.getElementById('dashboard-layout-toggle')?.remove();
    const legacyHide = document.getElementById('dashboard-hide-unavailable');
    if (legacyHide) {
        legacyHide.closest('label')?.remove();
    }
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _removeLegacyDashboardHeaderControls, { once: true });
    } else {
        _removeLegacyDashboardHeaderControls();
    }
}

export function applyDashboardEditAccess(): void {
    _removeLegacyDashboardHeaderControls();
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

export function requireDashboardEditAccess(): boolean {
    return canEditDashboard();
}
