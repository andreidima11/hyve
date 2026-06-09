/**
 * Dashboard widget deletion — API first, section fallback for legacy stores.
 */
import { apiCall } from '../api.js';
let _deps = null;
function deps() {
    if (!_deps)
        throw new Error('Dashboard widget delete not initialized');
    return _deps;
}
export function initDashboardWidgetDelete(depsIn) {
    _deps = depsIn;
}
export async function removeDashboardWidget(widgetId) {
    const d = deps();
    if (!d.requireDashboardEditAccess())
        return;
    if (!(await d.showConfirm(d.t('dashboard.delete_widget_confirm') || 'Delete this dashboard widget?')))
        return;
    try {
        const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(widgetId)}`, { method: 'DELETE' });
        if (res.ok) {
            await d.loadDashboard();
            d.showToast(d.t('dashboard.widget_deleted') || 'Widget deleted', 'success');
            return;
        }
        if (res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || (d.t('dashboard.widget_delete_error') || 'Could not delete widget'));
        }
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes(d.t('dashboard.delete_widget_failed'))) {
            d.showToast(message, 'error');
            return;
        }
    }
    try {
        const section = await d.readDashboardSectionFallback();
        section.widgets = (section.widgets || []).filter((item) => item.id !== widgetId);
        await d.writeDashboardSectionFallback(section);
        await d.loadDashboard();
        d.showToast(d.t('dashboard.widget_deleted') || 'Widget deleted', 'success');
    }
    catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        d.showToast(message || (d.t('dashboard.widget_delete_error') || 'Could not delete widget'), 'error');
    }
}
