/** Shared entity UI constants (Smart Home + integration device modal). */

export const CONTROLLABLE = [
    'light', 'switch', 'script', 'input_boolean', 'cover', 'lock', 'vacuum',
    'media_player', 'climate', 'fan', 'humidifier', 'water_heater',
];

export const ACTIVE_STATES = ['on', 'home', 'open', 'unlocked', 'playing', 'cleaning', 'streaming'];

/** HA discovery uses ``options``; Z2M exposes use ``values`` — accept both. */
export function selectOptionsFromCaps(caps) {
    if (!caps || typeof caps !== 'object') return [];
    const opts = caps.options;
    if (Array.isArray(opts) && opts.length) return opts;
    const vals = caps.values;
    if (Array.isArray(vals) && vals.length) return vals;
    return [];
}
