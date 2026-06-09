/**
 * Dashboard widget toggle — card click/keyboard and optimistic entity state.
 */

import { apiCall } from '../api.js';
import { showToast } from '../utils.js';
import { dashDebug } from './debug.js';
import {
    DASHBOARD_OPTIMISTIC_GUARD_MS,
    DASHBOARD_PENDING_VISUAL_MS,
} from './constants.js';
import { dashApiError, stateOn } from './helpers.js';
import {
    deleteOptimisticGuard,
    deletePendingControl,
    getPendingControl,
    setOptimisticGuard,
    setPendingControl,
} from './control_state.js';
import type { DashboardWidget, DashboardWidgetToggleDeps, DashboardPanel } from '../types/dashboard.js';

let _deps: DashboardWidgetToggleDeps | null = null;

function deps(): DashboardWidgetToggleDeps {
    if (!_deps) throw new Error('Dashboard widget toggle not initialized');
    return _deps;
}

export function initDashboardWidgetToggle(depsIn: DashboardWidgetToggleDeps) {
    _deps = depsIn;
}

interface EntitySnapshotEntry {
    item: DashboardWidget;
    state?: string | number | null;
    attributes?: Record<string, unknown>;
    available?: boolean;
    availableEntity?: boolean;
}

function nestedInteractiveTarget(event: Event): Element | null {
    const target = event?.target as Element | null;
    if (!target?.closest) return null;
    const interactive = target.closest('button, a, input, select, textarea, label, [role="button"]');
    if (!interactive) return null;
    if (interactive.getAttribute?.('data-dash-action') === 'cardActivate') return null;
    const current = event?.currentTarget as Element | null;
    if (current && interactive === current) return null;
    return interactive;
}

function togglePreviewCard(event: Event) {
    if (nestedInteractiveTarget(event)) return;
    const card = (event?.currentTarget || (event?.target as Element | null)?.closest?.('.hyve-dashboard-card')) as HTMLElement | null;
    if (!card) return;
    const nextOn = card.getAttribute('data-on') !== 'true';
    card.setAttribute('data-on', nextOn ? 'true' : 'false');
    card.setAttribute('data-preview-pressed', 'true');
    const toggle = card.querySelector('.app-toggle-switch');
    if (toggle) toggle.setAttribute('data-on', nextOn ? 'true' : 'false');
    window.setTimeout(() => card.removeAttribute('data-preview-pressed'), 180);
}

export function handleDashboardCardClick(event: Event, widgetId: string) {
    const d = deps();
    dashDebug('card.click', { widgetId, target: (event?.target as Element | null)?.tagName, type: event?.type });
    if (widgetId === '__preview__') {
        togglePreviewCard(event);
        return;
    }
    if (d.getEditMode()) { dashDebug('card.skip', 'editMode'); return; }
    const nested = nestedInteractiveTarget(event);
    if (nested) { dashDebug('card.skip', { reason: 'nested', el: nested.tagName, role: nested.getAttribute?.('role') }); return; }
    if (d.controlPending(widgetId)) { dashDebug('card.skip', 'pending'); return; }
    toggleDashboardWidget(widgetId);
}

export function handleDashboardCardKeydown(event: KeyboardEvent, widgetId: string) {
    if (event?.key !== 'Enter' && event?.key !== ' ') return;
    event.preventDefault();
    handleDashboardCardClick(event, widgetId);
}

export function snapshotDashboardEntityState(entityId: string): EntitySnapshotEntry[] {
    const d = deps();
    const cache = d.getCache();
    const target = String(entityId || '');
    const snapshot: EntitySnapshotEntry[] = [];
    if (!target) return snapshot;
    const seen = new Set<DashboardWidget>();
    const remember = (item: DashboardWidget | null | undefined) => {
        if (!item || item.entity_id !== target || seen.has(item)) return;
        seen.add(item);
        snapshot.push({ item, state: item.current_state, attributes: item.attributes, available: item.available !== false });
    };
    const rememberWidget = (widget: DashboardWidget | null | undefined) => {
        remember(widget);
        if (Array.isArray(widget?.entities)) widget.entities.forEach(remember);
    };
    (cache.widgets || []).forEach(rememberWidget);
    (cache.panels || []).forEach(panel => (panel?.widgets || []).forEach(rememberWidget));
    (cache.pages || []).forEach((page) => {
        const pageWidgets = page?.widgets as DashboardWidget[] | undefined;
        const pagePanels = page?.panels as DashboardPanel[] | undefined;
        (pageWidgets || []).forEach(rememberWidget);
        (pagePanels || []).forEach(panel => (panel?.widgets || []).forEach(rememberWidget));
    });
    (cache.available_entities || []).forEach(item => {
        if (item?.entity_id === target && !seen.has(item as unknown as DashboardWidget)) {
            seen.add(item as unknown as DashboardWidget);
            snapshot.push({
                item: item as unknown as DashboardWidget,
                state: item.state,
                attributes: item.attributes,
                available: true,
                availableEntity: true,
            });
        }
    });
    return snapshot;
}

export function restoreDashboardEntitySnapshot(snapshot: EntitySnapshotEntry[] | null | undefined) {
    (snapshot || []).forEach(entry => {
        if (!entry?.item) return;
        if (entry.availableEntity) {
            (entry.item as DashboardWidget & { state?: string | number | null }).state = entry.state;
        } else {
            entry.item.current_state = entry.state;
        }
        entry.item.attributes = entry.attributes;
        entry.item.available = entry.available;
    });
}

