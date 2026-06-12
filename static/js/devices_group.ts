/**
 * Group flat entities into physical devices (Devices page list).
 */
import { integrationIdForSourceSlug } from './integrations/catalog_meta.js';
import { isActiveState } from './integrations/utils.js';
import { resolvePrimaryDeviceEntity } from './device_primary_entity.js';
import type { HyveEntity, IntegrationDeviceGroup } from './types/entity.js';
import type { SmarthomeEntity } from './types/features_smarthome.js';

export interface PhysicalDeviceGroup extends IntegrationDeviceGroup {
    source_slug: string;
    device_key: string;
    primary_domain: string;
}

export function resolveControlSlug(entity: HyveEntity): string {
    const source = String(entity.source || '').trim();
    if (!source || source === 'derived') return '';
    return integrationIdForSourceSlug(source) || source;
}

export function buildDeviceKey(entryId: string, deviceId: string): string {
    return `${entryId || '_'}::${deviceId || '_'}`;
}

function _domainOf(ent: HyveEntity): string {
    return String(ent.domain || String(ent.entity_id || '').split('.')[0] || '').toLowerCase();
}

function _resolveDeviceId(ent: HyveEntity, attrs: Record<string, unknown>, entryId: string, source: string): string {
    let deviceId = String(ent.device_id || attrs.device_id || '').trim();
    if (deviceId) return deviceId;
    const ieee = String(attrs.zigbee_ieee || '').trim();
    if (ieee) return ieee;
    const fn = String(attrs.friendly_name || ent.device_name || attrs.device_name || '').trim();
    if (fn) return `fn:${entryId}:${fn}`;
    if (source === 'derived') return String(ent.entity_id || '').trim();
    return String(ent.entity_id || '').trim();
}

export function groupEntitiesIntoDevices(entities: SmarthomeEntity[]): PhysicalDeviceGroup[] {
    const groups = new Map<string, PhysicalDeviceGroup>();
    const order: string[] = [];

    for (const ent of entities) {
        if (!ent || typeof ent !== 'object') continue;
        const source = String(ent.source || '').trim();
        const attrs = (ent.attributes || {}) as Record<string, unknown>;
        const entryId = String(ent.entry_id || source || '_');
        const deviceId = _resolveDeviceId(ent, attrs, entryId, source);
        if (!deviceId) continue;

        const key = buildDeviceKey(entryId, deviceId);
        if (!groups.has(key)) {
            order.push(key);
            groups.set(key, {
                device_id: deviceId,
                entry_id: entryId,
                entry_title: String(ent.entry_title || ''),
                name: String(ent.device_name || attrs.device_name || ent.name || deviceId).trim(),
                device_name: String(attrs.device_name || ent.device_name || ''),
                model: String(ent.device_model || attrs.device_model || ''),
                manufacturer: String(ent.device_manufacturer || attrs.device_manufacturer || ''),
                device_model: String(ent.device_model || attrs.device_model || ''),
                device_manufacturer: String(ent.device_manufacturer || attrs.device_manufacturer || ''),
                area: String(ent.area || attrs.area || ''),
                friendly_name: String(attrs.friendly_name || ent.device_name || ''),
                image_url: String((ent as HyveEntity & { image_url?: string }).image_url || attrs.image_url || ''),
                source_slug: resolveControlSlug(ent) || source,
                device_key: key,
                primary_domain: '',
                entities: [],
            });
        }
        groups.get(key)!.entities.push(ent);
    }

    for (const g of groups.values()) {
        g.primary_domain = _inferPrimaryDomain(g);
        if ((g.entities || []).length === 1) {
            const only = g.entities[0];
            const attrs = (only.attributes || {}) as Record<string, unknown>;
            const better = String(only.device_name || attrs.device_name || attrs.friendly_name || '').trim();
            if (better && (g.name === only.entity_id || g.name === g.device_id)) g.name = better;
        }
    }

    return order.map((k) => groups.get(k)!).sort((a, b) => {
        const ta = String(a.entry_title || '').toLowerCase();
        const tb = String(b.entry_title || '').toLowerCase();
        if (ta !== tb) return ta.localeCompare(tb);
        return String(a.name || '').toLowerCase().localeCompare(String(b.name || '').toLowerCase());
    });
}

