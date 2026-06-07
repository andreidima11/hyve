/**
 * Hyveview host shim.
 *
 * Some helpers (icon resolution, HTML escape, trend cache, optional
 * sparkline enhancement) live in the legacy dashboard module. Importing
 * them directly from card files would create a circular dependency with
 * `static/js/dashboard.js` (which imports the cards to register them).
 *
 * Instead, the dashboard calls `setHost({...})` once at module init time
 * to publish the helpers it owns. Cards then read them via `host.fn(...)`.
 *
 * Cards must tolerate `host.fn` being missing (e.g. when used outside the
 * dashboard, in tests, etc.) by falling back to a sane default.
 */

const _host = {
  // Returns FA/MDI class string for a generic widget icon spec or fallback.
  iconClass: (spec) => String(spec || ''),
  // Custom icon from widget.icon or widget.config.icon.
  widgetIcon: (_widget) => '',
  // Returns FA icon class string for an entity domain (sensor → thermometer, etc.)
  entityIcon: (_domain) => 'fas fa-circle',
  // HTML attribute escape.
  escape: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  // Optional callback to re-run sparkline enhancement on a DOM subtree.
  enhanceSparklinesIn: (_root) => {},
  // Optional trend cache (entity_id → { value, ts }). Cards mutate it.
  trendCache: new Map(),
  // Boolean test for "on-like" entity states (on/open/playing/...).
  stateOn: (_state) => false,
  // FA icon class for an entity domain in a given on/off state.
  entityIconForState: (_domain, _on) => 'fas fa-circle',
  // Whether a given widget id is currently visually pending (post-click,
  // before the controller has confirmed the state change).
  controlVisuallyPending: (_widgetId) => false,
  // Weather helpers (used by weather-simple / weather-rich cards).
  weatherIcon: (_cond, _isNight) => 'fas fa-cloud',
  weatherVariant: (_cond) => 'clear',
  weatherIsNight: (_attrs) => false,
};

/**
 * Title shown on a dashboard card.
 * When `title` is present on the widget (including explicitly cleared to ""),
 * that value wins. Otherwise fall back to entity_name / entity_id.
 */
export function widgetTitle(widget, fallbacks = {}) {
  const w = widget || {};
  if (Object.prototype.hasOwnProperty.call(w, 'title')) {
    return String(w.title ?? '');
  }
  const { entityName = '', entityId = '' } = fallbacks;
  return String(w.entity_name || entityName || w.entity_id || entityId || '');
}

export function setHost(partial) {
  if (!partial || typeof partial !== 'object') return;
  for (const [k, v] of Object.entries(partial)) {
    if (v !== undefined) _host[k] = v;
  }
}

export const host = new Proxy({}, {
  get(_t, prop) { return _host[prop]; },
});
