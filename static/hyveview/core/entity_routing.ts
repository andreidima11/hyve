/**
 * Resolve universal "entity" card preset to a concrete Hyveview renderer.
 */

import type { HyveviewWidget } from '../types/widget.js';

const TOGGLE_DOMAINS = new Set(['switch', 'input_boolean']);

const DEDICATED_DOMAIN_RENDERERS: Record<string, string> = {
    number: 'number',
    select: 'select',
    sensor: 'sensor',
    binary_sensor: 'sensor',
    light: 'light',
    climate: 'climate',
    lock: 'lock',
    vacuum: 'vacuum',
    lawn_mower: 'lawn_mower',
    weather: 'weather',
    scene: 'scene',
    button: 'button',
    script: 'button',
};

const TILE_DOMAINS = new Set([
    'cover', 'fan', 'media_player',
]);

const RESOLVED_RENDERERS = new Set([
    'number', 'select', 'sensor', 'scene', 'button', 'switch', 'tile', 'info',
    'light', 'climate', 'gauge', 'lock', 'vacuum', 'lawn_mower', 'weather', 'weather_rich',
    'camera', 'picture', 'fusion_solar', 'label',
]);

export function entityDomainFromWidget(widget: HyveviewWidget | null | undefined): string {
    const domain = String(widget?.domain || '').trim().toLowerCase();
    if (domain) return domain;
    const entityId = String(widget?.entity_id || '').trim();
    const dot = entityId.indexOf('.');
    return dot > 0 ? entityId.slice(0, dot).toLowerCase() : '';
}

export function resolveEntityEffectiveType(
    widget: HyveviewWidget | null | undefined,
): { effectiveType: string; switchStyle: boolean } {
    const storedRenderer = String(widget?.renderer || '').trim().toLowerCase();
    if (storedRenderer && storedRenderer !== 'entity' && RESOLVED_RENDERERS.has(storedRenderer)) {
        return {
            effectiveType: storedRenderer,
            switchStyle: Boolean(widget?.switch_style),
        };
    }

    const domain = entityDomainFromWidget(widget);
    const switchStyle = Boolean(widget?.switch_style);

    const dedicated = DEDICATED_DOMAIN_RENDERERS[domain];
    if (dedicated) return { effectiveType: dedicated, switchStyle: false };

    if (TOGGLE_DOMAINS.has(domain)) {
        return { effectiveType: 'switch', switchStyle: false };
    }
    if (switchStyle) {
        return { effectiveType: 'switch', switchStyle: true };
    }
    if (TILE_DOMAINS.has(domain)) {
        return { effectiveType: 'tile', switchStyle: false };
    }
    return { effectiveType: 'info', switchStyle: false };
}
