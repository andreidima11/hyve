/** Shared Hyve entity shapes (integrations, smarthome, dashboard). */

export type SelectOption = string | { value?: string; label?: string };

export interface EntityCapabilities {
    options?: SelectOption[];
    values?: SelectOption[];
    command_topic?: string;
    state_topic?: string;
    value_template?: string;
    z2m_property?: string;
    z2m_bridge_request?: string;
    permit_join_seconds?: number;
    payload_on?: string;
    payload_off?: string;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    device_class?: string;
    brightness_command_topic?: string;
    [key: string]: unknown;
}

export interface EntityAttributes {
    device_id?: string;
    device_name?: string;
    device_model?: string;
    device_manufacturer?: string;
    friendly_name?: string;
    zigbee_ieee?: string;
    z2m_property?: string;
    z2m_bridge?: boolean;
    via?: string;
    state_topic?: string;
    command_topic?: string;
    capabilities?: EntityCapabilities;
    [key: string]: unknown;
}

export interface HyveEntity {
    entity_id: string;
    unique_id?: string;
    name?: string;
    friendly_name?: string;
    state?: string | number | null;
    domain?: string;
    source?: string;
    unit?: string;
    controllable?: boolean;
    aliases?: string[];
    entry_id?: string;
    entry_title?: string;
    device_id?: string;
    device_name?: string;
    device_model?: string;
    device_manufacturer?: string;
    area?: string;
    attributes?: EntityAttributes;
}

export interface IntegrationDeviceGroup {
    device_id: string;
    entry_id?: string;
    entry_title?: string;
    name?: string;
    device_name?: string;
    model?: string;
    manufacturer?: string;
    device_model?: string;
    device_manufacturer?: string;
    area?: string;
    friendly_name?: string;
    entities: HyveEntity[];
}
