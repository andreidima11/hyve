/** Scene API shapes (/api/scenes). */

export type SceneService = 'turn_on' | 'turn_off' | 'toggle';

export interface SceneEntry {
    entity_id: string;
    service?: SceneService | string;
    service_data?: Record<string, unknown>;
}

export interface SceneSummary {
    id: string;
    name?: string;
    description?: string;
    icon?: string;
    color?: string;
    enabled?: boolean;
    is_shared?: boolean;
    entry_count?: number;
}

export interface SceneDetail extends SceneSummary {
    entries?: SceneEntry[];
}

export interface SceneEntityCatalogItem {
    entity_id: string;
    friendly_name?: string;
    label?: string;
    source?: string;
}
