/** Smart home / devices page types. */

import type { HyveEntity } from './entity.js';

export interface SmarthomeEntity extends HyveEntity {
    selected?: boolean;
}

export interface DevicesState {
    query: string;
    source: string;
    area: string;
    domain: string;
    page: number;
    pageSize: number;
    sortBy: string;
    sortDir: 'asc' | 'desc';
}

export interface SourceFilterMeta {
    slug: string;
    label: string;
}

export interface AreaFilterMeta {
    name: string;
    count: number;
}

export interface SmarthomeEntitySnapshotMeta {
    sources?: SourceFilterMeta[];
    areas?: AreaFilterMeta[];
}

export interface SmarthomeFilterChoice {
    value: string;
    label: string;
    count: number | null;
}

export interface SourceIconMeta {
    icon: string;
    color: string;
    label: string;
}

export interface DeviceControlPending {
    action: string;
    previousState: string | number | null | undefined;
    optimisticState: string | number | null | undefined;
    startedAt: number;
}

export interface LoadSmarthomeOptions {
    force?: boolean;
}

export interface IntegrationsAllEntitiesResponse {
    entities?: SmarthomeEntity[];
    sources?: SourceFilterMeta[];
    areas?: AreaFilterMeta[];
}

export interface AvailableDeviceEntry {
    entity_id: string;
    name?: string;
    domain?: string;
    state?: string | number | null;
}
