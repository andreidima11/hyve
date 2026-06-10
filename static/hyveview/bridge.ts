/**
 * Hyveview ↔ legacy-dashboard bridge.
 */

import type {
    HyveviewCardClass,
    HyveviewCardElement,
    HyveviewCardSpecPublic,
    HyveviewEntityState,
    RegisterCardOptions,
} from './types/card.js';
import type { HyveviewRegistryEntry } from './types/card.js';
import type { HyveviewWidget, WidgetByIdFn, WidgetEntityIdsResolver } from './types/widget.js';

const _registry = new Map<string, HyveviewRegistryEntry>();
const _GENERIC_RENDERERS = new Set(['button', 'tile', 'switch', 'info', 'scene']);
let _widgetEntityIdsResolver: WidgetEntityIdsResolver | null = null;

export function setWidgetEntityIdsResolver(fn: WidgetEntityIdsResolver | null): void {
    _widgetEntityIdsResolver = typeof fn === 'function' ? fn : null;
}

function _cardTypeEntityIds(widget: HyveviewWidget | null | undefined): string[] {
    const type = effectiveCardType(widget);
    const entry = _registry.get(type);
    const resolver = entry?.opts?.widgetEntityIds;
    if (typeof resolver !== 'function') return [];
    try {
        const ids = resolver(widget);
        return Array.isArray(ids) ? ids.map((id) => String(id)).filter(Boolean) : [];
    } catch (e) {
        console.error('[hyveview-bridge] widgetEntityIds failed for', type, e);
        return [];
    }
}

export function cardTypeEntityIds(widget: HyveviewWidget | null | undefined): string[] {
    return _cardTypeEntityIds(widget);
}

function _widgetEntityIds(widget: HyveviewWidget | null | undefined): string[] {
    const ids = new Set<string>(_cardTypeEntityIds(widget));
    if (_widgetEntityIdsResolver) {
        try {
            const resolved = _widgetEntityIdsResolver(widget);
            if (Array.isArray(resolved)) {
                resolved.forEach((id) => { if (id) ids.add(String(id)); });
            }
        } catch (e) {
            console.error('[hyveview-bridge] dashboard widgetEntityIds resolver failed', e);
        }
    }
    if (ids.size) return [...ids];
    const fallback: string[] = [];
    if (widget?.entity_id) fallback.push(widget.entity_id);
    if (widget?.unique_id) fallback.push(widget.unique_id);
    if (Array.isArray(widget?.entities)) {
        widget.entities.forEach((e) => {
            if (e?.entity_id) fallback.push(e.entity_id);
            if (e?.unique_id) fallback.push(e.unique_id);
        });
    }
    const cfg = widget?.config && typeof widget.config === 'object' ? widget.config : {};
    if (Array.isArray(cfg.entity_ids)) cfg.entity_ids.forEach((id) => { if (id) fallback.push(String(id)); });
    if (Array.isArray(cfg.entities)) {
        cfg.entities.forEach((e: { entity_id?: string; unique_id?: string }) => {
            if (e?.entity_id) fallback.push(e.entity_id);
            if (e?.unique_id) fallback.push(e.unique_id);
        });
    }
    return [...new Set(fallback)];
}

export function effectiveCardType(widget: HyveviewWidget | null | undefined): string {
    let type = String(widget?.type || '').trim();
    if (type === 'weather_gradient') type = 'weather';
    const rendererRaw = String(widget?.renderer || '').trim();
    const renderer = rendererRaw === 'weather_gradient' ? 'weather' : rendererRaw;
    if (type && _registry.has(type) && (!renderer || _GENERIC_RENDERERS.has(renderer))) {
        return type;
    }
    const candidate = renderer || type;
    if (candidate && _registry.has(candidate)) return candidate;
    return renderer || type || '';
}

