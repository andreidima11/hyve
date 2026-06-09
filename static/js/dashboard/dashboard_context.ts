/**
 * Shared dashboard context helpers (active page id, entity lookup, editor renderer).
 */

import { findEntityById } from '../entity_aliases.js';
import { dashboardEditorRenderer, loadDashboardCardCatalog } from './card_catalog.js';
import { findWidget } from './widget_store.js';
import { widgetRenderer } from './widget_meta.js';
import type { DashboardContextDeps } from '../types/dashboard.js';
import type { HyveEntity } from '../types/entity.js';

let _deps: DashboardContextDeps | null = null;

function deps(): DashboardContextDeps {
    if (!_deps) throw new Error('Dashboard context not initialized');
    return _deps;
}

export function initDashboardContext(depsIn: DashboardContextDeps): void {
    _deps = depsIn;
}

export function activeDashboardPageId(): string {
    const d = deps();
    const cache = d.getCache();
    return d.getCurrentPageId() || cache.current_page_id || cache.page_id || '';
}

export function dashboardAvailableEntity(entityId: string): HyveEntity | null {
    return findEntityById(deps().getCache().available_entities, entityId);
}

export function dashboardEditorRendererForType(type: string): string {
    const d = deps();
    const editorId = d.getCurrentEditorId();
    const editingWidget = editorId ? findWidget(editorId) : null;
    const editingRenderer = editingWidget ? widgetRenderer(editingWidget) : '';
    return dashboardEditorRenderer(type, { editingRenderer });
}

export function fetchDashboardCardCatalog(force = false): Promise<unknown> {
    return loadDashboardCardCatalog(deps().apiCall, force);
}
