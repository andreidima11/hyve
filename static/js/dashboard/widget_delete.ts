/**
 * Dashboard widget deletion — API first, section fallback for legacy stores.
 */

import { apiCall } from '../api.js';
import { activeDashboardPageId } from './dashboard_context.js';
import { dashboardPageQuery } from './helpers.js';
import type { DashboardWidgetDeleteDeps } from '../types/dashboard.js';

let _deps: DashboardWidgetDeleteDeps | null = null;

function deps(): DashboardWidgetDeleteDeps {
    if (!_deps) throw new Error('Dashboard widget delete not initialized');
    return _deps;
}

export function initDashboardWidgetDelete(depsIn: DashboardWidgetDeleteDeps): void {
    _deps = depsIn;
}

export async function removeDashboardWidget(widgetId: string): Promise<void> {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    if (!(await d.showConfirm(d.t('dashboard.delete_widget_confirm') || 'Delete this dashboard widget?'))) return;

    const pageQS = dashboardPageQuery(activeDashboardPageId());
    try {
        const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(widgetId)}${pageQS}`, { method: 'DELETE' });
        if (res.ok) {
            await d.loadDashboard();
            d.showToast(d.t('dashboard.widget_deleted') || 'Widget deleted', 'success');
            return;
        }
        if (res.status !== 404) {
            const err = await res.json().catch(() => ({})) as { detail?: string };
            throw new Error(err.detail || (d.t('dashboard.widget_delete_error') || 'Could not delete widget'));
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes(d.t('dashboard.delete_widget_failed'))) {
            d.showToast(message, 'error');
            return;
        }
    }

    try {
        const section = await d.readDashboardSectionFallback();
        const panels = Array.isArray((section as { panels?: unknown[] }).panels)
            ? (section as { panels: unknown[] }).panels
            : [];
        if (panels.length > 0) {
            d.showToast(d.t('dashboard.widget_delete_error') || 'Could not delete widget', 'error');
            return;
        }
        section.widgets = (section.widgets || []).filter((item) => item.id !== widgetId);
        await d.writeDashboardSectionFallback(section);
        await d.loadDashboard();
        d.showToast(d.t('dashboard.widget_deleted') || 'Widget deleted', 'success');
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        d.showToast(message || (d.t('dashboard.widget_delete_error') || 'Could not delete widget'), 'error');
    }
}
