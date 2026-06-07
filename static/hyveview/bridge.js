/**
 * Hyveview ↔ legacy-dashboard bridge.
 *
 * Goal: let new card classes (custom elements) live INSIDE the existing
 * dashboard grid without rewriting drag/click/edit/layout plumbing.
 *
 * Contract:
 *   - The grid's outer `<article class="hyve-dashboard-card ...">` keeps the
 *     existing drag/resize/click hooks (inline onclick, data-clickable, data
 *     attributes for the sortable lib, edit-mode toggles, size class).
 *   - INSIDE that article we mount a custom element `<hv-card-<type>>` that
 *     owns the visual body. Title/value/icon/state markup moves into the
 *     element. The element subscribes to entity state and re-renders only
 *     itself when its entity changes — no more grid-wide innerHTML wipes.
 *
 * The bridge exposes:
 *   - registerCard(type, ElementClass, { tagName?, render? })
 *       Defines `<hv-card-<type>>` as a custom element (idempotent) and
 *       remembers a small adapter so the dashboard can render + configure it.
 *   - isRegistered(type) → boolean
 *   - renderCardOuter(widget, outerHtmlParts) → string
 *       Build the standard `<article>` shell with all legacy attributes,
 *       then place an empty `<hv-card-<type>>` inside (with widget id as
 *       data attribute). Returns full HTML string ready for innerHTML.
 *   - configureMounted(rootElement)
 *       Walk newly mounted cards under `rootElement` and call setConfig
 *       with the corresponding widget object resolved via widgetById.
 *   - patchEntityStates(updatesByEntityId, widgetById)
 *       For each updated entity, call setState() on every mounted card
 *       whose widget references that entity. Returns the set of widget IDs
 *       that were fully handled (so the caller can skip a full re-render
 *       if every touched widget was handled).
 *
 * Cards are expected to extend HyveviewCardBase (see core/card-base.js) and
 * implement at minimum:
 *   - setConfig(widget)   // full widget object from the dashboard cache
 *   - setState(entity)    // {entity_id, state, attributes, unit, ...}
 *
 * The bridge stays intentionally tiny — no schema, no editor, no store. The
 * legacy dashboard already owns auth, layout, drag, click, and the editor
 * modal. We're only swapping the per-card body for live-updateable elements.
 */

const _registry = new Map();           // type → { tagName, ElementClass, opts }
const _GENERIC_RENDERERS = new Set(['button', 'tile', 'switch', 'info', 'scene']);
let _widgetEntityIdsResolver = null;

/** Dashboard registers how to collect all entity ids referenced by a widget. */
export function setWidgetEntityIdsResolver(fn) {
  _widgetEntityIdsResolver = typeof fn === 'function' ? fn : null;
}

function _widgetEntityIds(widget) {
  if (_widgetEntityIdsResolver) {
    try {
      const ids = _widgetEntityIdsResolver(widget);
      if (Array.isArray(ids) && ids.length) return ids;
    } catch (_) { /* fall through */ }
  }
  const ids = [];
  if (widget?.entity_id) ids.push(widget.entity_id);
  if (Array.isArray(widget?.entities)) {
    widget.entities.forEach((e) => { if (e?.entity_id) ids.push(e.entity_id); });
  }
  const cfg = widget?.config && typeof widget.config === 'object' ? widget.config : {};
  if (Array.isArray(cfg.entity_ids)) cfg.entity_ids.forEach((id) => { if (id) ids.push(String(id)); });
  return [...new Set(ids)];
}

