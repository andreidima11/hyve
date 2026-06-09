/**
 * Widget card type resolution, domain helpers, and entity icon specs.
 */
import * as HVBridge from '/static/hyveview/bridge.js';
import { normalizeIconClass } from '../icon_utils.js';
export function effectiveWidgetCardType(widget) {
    return HVBridge.effectiveCardType(widget) || String(widget?.type || widget?.renderer || 'button').toLowerCase();
}
export function isControllableDomain(domain) {
    return ['light', 'switch', 'script', 'input_boolean', 'cover', 'lock', 'vacuum', 'climate', 'media_player', 'fan']
        .includes(String(domain || '').toLowerCase());
}
/** Resolves the effective renderer (card type) for a widget config object. */
export function widgetRenderer(widget) {
    const kind = effectiveWidgetCardType(widget);
    if (kind && kind !== 'button' && kind !== 'tile')
        return kind;
    const eid = String(widget?.entity_id || '');
    if (eid.startsWith('image.'))
        return 'picture';
    return kind || 'button';
}
export function dashboardIntentAction(widget, desiredState) {
    const entityId = String(widget?.entity_id || '');
    const domain = String(widget?.domain || entityId.split('.')[0] || '').toLowerCase();
    const kind = String(widget?.renderer || widget?.type || '').toLowerCase();
    const switchStyle = Boolean(widget?.switch_style || kind === 'switch');
    if (switchStyle
        || ['light', 'switch', 'fan', 'input_boolean', 'cover', 'lock'].includes(domain)
        || ['light', 'switch'].includes(kind)) {
        return desiredState === 'on' ? 'turn_on' : 'turn_off';
    }
    return '';
}
export function isInfoDomain(domain) {
    return ['sensor', 'binary_sensor', 'weather', 'person', 'sun', 'device_tracker', 'update']
        .includes(String(domain || '').toLowerCase());
}
export function entityIcon(domain) {
    switch (String(domain || '').toLowerCase()) {
        case 'light': return 'fas fa-lightbulb';
        case 'switch': return 'fas fa-toggle-on';
        case 'cover': return 'fas fa-blinds';
        case 'climate': return 'fas fa-temperature-half';
        case 'media_player': return 'fas fa-music';
        case 'lock': return 'fas fa-lock';
        case 'sensor': return 'fas fa-gauge-high';
        case 'binary_sensor': return 'fas fa-circle-dot';
        case 'vacuum': return 'fas fa-broom';
        case 'person': return 'fas fa-user';
        case 'camera': return 'fas fa-video';
        default: return 'fas fa-bolt';
    }
}
export function iconClass(spec) {
    const normalized = normalizeIconClass(spec);
    return normalized || 'fas fa-bolt';
}
export function entityIconForState(domain, on) {
    const d = String(domain || '').toLowerCase();
    switch (d) {
        case 'switch': return on ? 'fas fa-toggle-on' : 'fas fa-toggle-off';
        case 'light': return on ? 'fas fa-lightbulb' : 'far fa-lightbulb';
        case 'lock': return on ? 'fas fa-lock' : 'fas fa-lock-open';
        case 'cover': return on ? 'fas fa-blinds-open' : 'fas fa-blinds';
        case 'media_player': return on ? 'fas fa-play' : 'fas fa-music';
        case 'binary_sensor': return on ? 'fas fa-circle-dot' : 'far fa-circle';
        case 'fan': return on ? 'fas fa-fan' : 'far fa-circle';
        default: return entityIcon(domain);
    }
}
