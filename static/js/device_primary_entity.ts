/**
 * User-selected primary entity per device (localStorage).
 * Used when a relay exposes many switches — pick which drives overview state/toggle.
 */
import type { PhysicalDeviceGroup } from './devices_group.js';
import type { SmarthomeEntity } from './types/features_smarthome.js';

const STORAGE_KEY = 'hyve.devices.primary_entity.v1';

type PrimaryEntityStore = Record<string, string>;

function _readStore(): PrimaryEntityStore {
    if (typeof localStorage === 'undefined') return {};
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const data = JSON.parse(raw);
        return data && typeof data === 'object' ? data as PrimaryEntityStore : {};
    } catch (_) {
        return {};
    }
}

function _writeStore(store: PrimaryEntityStore): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch (_) {}
}

export function getDevicePrimaryEntityOverride(deviceKey: string): string | null {
    const key = String(deviceKey || '').trim();
    if (!key) return null;
    const id = _readStore()[key];
    return id && String(id).trim() ? String(id).trim() : null;
}

export function setDevicePrimaryEntityOverride(deviceKey: string, entityId: string | null): void {
    const key = String(deviceKey || '').trim();
    if (!key) return;
    const store = _readStore();
    const eid = String(entityId || '').trim();
    if (!eid) delete store[key];
    else store[key] = eid;
    _writeStore(store);
}

function _domainOf(ent: SmarthomeEntity): string {
    return String(ent.domain || String(ent.entity_id || '').split('.')[0] || '').toLowerCase();
}

export function autoPrimaryDeviceEntity(device: PhysicalDeviceGroup): SmarthomeEntity | null {
    const dom = device.primary_domain || '';
    const ents = device.entities || [];
    const hit = ents.find((e) => _domainOf(e) === dom && e.controllable !== false);
    if (hit) return hit;
    for (const d of ['light', 'switch', 'climate', 'fan', 'cover', 'lock', 'camera']) {
        const h = ents.find((e) => _domainOf(e) === d);
        if (h) return h;
    }
    return ents[0] || null;
}

export function resolvePrimaryDeviceEntity(device: PhysicalDeviceGroup): SmarthomeEntity | null {
    const ents = device.entities || [];
    const overrideId = getDevicePrimaryEntityOverride(device.device_key);
    if (overrideId) {
        const hit = ents.find((e) => e.entity_id === overrideId);
        if (hit) return hit;
    }
    return autoPrimaryDeviceEntity(device);
}

export function primaryEntityCandidates(device: PhysicalDeviceGroup): SmarthomeEntity[] {
    const priority = ['switch', 'light', 'input_boolean', 'fan', 'cover', 'lock', 'climate', 'vacuum', 'media_player'];
    const ents = device.entities || [];
    const picked = ents.filter((e) => {
        if (e.controllable === false) return false;
        const dom = _domainOf(e);
        return priority.includes(dom);
    });
    picked.sort((a, b) => {
        const da = _domainOf(a);
        const db = _domainOf(b);
        const oa = priority.indexOf(da);
        const ob = priority.indexOf(db);
        if (oa !== ob) return (oa < 0 ? 99 : oa) - (ob < 0 ? 99 : ob);
        return String(a.name || a.entity_id || '').localeCompare(String(b.name || b.entity_id || ''));
    });
    return picked.length ? picked : ents.slice();
}
