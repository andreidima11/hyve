/**
 * Hyveview host shim.
 */
const _host = {
    iconClass: (spec) => String(spec || ''),
    widgetIcon: (_widget) => '',
    entityIcon: (_domain) => 'fas fa-circle',
    escape: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    enhanceSparklinesIn: (_root) => { },
    trendCache: new Map(),
    stateOn: (_state) => false,
    entityIconForState: (_domain, _on) => 'fas fa-circle',
    controlVisuallyPending: (_widgetId) => false,
    weatherIcon: (_cond, _isNight) => 'fas fa-cloud',
    weatherVariant: (_cond) => 'clear',
    weatherIsNight: (_attrs) => false,
};
export function widgetTitle(widget, fallbacks = {}) {
    const w = (widget && typeof widget === 'object' ? widget : {});
    if (Object.prototype.hasOwnProperty.call(w, 'title')) {
        return String(w.title ?? '');
    }
    const { entityName = '', entityId = '' } = fallbacks;
    return String(w.entity_name || entityName || w.entity_id || entityId || '');
}
export function setHost(partial) {
    if (!partial || typeof partial !== 'object')
        return;
    for (const [k, v] of Object.entries(partial)) {
        if (v !== undefined)
            _host[k] = v;
    }
}
export const host = new Proxy({}, {
    get(_t, prop) { return _host[String(prop)]; },
});
