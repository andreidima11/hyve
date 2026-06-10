/** Automations editor / builder types. */

export interface AutomationCapabilityEntity {
    entity_id?: string;
    name?: string;
    domain?: string;
    area?: string;
    aliases?: string[];
    [key: string]: unknown;
}

export interface AutomationCapabilities {
    schema: unknown;
    entities: AutomationCapabilityEntity[];
    areas: string[];
}

export interface AutomationBuilderState {
    id: string;
    title: string;
    description: string;
    enabled: boolean;
    mode: string;
}

export type AutomationBuilderRow = Record<string, unknown>;

export type AutomationEditorMode = 'builder' | 'yaml' | 'history' | string;

export interface AutomationListItem {
    id?: string;
    title?: string;
    enabled?: boolean;
    next_run?: string | null;
    updated_at?: string;
    last_run_status?: string;
    [key: string]: unknown;
}

export interface AutomationHistoryItem {
    id?: string;
    started_at?: string;
    status?: string;
    trace?: unknown;
    [key: string]: unknown;
}

export interface SyncAutomationOptions {
    silent?: boolean;
    rerenderActions?: boolean;
    rerenderTriggers?: boolean;
    rerenderConditions?: boolean;
}

export interface AutomationPickerEntity {
    id: string;
    label: string;
    domain: string;
}

export interface AutomationPickerArea {
    id: string;
    label: string;
}
