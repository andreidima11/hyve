/**
 * Dashboard section (panel) deletion.
 */
import { apiCall } from '../api.js';
import { dashApiError } from './helpers.js';
let _deps = null;
function deps() {
    if (!_deps)
        throw new Error('Dashboard panel delete not initialized');
    return _deps;
}
export function initDashboardPanelDelete(depsIn) {
    _deps = depsIn;
}
export async function removeDashboardPanel(panelId) {
    const d = deps();
    if (!d.requireDashboardEditAccess())
        return;
    if (!panelId)
        return;
    const ok = await d.showConfirm(d.t('dashboard.confirm_delete_section') || 'Delete this section and all cards inside it?');
    if (!ok)
        return;
    try {
        const pageId = d.getCurrentPageId();
        const params = pageId ? `?page_id=${encodeURIComponent(pageId)}` : '';
        const res = await apiCall(`/api/dashboard/panels/${encodeURIComponent(panelId)}${params}`, { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError(err.detail, 'dashboard.section_delete_error'));
        }
        await d.refreshAvailableEntities();
        d.renderDashboard();
        d.showToast(d.t('dashboard.section_deleted'), 'success');
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        d.showToast(message || d.t('dashboard.section_delete_error'), 'error');
    }
}
