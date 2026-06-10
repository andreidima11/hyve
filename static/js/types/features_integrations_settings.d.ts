/** Settings → Integrations page types. */

import type { HyveEntity, IntegrationDeviceGroup } from './entity.js';

export interface IntegrationCatalogEntry {
    slug?: string;
    config_key?: string;
    config_panel_id?: string;
    toggle_input_id?: string;
    toggle_slug?: string;
    title_key?: string;
    label?: string;
    description?: string;
    icon?: string;
    image?: string;
    accent?: string;
    icon_background?: string;
    text_color?: string;
    admin_only?: boolean;
    supports_sync?: boolean;
    enabled?: boolean;
    [key: string]: unknown;
}

export interface ExposedDevicesState {
    slug: string | null;
    devices: IntegrationDeviceGroup[];
}

export interface IntegrationConfigSchemaField {
    key?: string;
    label?: string;
    type?: string;
    [key: string]: unknown;
}

export interface IntegrationConfigEntriesState {
    slug: string | null;
    schema: IntegrationConfigSchemaField[];
    entries: Record<string, unknown>[];
    supportsMultiple: boolean;
    label: string;
}

export interface EntityMetaInfo {
    icon: string;
    label: string;
}

export interface EntityMetaDef {
    icon: string;
    labelKey: string;
}

export interface SyncIntegrationEntitiesOptions {
    toast?: boolean;
}

export type IntegrationEntitiesMap = Record<string, unknown>;

export interface IntegrationDeviceSection {
    key: string;
    title?: string;
    devices: IntegrationDeviceGroup[];
}

export type ExposedEntityLiveItem = HyveEntity & Record<string, unknown>;
