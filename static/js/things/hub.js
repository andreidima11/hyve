/**
 * Unified entry: open device/entity detail from Integrations (or other origins).
 */
import { buildDeviceKey } from '../devices_group.js';
import { integrationIdForSourceSlug } from '../integrations/catalog_meta.js';
import { closeIntegrationConfigModal } from '../integrations/config_modal.js';
import { switchTab } from '../nav_bridge.js';
import { loadSmarthome, openDeviceDetail, openEntityDetail, primeDevicesDetailNavigation, } from '../smarthome/device_core.js';
import { setThingsReturnContext } from './nav.js';
export function deviceKeyFromIntegrationGroup(dev, catalogSlug) {
    return buildDeviceKey(String(dev.entry_id || catalogSlug || '_'), String(dev.device_id || '_'));
}
export async function openThingFromIntegration(opts) {
    setThingsReturnContext({
        kind: 'integrations',
        integrationId: opts.integrationId,
        catalogSlug: opts.catalogSlug,
    });
    closeIntegrationConfigModal();
    if (opts.entityId) {
        primeDevicesDetailNavigation({ entityId: opts.entityId });
    }
    else if (opts.deviceKey) {
        primeDevicesDetailNavigation({ deviceKey: opts.deviceKey });
    }
    switchTab('smarthome');
    await loadSmarthome();
    if (opts.entityId) {
        openEntityDetail(opts.entityId, { keepReturnContext: true, skipDeviceParent: true });
    }
    else if (opts.deviceKey) {
        openDeviceDetail(opts.deviceKey, { keepReturnContext: true });
    }
}
export function openIntegrationDeviceInHub(idx, slug, devices) {
    const dev = devices[idx];
    if (!dev)
        return;
    const catalogSlug = slug;
    const integrationId = integrationIdForSourceSlug(slug) || slug;
    const deviceKey = deviceKeyFromIntegrationGroup(dev, catalogSlug);
    void openThingFromIntegration({ integrationId, catalogSlug, deviceKey });
}
export function openIntegrationEntityInHub(entity, catalogSlug) {
    if (!entity?.entity_id)
        return;
    const integrationId = integrationIdForSourceSlug(catalogSlug) || catalogSlug;
    void openThingFromIntegration({
        integrationId,
        catalogSlug,
        entityId: entity.entity_id,
    });
}