export function patchDashboardEntityState(
    entityId: string,
    state: string | number | null,
    attributesPatch: Record<string, unknown> | null = null,
) {
    const d = deps();
    const cache = d.getCache();
    const target = String(entityId || '');
    if (!target) return;
    const patchWidget = (widget: DashboardWidget | null | undefined) => {
        if (!widget) return;
        if (widget.entity_id === target) {
            widget.current_state = state;
            if (attributesPatch) widget.attributes = { ...(widget.attributes || {}), ...attributesPatch };
        }
        if (Array.isArray(widget.entities)) {
            widget.entities.forEach(item => {
                if (item?.entity_id !== target) return;
                item.current_state = state;
                if (attributesPatch) item.attributes = { ...(item.attributes || {}), ...attributesPatch };
            });
        }
    };
    (cache.widgets || []).forEach(patchWidget);
    (cache.panels || []).forEach(panel => (panel?.widgets || []).forEach(patchWidget));
    (cache.pages || []).forEach((page) => {
        const pageWidgets = page?.widgets as DashboardWidget[] | undefined;
        const pagePanels = page?.panels as DashboardPanel[] | undefined;
        (pageWidgets || []).forEach(patchWidget);
        (pagePanels || []).forEach(panel => (panel?.widgets || []).forEach(patchWidget));
    });
    (cache.available_entities || []).forEach(item => {
        if (item?.entity_id !== target) return;
        item.state = state;
        if (attributesPatch) item.attributes = { ...(item.attributes || {}), ...attributesPatch };
    });
}

export async function toggleDashboardWidget(widgetId: string, btn?: HTMLButtonElement | null) {
    const d = deps();
    const cache = d.getCache();
    const widget = d.findWidget(widgetId);
    if (!widget) {
        const topIds = (Array.isArray(cache.widgets) ? cache.widgets : []).map(w => w?.id).slice(0, 8);
        const panelInfo = (Array.isArray(cache.panels) ? cache.panels : []).map(p => ({ id: p?.id, n: (p?.widgets || []).length, ids: (p?.widgets || []).map(w => w?.id).slice(0, 4) }));
        const pageInfo = (Array.isArray(cache.pages) ? cache.pages : []).map(p => ({ id: p?.id, panels: Array.isArray(p?.panels) ? p.panels.length : 0, widgets: Array.isArray(p?.widgets) ? p.widgets.length : 0 }));
        dashDebug('toggle.skip', { widgetId, reason: 'widget-not-found', currentPage: d.getCurrentPageId(), cachePage: cache.page_id, topCount: topIds.length, topIds, panels: panelInfo, pages: pageInfo });
        return;
    }
    if (d.controlPending(widgetId)) { dashDebug('toggle.skip', { widgetId, reason: 'pending' }); return; }
    dashDebug('toggle.start', { widgetId, entity: widget.entity_id, current: widget.current_state });

    const snapshot = snapshotDashboardEntityState(widget.entity_id || '');
    const current = String(widget.current_state || '').toLowerCase();
    const nextState = stateOn(current) ? 'off' : 'on';
    const action = d.dashboardIntentAction(widget, nextState);
    setPendingControl(String(widgetId), {
        widgetId: String(widgetId),
        entityId: String(widget.entity_id || ''),
        nextState,
        action,
        startedAt: Date.now(),
    });
    patchDashboardEntityState(widget.entity_id || '', nextState);
    if (!d.tryFastPathForEntities([widget.entity_id || ''])) d.renderDashboard();
    setTimeout(() => {
        const pending = getPendingControl(String(widgetId));
        if (pending && pending.nextState === nextState) {
            if (!d.tryFastPathForEntities([widget.entity_id || ''])) d.renderDashboard();
        }
    }, DASHBOARD_PENDING_VISUAL_MS + 40);

    if (btn) btn.disabled = true;
    try {
        const activePageId = d.getActivePageId() || '';
        const pageQS = activePageId ? `?page_id=${encodeURIComponent(activePageId)}` : '';
        const url = `/api/dashboard/widgets/${encodeURIComponent(widgetId)}/toggle${pageQS}`;
        dashDebug('toggle.req', { url, next: nextState, action });
        const res = await apiCall(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ desired_state: nextState, action: action || 'toggle' }),
        });
        dashDebug('toggle.res', { status: res.status });
        if (!res.ok) {
            const err = await res.json().catch(() => ({})) as { detail?: unknown };
            throw new Error(dashApiError(err.detail, 'dashboard.toggle_failed'));
        }
        deletePendingControl(String(widgetId));
        setOptimisticGuard(String(widget.entity_id || ''), {
            state: nextState,
            until: Date.now() + DASHBOARD_OPTIMISTIC_GUARD_MS,
        });
        if (!d.tryFastPathForEntities([widget.entity_id || ''])) d.renderDashboard();
    } catch (e) {
        dashDebug('toggle.err', { widgetId, msg: String(e instanceof Error ? e.message : e) });
        deletePendingControl(String(widgetId));
        deleteOptimisticGuard(String(widget.entity_id || ''));
        restoreDashboardEntitySnapshot(snapshot);
        if (!d.tryFastPathForEntities([widget.entity_id || ''])) d.renderDashboard();
        showToast(e instanceof Error ? e.message : d.t('dashboard.toggle_failed'), 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}
