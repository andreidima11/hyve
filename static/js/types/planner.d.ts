/** Planner (to-do lists + calendar events) types. */

export type PlannerTab = 'tasks' | 'events';
export type PlannerFilterStatus = 'open' | 'done' | 'all';
export type PlannerCalView = 'month' | 'week' | 'day';

export interface PlannerList {
    id: number;
    title: string;
    color?: string;
    icon?: string;
}

export interface PlannerEntry {
    id: number;
    list_id?: number;
    entry_type?: 'task' | 'event' | string;
    title: string;
    content?: string;
    task_status?: string;
    due_at?: string;
    start_at?: string;
    end_at?: string;
    position?: number;
    priority?: number;
    event_color?: string;
    location?: string;
    created_at?: string;
    updated_at?: string;
}

export interface PlannerActionEntity {
    entity_id: string;
    name: string;
}

export interface PlannerActionOption {
    id: string;
    label: string;
    danger?: boolean;
}

export interface PlannerListsResponse {
    lists?: PlannerList[];
}

export interface PlannerEntriesResponse {
    entries?: PlannerEntry[];
}

export interface PlannerCreateEntryBody {
    list_id: number;
    entry_type: string;
    title: string;
    content?: string;
    due_at?: string;
    start_at?: string;
    end_at?: string;
    event_color?: string;
    event_notify?: boolean;
    event_notify_minutes?: number;
    event_action_enabled?: boolean;
    event_action_entity_id?: string;
    event_action_service?: string;
    event_action_offset_minutes?: number;
}

export interface PlannerAllEntitiesResponse {
    entities?: Array<{ entity_id?: string; name?: string; friendly_name?: string }>;
}
