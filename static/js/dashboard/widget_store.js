/**
 * Dashboard widget lookup and in-cache reorder persistence.
 */
import { apiCall } from '../api.js';
import { dashApiError } from './helpers.js';
let _deps = null;
let _pendingReorder = null;
function deps() {
    if (!_deps)
        throw new Error('Dashboard widget store not initialized');
    return _deps;
}
export function initDashboardWidgetStore(depsIn) {
    _deps = depsIn;
}
/** Locate a widget list entry across panels, pages, and top-level widgets. */
export function locateDashboardWidget(widgetId) {
    const cache = deps().getCache();
    const panels = Array.isArray(cache.panels) ? cache.panels : [];
    for (let pi = 0; pi < panels.length; pi++) {
        const panel = panels[pi];
        const list = Array.isArray(panel?.widgets) ? panel.widgets : null;
        if (!list)
            continue;
        const idx = list.findIndex((w) => w && w.id === widgetId);
        if (idx >= 0)
            return { container: list, index: idx, panel, panelIndex: pi };
    }
    const top = Array.isArray(cache.widgets) ? cache.widgets : null;
    if (top) {
        const idx = top.findIndex((w) => w && w.id === widgetId);
        if (idx >= 0)
            return { container: top, index: idx };
    }
    const pages = Array.isArray(cache.pages) ? cache.pages : [];
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const page = pages[pageIndex];
        const pageWidgets = Array.isArray(page?.widgets) ? page.widgets : null;
        if (pageWidgets) {
            const idx = pageWidgets.findIndex((w) => w && w.id === widgetId);
            if (idx >= 0)
                return { container: pageWidgets, index: idx, page, pageIndex };
        }
        const pagePanels = Array.isArray(page?.panels) ? page.panels : [];
        for (let panelIndex = 0; panelIndex < pagePanels.length; panelIndex++) {
            const panel = pagePanels[panelIndex];
            const list = Array.isArray(panel?.widgets) ? panel.widgets : null;
            if (!list)
                continue;
            const idx = list.findIndex((w) => w && w.id === widgetId);
            if (idx >= 0)
                return { container: list, index: idx, page, pageIndex, panel, panelIndex };
        }
    }
    return null;
}
export function findWidget(widgetId) {
    const loc = locateDashboardWidget(widgetId);
    return loc ? loc.container[loc.index] : null;
}
/** Alias used by the Hyveview entity patcher (`widgetById`). */
export function dashboardWidgetById(widgetId) {
    return findWidget(widgetId);
}
export function reorderDashboardWidgets(sourceId, targetId) {
    const d = deps();
    if (!sourceId || !targetId || sourceId === targetId)
        return false;
    const src = locateDashboardWidget(sourceId);
    const dst = locateDashboardWidget(targetId);
    if (!src || !dst)
        return false;
    const moved = src.container[src.index];
    if (!moved)
        return false;
    src.container.splice(src.index, 1);
    let insertAt = dst.container === src.container && src.index < dst.index
        ? dst.index - 1
        : dst.index;
    insertAt = Math.max(0, Math.min(insertAt, dst.container.length));
    dst.container.splice(insertAt, 0, moved);
    if (dst.panel && Array.isArray(dst.panel.pages) && dst.panel.pages.length) {
        const targetWidget = dst.container[insertAt + 1] || null;
        const firstPage = dst.panel.pages[0];
        const fallbackPage = firstPage?.id || null;
        if (targetWidget?.page_id)
            moved.page_id = targetWidget.page_id;
        else if (!moved.page_id)
            moved.page_id = fallbackPage;
    }
    const afterIdx = insertAt + 1;
    const beforeWidgetId = afterIdx < dst.container.length
        ? (dst.container[afterIdx]?.id || null)
        : null;
    _pendingReorder = {
        sourceId,
        targetPanelId: dst.panel ? String(dst.panel.id || '') : null,
        targetPageId: moved.page_id ? String(moved.page_id) : null,
        beforeWidgetId,
    };
    d.renderDashboard();
    return true;
}
export async function persistDashboardOrder() {
    const d = deps();
    const pending = _pendingReorder;
    _pendingReorder = null;
    if (!pending)
        return;
    if (pending.targetPanelId) {
        const body = { target_panel_id: pending.targetPanelId };
        if (pending.targetPageId)
            body.target_page_id = pending.targetPageId;
        if (pending.beforeWidgetId)
            body.before_widget_id = pending.beforeWidgetId;
        const pageId = d.getCurrentPageId();
        const url = pageId
            ? `/api/dashboard/widgets/${encodeURIComponent(pending.sourceId)}/relocate?page_id=${encodeURIComponent(pageId)}`
            : `/api/dashboard/widgets/${encodeURIComponent(pending.sourceId)}/relocate`;
        const res = await apiCall(url, { method: 'POST', body });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError(err.detail, 'dashboard.rearrange_widget_failed'));
        }
        return;
    }
    const cache = d.getCache();
    const section = await d.readDashboardSectionFallback();
    const storedWidgets = Array.isArray(section.widgets) ? section.widgets : [];
    const orderedIds = (cache.widgets || []).map((item) => item.id);
    section.widgets = orderedIds
        .map((id) => storedWidgets.find((item) => item.id === id))
        .filter(Boolean);
    await d.writeDashboardSectionFallback(section);
}
