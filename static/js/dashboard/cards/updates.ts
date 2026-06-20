/**
 * Fast-path DOM patches for legacy dashboard card shells (article wrappers).
 * Hyveview inner content is updated via HVBridge.patchEntityStates; these
 * handlers keep outer data-* attributes in sync without a full grid re-render.
 */

import { updatesHasWithAliases } from '../../entity_aliases.js';
import { cardIsClickable } from '../interactions/resolver.js';
import type {
    DashboardCardUpdateContext,
    DashboardWidget,
} from '../../types/dashboard.js';

function widgetArticleEl(widgetId: string): HTMLElement | null {
    const id = String(widgetId || '').trim();
    if (!id) return null;
    return document.querySelector(`[data-dashboard-widget-id="${CSS.escape(id)}"]`);
}

function widgetTouchedByUpdates(
    widget: DashboardWidget | null | undefined,
    updates: Map<string, unknown> | null | undefined,
    entityIds: string[],
): boolean {
    if (!widget || !updates || typeof updates.size !== 'number') return false;
    return entityIds.some((entityId) => updatesHasWithAliases(updates, entityId));
}

export function updateArticleAvailability(
    widget: DashboardWidget,
    updates: Map<string, unknown>,
    articleEl: HTMLElement,
    _ctx: DashboardCardUpdateContext,
    entityIds: string[],
): boolean {
    if (!articleEl || !widgetTouchedByUpdates(widget, updates, entityIds)) return false;
    articleEl.dataset.unavailable = widget.available === false ? 'true' : 'false';
    return true;
}

export function updateTileCardShell(
    widget: DashboardWidget,
    updates: Map<string, unknown>,
    articleEl: HTMLElement,
    ctx: DashboardCardUpdateContext,
    entityIds: string[],
): boolean {
    if (!articleEl || !widgetTouchedByUpdates(widget, updates, entityIds)) return false;

    const editMode = ctx.getEditMode();
    const state = String(widget.current_state || 'unknown');
    const on = ctx.stateOn(state);
    const clickable = cardIsClickable(widget, editMode);

    articleEl.dataset.on = on ? 'true' : 'false';
    articleEl.dataset.pending = ctx.controlVisuallyPending(widget.id) ? 'true' : 'false';
    articleEl.dataset.unavailable = widget.available === false ? 'true' : 'false';
    articleEl.dataset.clickable = clickable ? 'true' : 'false';

    if (clickable) {
        articleEl.setAttribute('role', 'button');
        articleEl.setAttribute('tabindex', '0');
        articleEl.dataset.dashActionKey = 'cardActivate';
        articleEl.dataset.widgetId = String(widget.id);
    } else {
        articleEl.removeAttribute('role');
        articleEl.removeAttribute('tabindex');
        delete articleEl.dataset.dashActionKey;
        delete articleEl.dataset.widgetId;
    }
    return true;
}

export function updateTileCard(
    widget: DashboardWidget,
    updates: Map<string, unknown>,
    articleEl: HTMLElement,
    ctx: DashboardCardUpdateContext,
    entityIds: string[],
): boolean {
    return updateTileCardShell(widget, updates, articleEl, ctx, entityIds);
}

export function updateSensorCard(
    widget: DashboardWidget,
    updates: Map<string, unknown>,
    articleEl: HTMLElement,
    ctx: DashboardCardUpdateContext,
    entityIds: string[],
): boolean {
    return updateArticleAvailability(widget, updates, articleEl, ctx, entityIds);
}

export function updateGaugeCard(
    widget: DashboardWidget,
    updates: Map<string, unknown>,
    articleEl: HTMLElement,
    ctx: DashboardCardUpdateContext,
    entityIds: string[],
): boolean {
    return updateArticleAvailability(widget, updates, articleEl, ctx, entityIds);
}

export function updateLabelCard(
    widget: DashboardWidget,
    updates: Map<string, unknown>,
    articleEl: HTMLElement,
    ctx: DashboardCardUpdateContext,
    entityIds: string[],
): boolean {
    return updateArticleAvailability(widget, updates, articleEl, ctx, entityIds);
}

export { widgetArticleEl };