/** Card type used for mount + render — dedicated types win over stale generic renderer. */
export function effectiveCardType(widget) {
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

function _safeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function registerCard(type, ElementClass, opts = {}) {
  if (!type || typeof type !== 'string') throw new Error('registerCard: type required');
  if (typeof ElementClass !== 'function') throw new Error('registerCard: ElementClass required');
  const tagName = opts.tagName || `hv-card-${type.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}`;
  // Editor-facing metadata: prefer explicit opts, then static props on the
  // class. Allows one class (e.g. HyveviewTileCard serving 5 types) to ship
  // a base schema/meta that each registration can override per-type.
  const spec = {
    schema: opts.schema || ElementClass.schema || null,
    meta: { ...(ElementClass.meta || {}), ...(opts.meta || {}) },
    getStubConfig: opts.getStubConfig || ElementClass.getStubConfig || null,
    hidden: !!opts.hidden, // hide from card picker (e.g. info/scene aliases)
  };
  if (!customElements.get(tagName)) {
    // Custom Elements registry forbids the same constructor under two tag
    // names. When the same class is used for multiple types (e.g. one
    // TileCard class serves tile/button/switch/scene/info), wrap it in a
    // throwaway subclass so each tag gets a unique constructor.
    let Ctor = ElementClass;
    try { customElements.define(tagName, Ctor); }
    catch (err) {
      if (err && /already been used/.test(String(err.message || err))) {
        Ctor = class extends ElementClass {};
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

export function isRegistered(type) {
  return _registry.has(String(type || ''));
}

/**
 * Build the inner `<hv-card-*>` tag for a widget. Caller wraps it in
 * whatever outer `<article>` it needs.
 */
export function renderCardElement(widget) {
  const type = widget && effectiveCardType(widget);
  const entry = _registry.get(type);
  if (!entry) return '';
  const wid = _safeAttr(widget?.id || '');
  // Use display:contents so the element doesn't impose its own layout box;
  // the existing CSS for `.hyve-dashboard-card` and its children continues
  // to control sizing, padding, and grid placement.
  return `<${entry.tagName} class="hv-card-mount" data-hv-widget-id="${wid}" style="display:contents"></${entry.tagName}>`;
}

/**
 * Walk all `[data-hv-widget-id]` mounts under `root` and call setConfig
 * with the resolved widget object. `widgetById` is a `(id) → widget` lookup
 * provided by the dashboard (it owns the cache).
 */
export function configureMounted(root, widgetById, { bootstrapStates } = {}) {
  if (!root || typeof widgetById !== 'function') return;
  const nodes = root.querySelectorAll('[data-hv-widget-id]');
  nodes.forEach(el => {
    try {
      const wid = el.dataset.hvWidgetId;
      const widget = widgetById(wid);
      if (!widget) return;
      if (el.__hvWidget !== widget) {
        el.__hvWidget = widget;
        if (typeof el.setConfig === 'function') {
          const cfg = widget.config && typeof widget.config === 'object' ? widget.config : {};
          const merged = { ...widget };
          if (!merged.icon && cfg.icon) merged.icon = cfg.icon;
          el.setConfig(merged);
        }
      }
      if (typeof bootstrapStates === 'function') bootstrapStates(el, widget);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[hyveview-bridge] configure failed', e);
    }
  });
}

/**
 * Fast-path state patching. For each updated entity, find every mounted
 * card whose widget targets that entity and call setState(entity).
 *
 * Returns a Set of widget IDs that were handled, so the dashboard can
 * decide whether a full grid re-render is still needed (e.g. for widgets
 * of legacy/non-registered types touched by the same diff).
 */
export function patchEntityStates(updatesByEntityId, widgetById) {
  const handled = new Set();
  if (!updatesByEntityId || updatesByEntityId.size === 0) return handled;
  if (typeof widgetById !== 'function') return handled;
  const nodes = document.querySelectorAll('[data-hv-widget-id]');
  nodes.forEach(el => {
    const wid = el.dataset.hvWidgetId;
    const widget = widgetById(wid);
    if (!widget) return;
    let touched = false;
    for (const id of _widgetEntityIds(widget)) {
      const upd = updatesByEntityId.get(id);
      if (!upd) continue;
      try { if (typeof el.setState === 'function') el.setState(upd); } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[hyveview-bridge] setState failed', e);
      }
      touched = true;
    }
    if (touched) handled.add(wid);
  });
  return handled;
}

/**
 * Convenience: list of all registered card types (for picker / debug).
 */
export function registeredTypes() {
  return Array.from(_registry.keys());
}

/**
 * Editor-facing spec for a single registered type. Returns:
 *   { type, tagName, schema, meta: { name, description, icon }, getStubConfig }
 * or null if the type isn't registered.
 */
export function getCardSpec(type) {
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
  };
}

/**
 * Editor-facing list of registered cards (visible in the picker). Hidden
 * aliases (e.g. an `info` registration that should not be user-facing) are
 * filtered out unless `includeHidden` is true.
 */
export function listCards({ includeHidden = false } = {}) {
  const out = [];
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