function _safeAttr(s: unknown): string {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

export function registerCard(type: string, ElementClass: HyveviewCardClass, opts: RegisterCardOptions = {}): void {
    if (!type || typeof type !== 'string') throw new Error('registerCard: type required');
    if (typeof ElementClass !== 'function') throw new Error('registerCard: ElementClass required');
    const tagName = opts.tagName || `hv-card-${type.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`;
    const spec = {
        schema: opts.schema || ElementClass.schema || null,
        meta: { ...(ElementClass.meta || {}), ...(opts.meta || {}) },
        getStubConfig: opts.getStubConfig || ElementClass.getStubConfig || null,
        hidden: !!opts.hidden,
        shell: opts.shell || ElementClass.shell || null,
    };
    if (!customElements.get(tagName)) {
        let Ctor: HyveviewCardClass = ElementClass;
        try { customElements.define(tagName, Ctor); }
        catch (err) {
            if (err && /already been used/.test(String((err as Error).message || err))) {
                Ctor = class extends (ElementClass as CustomElementConstructor) {} as HyveviewCardClass;
                customElements.define(tagName, Ctor);
            } else {
                throw err;
            }
        }
        _registry.set(type, { tagName, ElementClass: Ctor, opts, spec });
        return;
    }
    _registry.set(type, { tagName, ElementClass, opts, spec });
}

export function isRegistered(type: string): boolean {
    return _registry.has(String(type || ''));
}

export function renderCardElement(widget: HyveviewWidget | null | undefined): string {
    const type = widget ? effectiveCardType(widget) : '';
    const entry = _registry.get(type);
    if (!entry) return '';
    const wid = _safeAttr(widget?.id || '');
    return `<${entry.tagName} class="hv-card-mount" data-hv-widget-id="${wid}" style="display:contents"></${entry.tagName}>`;
}

export function configureMounted(
    root: ParentNode | null | undefined,
    widgetById: WidgetByIdFn,
    { bootstrapStates }: { bootstrapStates?: (el: Element, widget: unknown) => void } = {},
): void {
    if (!root || typeof widgetById !== 'function') return;
    const nodes = root.querySelectorAll('[data-hv-widget-id]');
    nodes.forEach((node) => {
        const el = node as HyveviewCardElement;
        try {
            const wid = el.dataset.hvWidgetId;
            if (!wid) return;
            const widget = widgetById(wid) as HyveviewWidget | null | undefined;
            if (!widget) return;
            if (el.__hvWidget !== widget) {
                el.__hvWidget = widget;
                if (typeof el.setConfig === 'function') {
                    const cfg = widget.config && typeof widget.config === 'object' ? widget.config : {};
                    const merged = { ...widget };
                    if (!merged.icon && cfg.icon) merged.icon = cfg.icon as string;
                    el.setConfig(merged);
                }
            }
            if (typeof bootstrapStates === 'function') bootstrapStates(el, widget);
        } catch (e) {
            console.error('[hyveview-bridge] configure failed', e);
        }
    });
}

export function patchEntityStates(
    updatesByEntityId: Map<string, unknown>,
    widgetById: WidgetByIdFn,
): Set<string> {
    const handled = new Set<string>();
    if (!updatesByEntityId || updatesByEntityId.size === 0) return handled;
    if (typeof widgetById !== 'function') return handled;
    const nodes = document.querySelectorAll('[data-hv-widget-id]');
    nodes.forEach((node) => {
        const el = node as HyveviewCardElement;
        const wid = el.dataset.hvWidgetId;
        if (!wid) return;
        const widget = widgetById(wid) as HyveviewWidget | null | undefined;
        if (!widget) return;
        let touched = false;
        for (const id of _widgetEntityIds(widget)) {
            const upd = updatesByEntityId.get(id);
            if (!upd) continue;
            try { if (typeof el.setState === 'function') el.setState(upd as HyveviewEntityState); } catch (e) {
                console.error('[hyveview-bridge] setState failed', e);
            }
            touched = true;
        }
        if (touched) handled.add(wid);
    });
    return handled;
}

export function registeredTypes(): string[] {
    return Array.from(_registry.keys());
}

export function getCardSpec(type: string): HyveviewCardSpecPublic | null {
    const entry = _registry.get(String(type || ''));
    if (!entry) return null;
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

export function listCards({ includeHidden = false }: { includeHidden?: boolean } = {}): HyveviewCardSpecPublic[] {
    const out: HyveviewCardSpecPublic[] = [];
    for (const [type, entry] of _registry.entries()) {
        if (!includeHidden && entry.spec?.hidden) continue;
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
