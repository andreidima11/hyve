/**
 * HyveviewRegistry — thin editor-facing facade over the bridge.
 *
 * The bridge (`static/hyveview/bridge.js`) is the single runtime registry
 * for card classes (it owns the `customElements.define` + the mount/patch
 * fast-paths used by the dashboard). The schema-driven editor needs the
 * same per-type metadata (schema, picker label, stub factory), so we
 * expose that via this small adapter rather than maintain two registries.
 *
 * The legacy `HyveviewRegistry.define()` API is kept as a passthrough so
 * older modules (the camera card was the first to register here) keep
 * working — it just forwards to the bridge.
 */

import * as HVBridge from '../bridge.js';
import { t } from '../../js/lang/index.js';

export const HyveviewRegistry = {
  /** Passthrough: register a card with the bridge using schema/meta/getStubConfig
   *  from the class statics or the explicit `meta` arg. */
  define(type, ElementClass, meta = {}) {
    if (HVBridge.isRegistered(type)) return;
    HVBridge.registerCard(type, ElementClass, { meta });
  },

  has(type) { return HVBridge.isRegistered(type); },

  /** Returns `{ tag, ElementClass, meta }` shape for back-compat. */
  get(type) {
    const spec = HVBridge.getCardSpec(type);
    if (!spec) return null;
    return { tag: spec.tagName, ElementClass: null, meta: spec.meta };
  },

  create(type) {
    const spec = HVBridge.getCardSpec(type);
    if (!spec) {
      const fallback = document.createElement('div');
      fallback.className = 'hv-card';
      fallback.innerHTML = `<div class="hv-card-body">${t('hyveview.unknown_card_type', { type })}</div>`;
      return fallback;
    }
    return document.createElement(spec.tagName);
  },

  /** Editor picker list. Hides aliases marked `hidden: true` at registration. */
  list() {
    return HVBridge.listCards().map(({ type, meta }) => ({
      type,
      name: meta.name || type,
      description: meta.description || '',
      icon: meta.icon || '',
    }));
  },

  schema(type) {
    return HVBridge.getCardSpec(type)?.schema || null;
  },

  stub(type, entityId) {
    const fn = HVBridge.getCardSpec(type)?.getStubConfig;
    return typeof fn === 'function' ? fn(entityId) : {};
  },
};

window.HyveviewRegistry = HyveviewRegistry;
