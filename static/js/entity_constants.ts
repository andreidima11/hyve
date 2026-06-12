/** Shared entity UI constants (Smart Home + integration device modal). */

import type { EntityCapabilities, SelectOption } from './types/entity.js';

export const CONTROLLABLE = [
    'light', 'switch', 'script', 'input_boolean', 'cover', 'lock', 'vacuum', 'lawn_mower',
    'media_player', 'climate', 'fan', 'humidifier', 'water_heater', 'button', 'select', 'number',
] as const;

/** Domains whose state is momentary / not meaningful in lists (show action UI instead). */
export const MOMENTARY_DOMAINS = ['button', 'script', 'scene'] as const;

export function isMomentaryDomain(domain: string | null | undefined): boolean {
    return (MOMENTARY_DOMAINS as readonly string[]).includes(String(domain || '').toLowerCase());
}

/** State text for entity rows/cards — avoids showing ``unknown`` for empty button states. */
export function entityStateForDisplay(
    domain: string | null | undefined,
    state: unknown,
    tState: (key: string) => string,
): string {
    if (isMomentaryDomain(domain)) return tState('button');
    if (state == null || state === '') return tState('unknown');
    return String(state);
}

export type ControllableDomain = (typeof CONTROLLABLE)[number];

export const ACTIVE_STATES = [
    'on', 'home', 'open', 'unlocked', 'playing', 'cleaning', 'mowing', 'returning', 'streaming',
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

/** Read select options from capabilities and/or entity attributes (Mammotion stores both). */
export function selectOptionsFromEntity(
    attrs: Record<string, unknown> | null | undefined,
    caps: EntityCapabilities | null | undefined,
): SelectOption[] {
    const fromCaps = selectOptionsFromCaps(caps);
    if (fromCaps.length) return fromCaps;
    const raw = attrs?.options;
    if (!Array.isArray(raw) || !raw.length) return [];
    return raw.map((item) => {
        if (item && typeof item === 'object') {
            const row = item as Record<string, unknown>;
            const value = String(row.value ?? row.label ?? '');
            const label = String(row.label ?? row.value ?? '');
            return { value, label };
        }
        const text = String(item);
        return { value: text, label: text };
    });
}

export function renderSelectControlHtml(
    slug: string,
    eid: string,
    attrs: Record<string, unknown>,
    caps: EntityCapabilities,
    currentState: string,
    ctrlAttrs: (slug: string, eid: string, action: string, payload?: Record<string, unknown> | null, opts?: { stop?: boolean }) => string,
    escapeHtmlAttr: (s: string) => string,
    escapeHtml: (s: string) => string,
): string {
    const selectOpts = selectOptionsFromEntity(attrs, caps);
    if (!selectOpts.length) return '';
    const lower = String(currentState || '').toLowerCase();
    const options = selectOpts.map((o) => {
        const v = (o && typeof o === 'object') ? String(o.value ?? o.label ?? '') : String(o);
        const lbl = (o && typeof o === 'object') ? String(o.label ?? o.value ?? '') : String(o);
        const selected = v.toLowerCase() === lower || lbl.toLowerCase() === lower;
        return `<option value="${escapeHtmlAttr(v)}"${selected ? ' selected' : ''}>${escapeHtml(lbl)}</option>`;
    }).join('');
    return `<select class="w-full bg-white/5 border border-white/10 rounded-lg text-[11px] text-slate-200 px-2 py-1.5"
        ${ctrlAttrs(slug, eid, 'set', null, { stop: true })} data-int-input="valueString" data-entity-stop="1">${options}</select>`;
}
