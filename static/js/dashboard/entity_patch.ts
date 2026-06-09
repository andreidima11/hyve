/** Apply WS entity diffs to dashboard cache + Hyveview fast-path patching. */

import { fusionSolarWidgetEntityIds } from '/static/hyveview/cards/fusion_solar/card.js';
import { entityIdVariants, findEntityById, updatesGetWithAliases, updatesHasWithAliases } from '../entity_aliases.js';
import { patchRegistryCardStates } from './card_registry.js';
import { widgetArticleEl } from './cards/updates.js';
import { buildCardRenderCtx } from './widget_cards.js';
import type { DashboardEntityPatcherDeps, DashboardWidget } from '../types/dashboard.js';

interface EntityStateSnapshot {
    entity_id: string;
    state: string | number | null;
    attributes: Record<string, unknown>;
    unit: string;
    available: boolean;
}

export interface DashboardLiveEntityUpdate {
    entity_id: string;
    state?: string | number | null;
    attributes?: Record<string, unknown>;
    unit?: string;
    available?: boolean;
    current_state?: string | number | null;
}

interface EntityLiveUpdate extends DashboardLiveEntityUpdate {}

interface HyveviewStateElement extends Element {
    setState?: (snap: EntityStateSnapshot) => void;
}

function entityStateValue(value: unknown): string | number | null {
    if (value == null) return null;
    if (typeof value === 'string' || typeof value === 'number') return value;
    return 'unknown';
}

