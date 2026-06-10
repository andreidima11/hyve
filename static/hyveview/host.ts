/**
 * Hyveview host shim.
 */

import type { HyveviewHostApi, WidgetTitleFallbacks } from './types/host.js';
import type { HyveviewWidget } from './types/widget.js';

const _host: HyveviewHostApi = {
    iconClass: (spec) => String(spec || ''),
    widgetIcon: (_widget) => '',
    entityIcon: (_domain) => 'fas fa-circle',
    escape: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)),
    enhanceSparklinesIn: (_root) => {},
    trendCache: new Map(),
    stateOn: (_state) => false,
    entityIconForState: (_domain, _on) => 'fas fa-circle',
    controlVisuallyPending: (_widgetId) => false,
    weatherIcon: (_cond, _isNight) => 'fas fa-cloud',
    weatherVariant: (_cond) => 'clear',
    weatherIsNight: (_attrs) => false,
};

export function widgetTitle(
    widget: unknown,
    fallbacks: WidgetTitleFallbacks = {},
): string {
    const w = (widget && typeof widget === 'object' ? widget : {}) as HyveviewWidget;
    if (Object.prototype.hasOwnProperty.call(w, 'title')) {
        return String(w.title ?? '');
    }
    const { entityName = '', entityId = '' } = fallbacks;
    return String(w.entity_name || entityName || w.entity_id || entityId || '');
}

export function setHost(partial: Partial<HyveviewHostApi> | null | undefined): void {
    if (!partial || typeof partial !== 'object') return;
    for (const [k, v] of Object.entries(partial)) {
        if (v !== undefined) (_host as unknown as Record<string, unknown>)[k] = v;
    }
}

export const host = new Proxy({} as HyveviewHostApi, {
    get(_t, prop) { return (_host as unknown as Record<string, unknown>)[String(prop)]; },
});
