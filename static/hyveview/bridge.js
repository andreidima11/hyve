/**
 * Hyveview ↔ legacy-dashboard bridge.
 */
const _registry = new Map();
const _GENERIC_RENDERERS = new Set(['button', 'tile', 'switch', 'info', 'scene']);
let _widgetEntityIdsResolver = null;
export function setWidgetEntityIdsResolver(fn) {
    _widgetEntityIdsResolver = typeof fn === 'function' ? fn : null;
}
function _cardTypeEntityIds(widget) {
    const type = effectiveCardType(widget);
    const entry = _registry.get(type);
    const resolver = entry?.opts?.widgetEntityIds;
    if (typeof resolver !== 'function')
        return [];
    try {
        const ids = resolver(widget);
        return Array.isArray(ids) ? ids.map((id) => String(id)).filter(Boolean) : [];
    }
    catch (e) {
        console.error('[hyveview-bridge] widgetEntityIds failed for', type, e);
        return [];
    }
}
export function cardTypeEntityIds(widget) {
    return _cardTypeEntityIds(widget);
}
function _widgetEntityIds(widget) {
    const ids = new Set(_cardTypeEntityIds(widget));
    if (_widgetEntityIdsResolver) {
        try {
            const resolved = _widgetEntityIdsResolver(widget);
            if (Array.isArray(resolved)) {
                resolved.forEach((id) => { if (id)
                    ids.add(String(id)); });
            }
        }
        catch (e) {
            console.error('[hyveview-bridge] dashboard widgetEntityIds resolver failed', e);
        }
    }
    if (ids.size)
        return [...ids];
    const fallback = [];
    if (widget?.entity_id)
        fallback.push(widget.entity_id);
    if (widget?.unique_id)
        fallback.push(widget.unique_id);
    if (Array.isArray(widget?.entities)) {
        widget.entities.forEach((e) => {
            if (e?.entity_id)
                fallback.push(e.entity_id);
            if (e?.unique_id)
                fallback.push(e.unique_id);
        });
    }
    const cfg = widget?.config && typeof widget.config === 'object' ? widget.config : {};
    if (Array.isArray(cfg.entity_ids))
        cfg.entity_ids.forEach((id) => { if (id)
            fallback.push(String(id)); });
    if (Array.isArray(cfg.entities)) {
        cfg.entities.forEach((e) => {
            if (e?.entity_id)
                fallback.push(e.entity_id);
            if (e?.unique_id)
                fallback.push(e.unique_id);
        });
    }
    return [...new Set(fallback)];
}
export function effectiveCardType(widget) {
    let type = String(widget?.type || '').trim();
    if (type === 'weather_gradient')
        type = 'weather';
    const rendererRaw = String(widget?.renderer || '').trim();
    const renderer = rendererRaw === 'weather_gradient' ? 'weather' : rendererRaw;
    if (type && _registry.has(type) && (!renderer || _GENERIC_RENDERERS.has(renderer))) {
        return type;
    }
    const candidate = renderer || type;
    if (candidate && _registry.has(candidate))
        return candidate;
    return renderer || type || '';
}
function _safeAttr(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
export function registerCard(type, ElementClass, opts = {}) {
    if (!type || typeof type !== 'string')
        throw new Error('registerCard: type required');
    if (typeof ElementClass !== 'function')
        throw new Error('registerCard: ElementClass required');
    const tagName = opts.tagName || `hv-card-${type.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`;
    const spec = {
        schema: opts.schema || ElementClass.schema || null,
        meta: { ...(ElementClass.meta || {}), ...(opts.meta || {}) },
        getStubConfig: opts.getStubConfig || ElementClass.getStubConfig || null,
        hidden: !!opts.hidden,
        shell: opts.shell || ElementClass.shell || null,
    };
    if (!customElements.get(tagName)) {
        let Ctor = ElementClass;
        try {
            customElements.define(tagName, Ctor);
        }
        catch (err) {
            if (err && /already been used/.test(String(err.message || err))) {
                Ctor = class extends ElementClass {
                };
                customElements.define(tagName, Ctor);
            }
            else {
                throw err;
            }
        }
        _registry.set(type, { tagName, ElementClass: Ctor, opts, spec });
        return;
    }
    _registry.set(type, { tagName, ElementClass, opts, spec });
}
export function isRegistered(type) {
    return _registry.has(String(type || ''));
}
export function renderCardElement(widget) {
    const type = widget ? effectiveCardType(widget) : '';
    const entry = _registry.get(type);
    if (!entry)
        return '';
    const wid = _safeAttr(widget?.id || '');
    return `<${entry.tagName} class="hv-card-mount" data-hv-widget-id="${wid}" style="display:contents"></${entry.tagName}>`;
}
export function configureMounted(root, widgetById, { bootstrapStates } = {}) {
    if (!root || typeof widgetById !== 'function')
        return;
    const nodes = root.querySelectorAll('[data-hv-widget-id]');
    nodes.forEach((node) => {
        const el = node;
        try {
            const wid = el.dataset.hvWidgetId;
            if (!wid)
                return;
            const widget = widgetById(wid);
            if (!widget)
                return;
            if (el.__hvWidget !== widget) {
                el.__hvWidget = widget;
                if (typeof el.setConfig === 'function') {
                    const cfg = widget.config && typeof widget.config === 'object' ? widget.config : {};
                    const merged = { ...widget };
                    if (!merged.icon && cfg.icon)
                        merged.icon = cfg.icon;
                    el.setConfig(merged);
                }
            }
            if (typeof bootstrapStates === 'function')
                bootstrapStates(el, widget);
        }
        catch (e) {
            console.error('[hyveview-bridge] configure failed', e);
        }
    });
}
export function patchEntityStates(updatesByEntityId, widgetById) {
    const handled = new Set();
    if (!updatesByEntityId || updatesByEntityId.size === 0)
        return handled;
    if (typeof widgetById !== 'function')
        return handled;
    const nodes = document.querySelectorAll('[data-hv-widget-id]');
    nodes.forEach((node) => {
        const el = node;
        const wid = el.dataset.hvWidgetId;
        if (!wid)
            return;
        const widget = widgetById(wid);
        if (!widget)
            return;
        let touched = false;
        for (const id of _widgetEntityIds(widget)) {
            const upd = updatesByEntityId.get(id);
            if (!upd)
                continue;
            try {
                if (typeof el.setState === 'function')
                    el.setState(upd);
            }
            catch (e) {
                console.error('[hyveview-bridge] setState failed', e);
            }
            touched = true;
        }
        if (touched)
            handled.add(wid);
    });
    return handled;
}
export function registeredTypes() {
    return Array.from(_registry.keys());
}
export function getCardSpec(type) {
    const entry = _registry.get(String(type || ''));
    if (!entry)
        return null;
    const { tagName, spec } = entry;
    return {
        type,
        tagName,
        schema: spec?.schema || null,
        meta: spec?.meta || {},
        getStubConfig: spec?.getStubConfig || null,
        hidden: !!spec?.hidden,
        shell: spec?.shell || null,
    };
}
export function listCards({ includeHidden = false } = {}) {
    const out = [];
    for (const [type, entry] of _registry.entries()) {
        if (!includeHidden && entry.spec?.hidden)
            continue;
        out.push({
            type,
            tagName: entry.tagName,
            schema: entry.spec?.schema || null,
            meta: entry.spec?.meta || {},
            getStubConfig: entry.spec?.getStubConfig || null,
        });
    }
    return out;
}