/** Domains that define what the physical device *is* (vs auxiliary entities). */
const IDENTITY_DOMAINS = [
    'camera', 'climate', 'water_heater', 'vacuum', 'media_player', 'lawn_mower',
    'cover', 'lock',
] as const;

const CONTROL_DOMAINS = ['light', 'fan', 'switch', 'input_boolean', 'outlet', 'plug'] as const;

const READONLY_DOMAINS = ['sensor', 'binary_sensor', 'number', 'select', 'button', 'event'] as const;

function _inferPrimaryDomain(device: PhysicalDeviceGroup): string {
    const domains = new Set((device.entities || []).map(_domainOf));
    for (const dom of IDENTITY_DOMAINS) {
        if (domains.has(dom)) return dom;
    }
    for (const dom of CONTROL_DOMAINS) {
        if (domains.has(dom)) return dom;
    }
    for (const dom of READONLY_DOMAINS) {
        if (domains.has(dom)) return dom;
    }
    return [...domains][0] || 'device';
}

/** Single category bucket for the Devices page chip filters. */
export function deviceListCategory(device: PhysicalDeviceGroup): string {
    const dom = device.primary_domain || _inferPrimaryDomain(device);
    if (dom === 'light') return 'light';
    if (dom === 'camera') return 'camera';
    if (['climate', 'water_heater', 'fan'].includes(dom)) return 'climate';
    if (['sensor', 'binary_sensor'].includes(dom)) return 'sensor';
    if (['switch', 'input_boolean', 'outlet', 'plug'].includes(dom)) return 'switch';
    const known = new Set([
        'light', 'camera', 'climate', 'water_heater', 'fan',
        'sensor', 'binary_sensor', 'switch', 'input_boolean', 'outlet', 'plug',
    ]);
    return known.has(dom) ? dom : 'other';
}

export function primaryDeviceEntity(device: PhysicalDeviceGroup): SmarthomeEntity | null {
    return resolvePrimaryDeviceEntity(device);
}

export function deviceMatchesCategory(device: PhysicalDeviceGroup, category: string): boolean {
    const cat = String(category || 'all').toLowerCase();
    if (cat === 'all' || cat === 'active' || cat === 'ai') return true;
    const bucket = deviceListCategory(device);
    if (cat === 'light' || cat === 'lights') return bucket === 'light';
    if (cat === 'climate') return bucket === 'climate';
    if (cat === 'sensor' || cat === 'sensors') return bucket === 'sensor';
    if (cat === 'switch' || cat === 'switches') return bucket === 'switch';
    if (cat === 'camera' || cat === 'cameras') return bucket === 'camera';
    if (cat === 'other' || cat === 'others') return bucket === 'other';
    return bucket === cat;
}

export function deviceHasActiveEntity(device: PhysicalDeviceGroup): boolean {
    return (device.entities || []).some((e) => {
        const s = String(e.state || '').toLowerCase();
        return isActiveState(s) || s === 'on';
    });
}

export function deviceSearchText(device: PhysicalDeviceGroup): string {
    return [
        device.name, device.device_id, device.area, device.model, device.manufacturer,
        device.entry_title, device.source_slug,
        ...(device.entities || []).map((e) => `${e.name || ''} ${e.entity_id || ''}`),
    ].join(' ').toLowerCase();
}

export function sortDeviceEntities(device: PhysicalDeviceGroup): SmarthomeEntity[] {
    const order: Record<string, number> = {
        switch: 0, light: 1, cover: 2, lock: 3, climate: 4, number: 5, select: 6,
        button: 7, event: 8, binary_sensor: 9, sensor: 10,
    };
    return (device.entities || []).slice().sort((a, b) => {
        const da = String(a.entity_id || '').split('.')[0];
        const db = String(b.entity_id || '').split('.')[0];
        const oa = order[da] ?? 99;
        const ob = order[db] ?? 99;
        if (oa !== ob) return oa - ob;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });
}

/** Integration-backed device with a stable device_id (rename API). */
export function canRenameIntegrationDevice(device: PhysicalDeviceGroup): boolean {
    const slug = String(device.source_slug || '').trim();
    const deviceId = String(device.device_id || '').trim();
    if (!slug || slug === 'derived' || !deviceId) return false;
    const ents = device.entities || [];
    if (!ents.length) return false;
    return ents.some((e) => String(e.source || '').trim() && String(e.source || '').trim() !== 'derived');
}
