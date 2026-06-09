// Hyve dashboard — card registry.
//
// Widget renderers live in ./cards/renderers.js and register via
// ./cards/register.js (called once from dashboard.js). Climate cards keep
// their own deps module (climate.js). Use registerCard() to add new types or
// override bundled renderers from custom code.

import type {
    DashboardCardRegistration,
    DashboardCardRegistryPatchOpts,
    DashboardWidget,
} from '../types/dashboard.js';

const _registry = new Map<string, DashboardCardRegistration>();

export function registerCard(spec: Partial<DashboardCardRegistration> | null | undefined): void {
    if (!spec || typeof spec !== 'object') return;
    const type = String(spec.type || '').trim();
    if (!type) return;
    _registry.set(type, {
        type,
        render: typeof spec.render === 'function' ? spec.render : null,
        update: typeof spec.update === 'function' ? spec.update : null,
        defaults: spec.defaults && typeof spec.defaults === 'object' ? spec.defaults : {},
    });
}

export function getCard(type: string): DashboardCardRegistration | null {
    return _registry.get(String(type || '')) || null;
}

export function hasCard(type: string): boolean {
    return _registry.has(String(type || ''));
}

export function listCardTypes(): string[] {
    return Array.from(_registry.keys());
}

export function _debugRegistry(): Array<{ type: string; hasRender: boolean; hasUpdate: boolean }> {
    return Array.from(_registry.entries()).map(([k, v]) => ({
        type: k,
        hasRender: !!v.render,
        hasUpdate: !!v.update,
    }));
}

/**
 * Fast-path patch for legacy card shells registered with an `update` hook.
 * Returns widget IDs that were patched successfully.
 */
export function patchRegistryCardStates(
    updates: Map<string, unknown> | null | undefined,
    widgetById: (id: string) => DashboardWidget | null | undefined,
    opts: DashboardCardRegistryPatchOpts,
): Set<string> {
    const handled = new Set<string>();
    if (!updates || typeof updates.size !== 'number' || updates.size === 0) return handled;
    if (typeof widgetById !== 'function') return handled;

    const {
        widgetRenderer,
        buildCtx,
        widgetEntityIds,
        widgetArticleEl,
    } = opts;
    if (typeof widgetRenderer !== 'function' || typeof buildCtx !== 'function'
        || typeof widgetEntityIds !== 'function' || typeof widgetArticleEl !== 'function') {
        return handled;
    }

    const touchedWidgetIds = opts.touchedWidgetIds instanceof Set
        ? opts.touchedWidgetIds
        : new Set(Array.isArray(opts.touchedWidgetIds) ? opts.touchedWidgetIds : []);

    for (const wid of touchedWidgetIds) {
        const widget = widgetById(wid);
        if (!widget) continue;
        const renderer = widgetRenderer(widget);
        const reg = getCard(renderer);
        if (!reg?.update) continue;
        const articleEl = widgetArticleEl(wid);
        if (!articleEl) continue;
        const entityIds = widgetEntityIds(widget);
        try {
            if (reg.update(widget, updates, articleEl, buildCtx(renderer), entityIds)) {
                handled.add(wid);
            }
        } catch (_) {}
    }
    return handled;
}
