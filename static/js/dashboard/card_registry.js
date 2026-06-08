// Hyve dashboard — card registry.
//
// Widget renderers live in ./cards/renderers.js and register via
// ./cards/register.js (called once from dashboard.js). Climate cards keep
// their own deps module (climate.js). Use registerCard() to add new types or
// override bundled renderers from custom code.

const _registry = new Map();

export function registerCard(spec) {
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

export function getCard(type) {
    return _registry.get(String(type || '')) || null;
}

export function hasCard(type) {
    return _registry.has(String(type || ''));
}

export function listCardTypes() {
    return Array.from(_registry.keys());
}

export function _debugRegistry() {
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
export function patchRegistryCardStates(updates, widgetById, opts = {}) {
    const handled = new Set();
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
