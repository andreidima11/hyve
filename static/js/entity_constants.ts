/** Shared entity UI constants (Smart Home + integration device modal). */

import type { EntityCapabilities, SelectOption } from './types/entity.js';

export const CONTROLLABLE = [
    'light', 'switch', 'script', 'input_boolean', 'cover', 'lock', 'vacuum',
    'media_player', 'climate', 'fan', 'humidifier', 'water_heater',
] as const;

export type ControllableDomain = (typeof CONTROLLABLE)[number];

export const ACTIVE_STATES = [
    'on', 'home', 'open', 'unlocked', 'playing', 'cleaning', 'streaming',
] as const;

/** HA discovery uses ``options``; Z2M exposes use ``values`` — accept both. */
export function selectOptionsFromCaps(caps: EntityCapabilities | null | undefined): SelectOption[] {
    if (!caps || typeof caps !== 'object') return [];
    const opts = caps.options;
    if (Array.isArray(opts) && opts.length) return opts;
    const vals = caps.values;
    if (Array.isArray(vals) && vals.length) return vals;
    return [];
}
