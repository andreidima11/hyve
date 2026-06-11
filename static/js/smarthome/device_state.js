export const DEVICE_OPTIMISTIC_GUARD_MS = 3500;
export const DEVICES_ENTITY_CACHE_KEY = 'hyve.devices.entities.cache.v1';
export const DEVICES_ENTITY_CACHE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
export const smarthomeDeviceState = {
    haCurrentFilter: 'all',
    haCurrentSource: 'all',
    haCurrentArea: 'all',
    integrationEntitiesCache: [],
    devicesVisibleEntityCache: new Map(),
    smarthomeLoadPromise: null,
    smarthomeLoadRetryTimer: null,
    deviceControlPending: new Map(),
    deviceOptimisticGuards: new Map(),
    devicesState: {
        query: '', source: 'all', area: 'all', domain: 'all',
        page: 1, pageSize: 50, sortBy: 'name', sortDir: 'asc',
    },
    devicesShellMounted: false,
    liveUnsub: null,
    cacheRefreshTimer: null,
    haBulkMode: false,
    filterPickerEventsWired: false,
};
export const smarthomeModalState = {
    haAliasModalEntityId: null,
    haAliasModalOriginalParent: null,
    haRowActionsEntityId: null,
    haRowActionsModalOriginalParent: null,
    availableDevices: [],
};