export function createDashboardEntityPatcher(deps: DashboardEntityPatcherDeps) {
    const {
        HVBridge,
        getCache,
        shouldHoldOptimisticState,
        pendingForEntity,
        clearPendingControl,
        climateConfiguredIds,
        cameraWidgetEntities,
        widgetRenderer,
        widgetById,
        renderDashboard,
    } = deps;

    function widgetEntityIds(widget: DashboardWidget | null | undefined): string[] {
        if (!widget) return [];
        const ids = new Set<string>();
        const add = (raw: unknown) => {
            const id = typeof raw === 'string' ? raw : (raw as { entity_id?: string })?.entity_id;
            if (id) ids.add(String(id));
        };
        add(widget.entity_id);
        climateConfiguredIds(widget).forEach((id) => ids.add(id));
        cameraWidgetEntities(widget).forEach((e) => ids.add(e.entity_id));
        if (widgetRenderer(widget) === 'fusion_solar') {
            fusionSolarWidgetEntityIds(widget).forEach((id: string) => ids.add(id));
        }
        if (Array.isArray(widget.entities)) widget.entities.forEach(add);
        const cfg = widget?.config && typeof widget.config === 'object'
            ? widget.config as Record<string, unknown>
            : {};
        if (Array.isArray(cfg.entities)) cfg.entities.forEach(add);
        if (Array.isArray(cfg.entity_ids)) cfg.entity_ids.forEach(add);
        if (Array.isArray(cfg.power_entities)) cfg.power_entities.forEach(add);
        ['entity_load', 'entity_grid', 'entity_daily', 'entity_monthly', 'entity_yearly',
            'entity_grid_export', 'entity_grid_import', 'entity_feed_in', 'entity_consumption']
            .forEach((k) => add(cfg[k]));
        return Array.from(ids);
    }

    function entitySnapshot(entityId: string, widget: DashboardWidget | null | undefined): EntityStateSnapshot | null {
        const id = String(entityId || '').trim();
        if (!id) return null;
        const cache = getCache();
        const fromChild = Array.isArray(widget?.entities)
            ? widget.entities.find((e) => e?.entity_id === id)
            : null;
        if (fromChild) {
            return {
                entity_id: id,
                state: entityStateValue(fromChild.current_state ?? fromChild.state ?? 'unknown'),
                attributes: fromChild.attributes || {},
                unit: String(fromChild.unit || ''),
                available: fromChild.available !== false,
            };
        }
        const fromCache = findEntityById(cache.available_entities, id);
        if (fromCache) {
            return {
                entity_id: id,
                state: fromCache.state ?? 'unknown',
                attributes: fromCache.attributes || {},
                unit: fromCache.unit || '',
                available: fromCache.available !== false,
            };
        }
        if (widget?.entity_id === id && widget.current_state != null) {
            return {
                entity_id: id,
                state: widget.current_state,
                attributes: widget.attributes || {},
                unit: String(widget.unit || ''),
                available: widget.available !== false,
            };
        }
        return null;
    }

    function bootstrapHyveviewCardStates(el: Element, widget: unknown) {
        const stateEl = el as HyveviewStateElement;
        const w = widget as DashboardWidget;
        if (!stateEl || typeof stateEl.setState !== 'function' || !w) return;
        for (const entityId of widgetEntityIds(w)) {
            const snap = entitySnapshot(entityId, w);
            if (snap) {
                try { stateEl.setState(snap); } catch (_) {}
            }
        }
    }

    function configureHyveviewMounted(root: Element) {
        try {
            HVBridge.configureMounted?.(root, widgetById, {
                bootstrapStates: bootstrapHyveviewCardStates,
            });
        } catch (_) {}
    }

    function widgetSkipsLiveRerender(widget: DashboardWidget | null | undefined) {
        return widgetRenderer(widget as DashboardWidget) === 'camera';
    }

    function tryFastPathForUpdates(updates: Map<string, EntityLiveUpdate>) {
        if (!updates || typeof updates.size !== 'number' || updates.size === 0) return true;
        try {
            const cache = getCache();
            const handled = typeof HVBridge?.patchEntityStates === 'function'
                ? HVBridge.patchEntityStates(updates, widgetById)
                : new Set<string>();
            const touchedWidgetIds = new Set<string>();
            const collectTouched = (widget: DashboardWidget | null | undefined) => {
                if (!widget || !widget.id) return;
                if (widgetEntityIds(widget).some((id) => updatesHasWithAliases(updates, id))) {
                    touchedWidgetIds.add(String(widget.id));
                }
            };
            const walkTouched = (list: DashboardWidget[] | null | undefined) => Array.isArray(list) && list.forEach(collectTouched);
            walkTouched(cache.widgets);
            (cache.panels || []).forEach(p => walkTouched(p?.widgets));
            (cache.pages || []).forEach(pg => {
                if (!pg) return;
                walkTouched(pg.widgets as DashboardWidget[] | undefined);
                (pg.panels as Array<{ widgets?: DashboardWidget[] }> | undefined || []).forEach(p => walkTouched(p?.widgets));
            });
            if (touchedWidgetIds.size === 0) return true;

            const registryHandled = patchRegistryCardStates(updates, widgetById, {
                widgetRenderer,
                buildCtx: buildCardRenderCtx,
                widgetEntityIds,
                widgetArticleEl,
                touchedWidgetIds,
            });
            registryHandled.forEach((id) => handled.add(id));

            return Array.from(touchedWidgetIds).every((id) => {
                if (handled.has(id)) return true;
                return widgetSkipsLiveRerender(widgetById(id));
            });
        } catch (_) { return false; }
    }

    function tryFastPathForEntities(entityIds: string | string[] | Set<string> | null | undefined) {
        if (!entityIds) return false;
        const ids = entityIds instanceof Set ? Array.from(entityIds)
            : (Array.isArray(entityIds) ? entityIds : [entityIds]);
        const targets = new Set(ids.map(String).filter(Boolean));
        if (!targets.size) return false;
        const cache = getCache();
        const updates = new Map<string, EntityLiveUpdate>();
        const addFromEntity = (entity: EntityLiveUpdate | DashboardWidget | null | undefined) => {
            if (!entity || !entity.entity_id) return;
            const eid = String(entity.entity_id);
            if (!entityIdVariants(eid).some((variant) => targets.has(variant))) return;
            if (updates.has(eid)) return;
            updates.set(entity.entity_id, {
                entity_id: entity.entity_id,
                state: entityStateValue(entity.current_state ?? entity.state),
                attributes: entity.attributes || {},
                unit: String(entity.unit || ''),
                available: entity.available !== false,
            });
        };
        const walk = (widget: DashboardWidget | null | undefined) => {
            if (!widget) return;
            addFromEntity(widget);
            if (Array.isArray(widget.entities)) widget.entities.forEach(addFromEntity);
        };
        (cache.widgets || []).forEach(walk);
        (cache.panels || []).forEach(p => (p?.widgets || []).forEach(walk));
        (cache.pages || []).forEach(pg => {
            (pg?.widgets as DashboardWidget[] | undefined || []).forEach(walk);
            (pg?.panels as Array<{ widgets?: DashboardWidget[] }> | undefined || []).forEach(p => (p?.widgets || []).forEach(walk));
        });
        targets.forEach(id => {
            if (updates.has(id)) return;
            const item = findEntityById(cache.available_entities, id);
            if (item) updates.set(id, {
                entity_id: id,
                state: item.state,
                attributes: item.attributes || {},
                unit: item.unit || '',
                available: item.available !== false,
            });
        });
        return tryFastPathForUpdates(updates);
    }

    function applyLiveItems(items: EntityLiveUpdate[], isSnapshot = false) {
        const cache = getCache();
        if (!Array.isArray(cache.available_entities)) {
            cache.available_entities = [];
        }
        const idx = new Map<string, number>();
        cache.available_entities.forEach((it, i) => idx.set(it.entity_id, i));

        const updates = new Map<string, EntityLiveUpdate>();
        let touched = false;
        for (const item of items) {
            if (!item || !item.entity_id) continue;
            if (shouldHoldOptimisticState(item.entity_id, item.state)) continue;
            updates.set(item.entity_id, item);
            const pos = idx.get(item.entity_id);
            if (pos == null) {
                cache.available_entities.push({
                    entity_id: item.entity_id,
                    state: item.state,
                    attributes: item.attributes || {},
                    unit: item.unit || '',
                    controllable: false,
                });
                idx.set(item.entity_id, cache.available_entities.length - 1);
            } else {
                const cur = cache.available_entities[pos];
                cur.state = item.state;
                cur.attributes = item.attributes || {};
                if (item.unit) cur.unit = item.unit;
            }
            touched = true;
        }

        if (isSnapshot && items.length) {
            const liveIds = new Set<string>();
            for (const it of items) { if (it?.entity_id) liveIds.add(it.entity_id); }
            const before = cache.available_entities.length;
            const survivors = cache.available_entities.filter(e => liveIds.has(e.entity_id));
            if (survivors.length >= before * 0.2) {
                cache.available_entities = survivors;
            }
        }

        if (touched) {
            const patchWidget = (widget: DashboardWidget | null | undefined) => {
                if (!widget) return;
                const targetIds = widgetEntityIds(widget);
                if (!targetIds.length && widget.entity_id) targetIds.push(widget.entity_id);
                targetIds.forEach(entityId => {
                    const upd = updatesGetWithAliases(updates, entityId);
                    if (!upd) return;
                    const pending = pendingForEntity(entityId);
                    if (pending?.widgetId) {
                        clearPendingControl(pending.widgetId);
                    }
                    if (widget.entity_id === entityId) {
                        widget.current_state = upd.state;
                        widget.attributes = upd.attributes || {};
                        if (upd.unit) widget.unit = upd.unit;
                        widget.available = upd.available !== false;
                    }
                    if (Array.isArray(widget.entities)) {
                        const child = widget.entities.find(item => item?.entity_id === entityId);
                        if (child) {
                            child.current_state = upd.state;
                            child.attributes = upd.attributes || {};
                            if (upd.unit) child.unit = upd.unit;
                            child.available = upd.available !== false;
                        }
                    }
                });
            };
            const walkWidgets = (list: DashboardWidget[] | null | undefined) => {
                if (!Array.isArray(list)) return;
                list.forEach(patchWidget);
            };
            walkWidgets(cache.widgets);
            if (Array.isArray(cache.panels)) {
                cache.panels.forEach(p => walkWidgets(p?.widgets));
            }
            if (Array.isArray(cache.pages)) {
                cache.pages.forEach(pg => {
                    if (!pg) return;
                    walkWidgets(pg.widgets as DashboardWidget[] | undefined);
                    if (Array.isArray(pg.panels)) {
                        (pg.panels as Array<{ widgets?: DashboardWidget[] }>).forEach(p => walkWidgets(p?.widgets));
                    }
                });
            }
            if (!tryFastPathForUpdates(updates)) renderDashboard();
        }
    }

    function removeLiveItems(entityIds: string[]) {
        if (!entityIds.length) return;
        const cache = getCache();
        const set = new Set(entityIds);
        const before = cache.available_entities.length;
        cache.available_entities = cache.available_entities.filter(it => !set.has(it.entity_id));
        if (cache.available_entities.length !== before) renderDashboard();
    }

    return {
        widgetEntityIds,
        entitySnapshot,
        bootstrapHyveviewCardStates,
        configureHyveviewMounted,
        tryFastPathForUpdates,
        tryFastPathForEntities,
        applyLiveItems,
        removeLiveItems,
    };
}
