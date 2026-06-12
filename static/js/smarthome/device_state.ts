/**
 * Smart home devices — shared state.
 */
import type {
    DevicesState,
    SmarthomeEntity,
} from '../types/features_smarthome.js';

export const DEVICE_OPTIMISTIC_GUARD_MS = 3500;
export const DEVICES_ENTITY_CACHE_KEY = 'hyve.devices.entities.cache.v1';
export const DEVICES_ENTITY_CACHE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_PAGE_SIZE_OPTIONS: number[] = [25, 50, 100, 200];

export const smarthomeDeviceState = {
    haCurrentFilter: 'all',
    haCurrentSource: 'all',
    haCurrentArea: 'all',
    integrationEntitiesCache: [] as SmarthomeEntity[],
    devicesVisibleEntityCache: new Map<string, SmarthomeEntity>(),
    smarthomeLoadPromise: null as Promise<void> | null,
    smarthomeLoadRetryTimer: null as ReturnType<typeof setTimeout> | null,
    deviceControlPending: new Map<string, { action: string; previousState: unknown; optimisticState: unknown; startedAt: number }>(),
    deviceOptimisticGuards: new Map<string, { state: unknown; until: number }>(),
    devicesState: {
        query: '', source: 'all', area: 'all', domain: 'all',
        page: 1, pageSize: 50, sortBy: 'name', sortDir: 'asc',
    } as DevicesState,
    devicesShellMounted: false,
    entityCategoryFilter: 'all',
    openDeviceKey: null as string | null,
    openEntityId: null as string | null,
    liveUnsub: null as (() => void) | null,
    cacheRefreshTimer: null as ReturnType<typeof setTimeout> | null,
    filterPickerEventsWired: false,
};

export const smarthomeModalState = {
    haAliasModalEntityId: null as string | null,
    haAliasModalOriginalParent: null as ParentNode | null,
    haRowActionsEntityId: null as string | null,
    haRowActionsModalOriginalParent: null as ParentNode | null,
};

