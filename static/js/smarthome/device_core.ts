/**
 * Smart home devices list: load, live updates, filters, selection.
 */
import { apiCall } from '../api.js';
import {
    initIntegrationsLiveWs,
    refreshIntegrationsLiveConnection,
    subscribeIntegrationsLive,
} from '../integrations_live_ws.js';
import { setDevicePrimaryEntityOverride } from '../device_primary_entity.js';
import {
    closeDevicePrimaryEntityModal,
    initDevicePrimaryHoldBindings,
} from './device_primary_modal.js';
import { getCameraStreamToken, cameraProxyUrlSync, startCameraPreviewRefresh, stopCameraPreviewRefresh } from '../camera_auth.js';
import { cameraLoaderMarkup, bindCameraPreviewLoaders } from '../camera_loader.js';
import { t, tState, applyTranslations } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr, showToast, showConfirm, debounce } from '../utils.js';
import { cameraPreferWebmPlayer } from '../camera_live.js';
import { renderEntityModal, wireEntityRegistryEditor, wireEntityFriendlyNameEditor } from '../entity_renderers.js';
import { resolveEntityControlSlug } from '../entity_detail_modal.js';
import {
    groupEntitiesIntoDevices,
    deviceMatchesCategory,
    deviceHasActiveEntity,
    deviceSearchText,
    primaryDeviceEntity,
    sortDeviceEntities,
    canRenameIntegrationDevice,
    type PhysicalDeviceGroup,
} from '../devices_group.js';
import { renameIntegrationDevice } from '../integrations/exposed_devices.js';
import {
    renderEntityCategoryTabs,
    renderEntityDetailPage,
    renderDeviceListCard,
    renderDeviceDetailPage,
    patchDeviceOverviewDom,
    patchEntityOverviewDom,
    patchEntityDetailDom,
} from '../devices_ui.js';
import { entityMatchesIntegration } from '../integration_sources.js';
import { ACTIVE_STATES, CONTROLLABLE, entityStateForDisplay } from '../entity_constants.js';
import type {
    AvailableDeviceEntry,
    DevicesState,
    IntegrationsAllEntitiesResponse,
    LoadSmarthomeOptions,
    SmarthomeEntity,
    SmarthomeEntitySnapshotMeta,
    SmarthomeFilterChoice,
    SourceIconMeta,
    SourceFilterMeta,
    AreaFilterMeta,
} from '../types/features_smarthome.js';

import { smarthomeDeviceState, smarthomeModalState, DEVICE_OPTIMISTIC_GUARD_MS, DEVICES_ENTITY_CACHE_KEY, DEVICES_ENTITY_CACHE_TTL_MS, DEVICE_PAGE_SIZE_OPTIONS } from './device_state.js';

export function _errMsg(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

export function _isActiveState(state: string): boolean {
    return (ACTIVE_STATES as readonly string[]).includes(state);
}


export { ACTIVE_STATES, CONTROLLABLE };
function _mountDevicesPageShell() {
    const host = document.querySelector('#view-smarthome .hy-page-inner');
    if (!host || document.getElementById('hy-devices-root')) return;
    smarthomeDeviceState.devicesShellMounted = true;
    host.innerHTML = `
        <div id="hy-devices-root" class="hy-devices-root hy-devices-root--modern">
            <div class="hyd-stage" id="hy-devices-stage">
            <div id="hy-devices-list-chrome" class="hyd-devices-list-chrome">
            <header class="hyd-mast hyd-top">
                <div class="hyd-mast__lead">
                    <button type="button" data-smarthome-action="openConfigHub" class="hyd-mast__back" data-i18n-title="hy.back" aria-label="Back">
                        <i class="fas fa-arrow-left"></i>
                    </button>
                    <h1 class="hyd-mast__title hyd-top__title" data-i18n="nav.smarthome">Devices</h1>
                </div>
                <div class="hyd-mast__actions">
                    <button type="button" data-smarthome-action="syncSmartHome" class="hyd-mast__back hyd-mast__back--icon" data-i18n-title="common.reload" aria-label="Sync">
                        <i class="fas fa-arrows-rotate"></i>
                    </button>
                    <button type="button" data-smarthome-action="openIntegrations" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-accent text-bg-main hover:bg-accent-hover transition-colors" data-i18n-title="hy.add_devices_title">
                        <i class="fas fa-plus"></i><span data-i18n="hy.add_devices">Add Devices</span>
                    </button>
                </div>
            </header>

            <section class="hyd-metrics hyd-metrics--sr" aria-live="polite">
                <strong class="hyd-metric__value" id="hy-count">--</strong>
                <strong class="hyd-metric__value" id="hy-active-count">--</strong>
                <strong class="hyd-metric__value" id="hy-ai-count">--</strong>
            </section>

            <nav id="hy-entity-category-tabs" class="hyd-chips" aria-label="Categories"></nav>

            <section class="hyd-toolbar" data-i18n-aria-label="hy.device_tools_aria" aria-label="Device tools">
                <div class="hy-search-wrap hyd-search-wrap">
                    <i class="fas fa-magnifying-glass hy-search-icon" aria-hidden="true"></i>
                    <input type="search" id="hy-search" class="hy-search-input" data-i18n-placeholder="hy.search_placeholder" placeholder="Search..." autocomplete="off">
                </div>
                <button type="button" id="hy-mobile-filter-toggle" class="hy-btn hy-btn-ghost hyd-toolbar__filter" data-smarthome-action="toggleSmarthomeFilters" aria-controls="hy-filter-panel" aria-expanded="false" data-i18n-title="hy.filters">
                    <i class="fas fa-sliders" aria-hidden="true"></i>
                    <span data-i18n="hy.filters">Filters</span>
                </button>
            </section>

            <section class="hy-sticky-toolbar hyd-filter-deck" data-filters-open="false">
                <div class="hyd-filter-panel" id="hy-filter-panel" data-i18n-aria-label="hy.filters_panel_aria" aria-label="Device filters">
                    <div class="hyd-filter-grid">
                        <div class="hyd-filter-slot" id="hy-source-filters"></div>
                        <div class="hyd-filter-slot" id="hy-area-filters"></div>
                        <div class="hyd-filter-slot" id="hy-domain-filters"></div>
                        <button type="button" class="hy-btn hy-btn-ghost hyd-filter-reset" data-smarthome-action="resetSmarthomeFilters" data-i18n-title="hy.reset_filters">
                            <i class="fas fa-rotate-left"></i>
                            <span data-i18n="hy.reset_filters">Reset filters</span>
                        </button>
                    </div>
                </div>
            </section>
            </div>

            <section id="hy-cards-grid" class="hyd-list-shell">
                <div id="hy-entity-list-view" class="hyd-gallery">
                    <div id="hy-entity-cards" class="hyd-device-list" role="list"></div>
                    <span id="hy-source-all-count" class="hyd-sr-only" aria-hidden="true">--</span>
                    <div id="hy-devices-pagination" class="hyd-pager"></div>
                </div>
                <div id="hy-entity-detail-view" class="hidden"></div>
            </section>
            </div>
        </div>`;
    applyTranslations();
    const searchInput = host.querySelector('#hy-search') as HTMLInputElement | null;
    if (searchInput && !searchInput.dataset.hySearchWired) {
        searchInput.dataset.hySearchWired = '1';
        searchInput.addEventListener('input', debounce(filterDevices, 160));
    }
}

function _setDevicesLoading(message = t('integrations.loading_devices')) {
    const grid = document.getElementById('hy-entity-cards');
    const pagination = document.getElementById('hy-devices-pagination');
    const detail = document.getElementById('hy-entity-detail-view');
    const pendingDetail = smarthomeDeviceState.openDeviceKey || smarthomeDeviceState.openEntityId;
    if (pendingDetail) {
        _renderDevicesDetailLoading(message);
        if (grid) grid.innerHTML = '';
        if (pagination) pagination.innerHTML = '';
        return;
    }
    if (detail) { detail.innerHTML = ''; }
    smarthomeDeviceState.openEntityId = null;
    smarthomeDeviceState.openDeviceKey = null;
    _setDevicesViewMode('list');
    if (grid) grid.innerHTML = `<div class="hyd-list-placeholder"><i class="fas fa-circle-notch fa-spin"></i>${escapeHtml(message)}</div>`;
    if (pagination) pagination.innerHTML = '';
}

function _renderDevicesDetailLoading(message = t('integrations.loading_devices')) {
    const detailView = document.getElementById('hy-entity-detail-view');
    _setDevicesViewMode('detail');
    if (detailView) {
        detailView.innerHTML = `<div class="hyd-list-placeholder"><i class="fas fa-circle-notch fa-spin"></i>${escapeHtml(message)}</div>`;
    }
}

/** Open detail view immediately (spinner) before entity cache is ready — avoids list flash from Integrations. */
export function primeDevicesDetailNavigation(opts: { deviceKey?: string; entityId?: string }) {
    const entityId = String(opts.entityId || '').trim();
    const deviceKey = String(opts.deviceKey || '').trim();
    if (entityId) {
        smarthomeDeviceState.openEntityId = entityId;
        smarthomeDeviceState.openDeviceKey = null;
        smarthomeModalState.haRowActionsEntityId = entityId;
    } else if (deviceKey) {
        smarthomeDeviceState.openDeviceKey = deviceKey;
        smarthomeDeviceState.openEntityId = null;
        smarthomeModalState.haRowActionsEntityId = null;
    } else {
        return;
    }
    _mountDevicesPageShell();
    _renderDevicesDetailLoading();
}

function _setDevicesError(message: string) {
    const grid = document.getElementById('hy-entity-cards');
    const pagination = document.getElementById('hy-devices-pagination');
    if (grid) grid.innerHTML = `<div class="hyd-list-placeholder hy-list-error">
        <i class="fas fa-triangle-exclamation"></i>${escapeHtml(message || t('integrations.devices_load_error'))}
        <button type="button" class="hy-btn hy-btn-ghost" data-smarthome-action="syncSmartHome"><i class="fas fa-arrows-rotate"></i>${escapeHtml(t('integrations.retry'))}</button>
    </div>`;
    if (pagination) pagination.innerHTML = '';
}

async function _apiCallWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await apiCall(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

export const DOMAIN_ICONS: Record<string, string> = {
    light: 'fa-lightbulb', switch: 'fa-toggle-on', script: 'fa-play',
    input_boolean: 'fa-toggle-on', cover: 'fa-door-open', lock: 'fa-lock',
    sensor: 'fa-gauge', binary_sensor: 'fa-circle-dot', climate: 'fa-temperature-half',
    media_player: 'fa-music', vacuum: 'fa-robot', lawn_mower: 'fa-leaf', weather: 'fa-cloud-sun',
    person: 'fa-user', image: 'fa-image', camera: 'fa-video'
};
export const DOMAIN_COLORS: Record<string, string> = {
    light: 'bg-yellow-500/15 text-yellow-400', switch: 'bg-blue-500/15 text-blue-400',
    script: 'bg-emerald-500/15 text-emerald-400', input_boolean: 'bg-blue-500/15 text-blue-400',
    cover: 'bg-orange-500/15 text-orange-400', lock: 'bg-red-500/15 text-red-400',
    sensor: 'bg-cyan-500/15 text-cyan-400', binary_sensor: 'bg-teal-500/15 text-teal-400',
    climate: 'bg-rose-500/15 text-rose-400', media_player: 'bg-purple-500/15 text-purple-400',
    vacuum: 'bg-indigo-500/15 text-indigo-400', lawn_mower: 'bg-lime-500/15 text-lime-400', weather: 'bg-sky-500/15 text-sky-400',
    person: 'bg-slate-500/15 text-slate-400',
    image: 'bg-violet-500/15 text-violet-400', camera: 'bg-sky-500/15 text-sky-400'
};
const DOMAIN_LABEL_KEYS: Record<string, string> = {
    light: 'hy.filter_lights',
    switch: 'hy.filter_switches',
    sensor: 'hy.filter_sensors',
    binary_sensor: 'hy.filter_binary',
    climate: 'hy.filter_climate',
    cover: 'hy.filter_covers',
    media_player: 'hy.filter_media',
};
const DOMAIN_ORDER = [
    'light', 'switch', 'sensor', 'binary_sensor', 'climate', 'cover', 'lock',
    'media_player', 'camera', 'image', 'vacuum', 'lawn_mower', 'weather', 'person', 'number', 'select',
    'button', 'script', 'input_boolean',
];

// Normalize an icon spec into a usable CSS class. Mirrors dashboard.js _iconClass
// so smarthome rows accept the same syntaxes (mdi:*, fa-*, fas fa-*, mdi-*).
export function _iconClass(spec: unknown) {
    const raw = String(spec || '').trim();
    if (!raw) return '';
    if (raw.startsWith('mdi:'))   return `mdi mdi-${raw.slice(4)}`;
    if (/^mdi(\s|-)/.test(raw))   return raw.startsWith('mdi-') ? `mdi ${raw}` : raw;
    if (/\bfa[srlbd]?\b/.test(raw)) return raw;
    if (raw.startsWith('fa-'))      return `fas ${raw}`;
    return raw;
}

export function _norm(value: unknown) {
    return String(value ?? '').trim().toLowerCase();
}

function _entityId(entity: SmarthomeEntity | null | undefined) {
    return String(entity?.entity_id || '');
}

export function _entityDomain(entity: SmarthomeEntity | null | undefined) {
    const eid = _entityId(entity);
    return _norm(entity?.domain || eid.split('.')[0] || 'unknown');
}

function _entityAliases(entity: SmarthomeEntity | null | undefined) {
    return Array.isArray(entity?.aliases) ? entity.aliases : [];
}

function _syncDevicesStateFromInputs({ resetPage = false }: { resetPage?: boolean } = {}) {
    smarthomeDeviceState.devicesState.query = _norm((document.getElementById('hy-search') as HTMLInputElement | null)?.value || '');
    smarthomeDeviceState.devicesState.source = _norm(smarthomeDeviceState.haCurrentSource || 'all') || 'all';
    smarthomeDeviceState.devicesState.area = _norm(smarthomeDeviceState.haCurrentArea || 'all') || 'all';
    smarthomeDeviceState.devicesState.domain = _norm(smarthomeDeviceState.haCurrentFilter || 'all') || 'all';
    if (resetPage) smarthomeDeviceState.devicesState.page = 1;
}

function _deriveSourcesFromEntities(entities: SmarthomeEntity[]) {
    const sources = new Map();
    for (const entity of Array.isArray(entities) ? entities : []) {
        const slug = String(entity?.source || '').trim();
        if (!slug || sources.has(slug)) continue;
        const meta = SOURCE_ICONS[slug] || null;
        sources.set(slug, {
            slug,
            label: meta?.label || entity.entry_title || slug.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()),
        });
    }
    return [...sources.values()];
}

function _deriveAreasFromEntities(entities: SmarthomeEntity[]) {
    const areas = new Map();
    for (const entity of Array.isArray(entities) ? entities : []) {
        const name = String(entity?.area || '').trim();
        if (!name) continue;
        areas.set(name, (areas.get(name) || 0) + 1);
    }
    return [...areas.entries()]
        .sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
        .map(([name, count]) => ({ name, count }));
}

function _rebuildSmarthomeFilters(sources: SourceFilterMeta[] | null = null, areas: AreaFilterMeta[] | null = null) {
    _buildSourceFilters(Array.isArray(sources) ? sources : _deriveSourcesFromEntities(smarthomeDeviceState.integrationEntitiesCache));
    _buildAreaFilters(Array.isArray(areas) ? areas : _deriveAreasFromEntities(smarthomeDeviceState.integrationEntitiesCache));
    _buildDomainFilters();
    _syncSmarthomeFilterPickers();
}

function _saveSmarthomeEntitySnapshot(entities: SmarthomeEntity[], meta: SmarthomeEntitySnapshotMeta = {}) {
    if (!Array.isArray(entities) || !entities.length || typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(DEVICES_ENTITY_CACHE_KEY, JSON.stringify({
            ts: Date.now(),
            entities,
            sources: Array.isArray(meta.sources) ? meta.sources : _deriveSourcesFromEntities(entities),
            areas: Array.isArray(meta.areas) ? meta.areas : _deriveAreasFromEntities(entities),
        }));
    } catch (_) {}
}

function _restoreSmarthomeEntitySnapshot() {
    if (smarthomeDeviceState.integrationEntitiesCache.length || typeof localStorage === 'undefined') return false;
    try {
        const raw = localStorage.getItem(DEVICES_ENTITY_CACHE_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.entities) || !data.entities.length) return false;
        if (Date.now() - Number(data.ts || 0) > DEVICES_ENTITY_CACHE_TTL_MS) return false;
        smarthomeDeviceState.integrationEntitiesCache = data.entities;
        _rebuildSmarthomeFilters(data.sources, data.areas);
        _updateStats();
        return true;
    } catch (_) {
        return false;
    }
}

function _scheduleSmarthomeLoadRetry(delayMs = 1500) {
    if (smarthomeDeviceState.smarthomeLoadRetryTimer) return;
    smarthomeDeviceState.smarthomeLoadRetryTimer = setTimeout(() => {
        smarthomeDeviceState.smarthomeLoadRetryTimer = null;
        const view = document.getElementById('view-smarthome');
        if (!view || view.classList.contains('hidden') || smarthomeDeviceState.integrationEntitiesCache.length) return;
        loadSmarthome({ force: true }).catch(() => {});
    }, delayMs);
}

function _deviceSearchText(entity: SmarthomeEntity) {
    const attrs = entity?.attributes || {};
    return [
        entity?.name,
        entity?.entity_id,
        entity?.unique_id,
        entity?.source,
        entity?.entry_title,
        entity?.area,
        entity?.domain,
        attrs.friendly_name,
        attrs.device_class,
        attrs.manufacturer,
        attrs.model,
        ..._entityAliases(entity),
    ].filter(v => v != null && v !== '').join(' ').toLowerCase();
}

export async function loadSmarthome(options: LoadSmarthomeOptions = {}) {
    getCameraStreamToken().catch(() => {});
    const force = !!options?.force;
    if (smarthomeDeviceState.smarthomeLoadPromise && !force) return smarthomeDeviceState.smarthomeLoadPromise;

    _mountDevicesPageShell();
    const grid = document.getElementById('hy-cards-grid');
    if (!grid) return;
    _wireSmarthomeFilterPickerEvents();
    initDevicePrimaryHoldBindings(_findDeviceGroupByKey);

    const restoredSnapshot = _restoreSmarthomeEntitySnapshot();
    if (restoredSnapshot) renderDeviceCards();
    else if (!smarthomeDeviceState.integrationEntitiesCache.length) _setDevicesLoading();

    smarthomeDeviceState.smarthomeLoadPromise = (async () => { try {
        const resIntegrations = await _apiCallWithTimeout('/api/integrations/all-entities', {}, 20000).catch((err) => {
            console.warn('[hyve] devices load failed', err);
            return null;
        });

        // Don't wipe the cache before we have new data — if the API fails or
        // is slow, the user can still search through whatever was loaded
        // previously instead of seeing "no devices found".
        let nextEntities = null;
        let intData: IntegrationsAllEntitiesResponse | null = null;
        if (resIntegrations && resIntegrations.ok) {
            try { intData = await resIntegrations.json(); } catch (_) { intData = null; }
            if (intData && Array.isArray(intData.entities)) {
                nextEntities = intData.entities;
            }
        }
        if (nextEntities) {
            if (nextEntities.length) {
                smarthomeDeviceState.integrationEntitiesCache = nextEntities;
                _saveSmarthomeEntitySnapshot(nextEntities, intData || {});
                _rebuildSmarthomeFilters((intData && intData.sources) || null, (intData && intData.areas) || null);
            } else if (smarthomeDeviceState.integrationEntitiesCache.length) {
                console.warn('[hyve] devices load returned an empty entity list; keeping last good cache');
            }
        }

        if (!smarthomeDeviceState.integrationEntitiesCache.length) {
            const shouldRetry = !nextEntities || !!smarthomeDeviceState.devicesState.query;
            if (shouldRetry) {
                _setDevicesLoading(smarthomeDeviceState.devicesState.query ? t('hy.searching') : t('hy.waiting_data'));
                _scheduleSmarthomeLoadRetry();
                return;
            }
            _setDevicesError('Nu exista entitati de afisat. Activeaza o integrare in Configurari > Integrari.');
            _updateStats();
            return;
        }

        if (smarthomeDeviceState.smarthomeLoadRetryTimer) {
            clearTimeout(smarthomeDeviceState.smarthomeLoadRetryTimer);
            smarthomeDeviceState.smarthomeLoadRetryTimer = null;
        }
        _updateStats();
        renderDeviceCards();
        // Live updates so state changes show without manual refresh.
        _connectSmarthomeLive();
    } catch (e) {
        if (smarthomeDeviceState.integrationEntitiesCache.length) {
            _updateStats();
            renderDeviceCards();
            return;
        }
        _setDevicesLoading(smarthomeDeviceState.devicesState.query ? t('hy.searching') : t('hy.waiting_data'));
        _scheduleSmarthomeLoadRetry();
    } finally {
        smarthomeDeviceState.smarthomeLoadPromise = null;
    } })();
    return smarthomeDeviceState.smarthomeLoadPromise;
}

// ── Live entity-state updates (shared integrations WS hub) ───────────────
let _smarthomeLiveUnsub: (() => void) | null = null;
let _smarthomeCacheRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function _ensureSmarthomeLiveSubscription(): void {
    if (smarthomeDeviceState.liveUnsub) return;
    initIntegrationsLiveWs({ apiCall });
    smarthomeDeviceState.liveUnsub = subscribeIntegrationsLive({
        id: 'smarthome',
        isActive: () => {
            const view = document.getElementById('view-smarthome');
            return !!(view && !view.classList.contains('hidden'));
        },
        onItems: (items, isSnapshot) => _applySmarthomeLiveItems(items as SmarthomeEntity[], isSnapshot),
        onRemoved: _removeSmarthomeLiveItems,
    });
}

function _connectSmarthomeLive(): void {
    _ensureSmarthomeLiveSubscription();
    refreshIntegrationsLiveConnection();
}

export function disconnectSmarthomeLive(): void {
    refreshIntegrationsLiveConnection();
}

function _applySmarthomeLiveItems(items: SmarthomeEntity[], isSnapshot: boolean) {
    if (!Array.isArray(smarthomeDeviceState.integrationEntitiesCache)) smarthomeDeviceState.integrationEntitiesCache = [];
    const idx = new Map();
    smarthomeDeviceState.integrationEntitiesCache.forEach((it, i) => idx.set(it.entity_id, i));

    let needsRerender = false;
    const patched = [];
    for (const item of items) {
        if (!item || !item.entity_id) continue;
        if (_shouldHoldOptimisticState(item.entity_id, item.state)) continue;
        const pos = idx.get(item.entity_id);
        if (pos == null) {
            // Brand-new entity (e.g. derived just added). Need full re-render
            // to show it in the list with proper row markup.
            smarthomeDeviceState.integrationEntitiesCache.push({
                entity_id: item.entity_id,
                name: item.entity_id,
                state: item.state,
                attributes: item.attributes || {},
                unit: item.unit || '',
                aliases: [],
                source: '',
            });
            idx.set(item.entity_id, smarthomeDeviceState.integrationEntitiesCache.length - 1);
            needsRerender = true;
        } else {
            const cur = smarthomeDeviceState.integrationEntitiesCache[pos];
            const stateChanged = cur.state !== item.state || cur.unit !== (item.unit || cur.unit);
            cur.state = item.state;
            cur.attributes = { ...(cur.attributes || {}), ...(item.attributes || {}) };
            if (item.unit) cur.unit = item.unit;
            if (stateChanged) patched.push(cur);
        }
    }

    // Patch visible rows in place — snapshot (WS reconnect) and diff alike.
    for (const d of patched) _patchRowInPlace(d);
    if (needsRerender) {
        _updateStats();
        renderDeviceCards();
    } else if (patched.length || isSnapshot) {
        _updateStats();
    }
}

function _shouldHoldOptimisticState(entityId: string, incomingState: unknown) {
    const guard = smarthomeDeviceState.deviceOptimisticGuards.get(entityId);
    if (!guard) return false;
    if (Date.now() > guard.until) {
        smarthomeDeviceState.deviceOptimisticGuards.delete(entityId);
        return false;
    }
    if (_norm(incomingState) === _norm(guard.state)) {
        smarthomeDeviceState.deviceOptimisticGuards.delete(entityId);
        return false;
    }
    return true;
}

function _removeSmarthomeLiveItems(entityIds: string[]) {
    if (!entityIds || !entityIds.length) return;
    const currentCount = Array.isArray(smarthomeDeviceState.integrationEntitiesCache) ? smarthomeDeviceState.integrationEntitiesCache.length : 0;
    if (currentCount && entityIds.length >= Math.max(10, Math.floor(currentCount * 0.8))) {
        console.warn('[hyve] ignoring suspicious mass entity removal', entityIds.length, 'of', currentCount);
        if (!smarthomeDeviceState.cacheRefreshTimer) {
            smarthomeDeviceState.cacheRefreshTimer = setTimeout(() => {
                smarthomeDeviceState.cacheRefreshTimer = null;
                loadSmarthome();
            }, 1500);
        }
        return;
    }
    const set = new Set(entityIds);
    let removed = 0;
    smarthomeDeviceState.integrationEntitiesCache = smarthomeDeviceState.integrationEntitiesCache.filter(d => {
        if (set.has(d.entity_id)) { removed++; return false; }
        return true;
    });
    if (removed) {
        if (smarthomeDeviceState.openEntityId && set.has(smarthomeDeviceState.openEntityId)) {
            smarthomeDeviceState.openEntityId = null;
        }
        if (smarthomeDeviceState.openDeviceKey
            && !_findDeviceGroupByKey(smarthomeDeviceState.openDeviceKey)
            && !_findDeviceGroupByKeyFallback(smarthomeDeviceState.openDeviceKey)) {
            if (!smarthomeDeviceState.cacheRefreshTimer) {
                smarthomeDeviceState.cacheRefreshTimer = setTimeout(() => {
                    smarthomeDeviceState.cacheRefreshTimer = null;
                    loadSmarthome({ force: true }).then(() => renderDeviceCards()).catch(() => {});
                }, 800);
            }
        }
        _updateStats();
        renderDeviceCards();
    }
}

// Patch a single visible row's state cell in place. Falls back silently if
// the row isn't currently rendered (e.g. filtered out).
export function _syncEntityToggleDom(entity: SmarthomeEntity) {
    const eid = String(entity.entity_id || '');
    if (!eid) return;
    const lower = _norm(entity.state);
    const isOn = _isActiveState(lower) || lower === 'on' || lower === 'true';
    const newAction = isOn ? 'turn_off' : 'turn_on';
    const btns = document.querySelectorAll(
        `button.app-toggle-switch[data-smarthome-entity-id="${CSS.escape(eid)}"], button.app-toggle-switch[data-entity-toggle="${CSS.escape(eid)}"]`,
    );
    for (const btn of btns) {
        if (!(btn instanceof HTMLElement)) continue;
        btn.setAttribute('aria-checked', String(isOn));
        btn.dataset.on = isOn ? 'true' : 'false';
        btn.dataset.smarthomeDeviceAction = newAction;
        btn.classList.remove('is-pending');
        btn.removeAttribute('aria-busy');
    }
}

function _patchRowInPlace(d: SmarthomeEntity) {
    const eid = d.entity_id;
    const stateLower = String(d.state).toLowerCase();
    const isOn = _isActiveState(stateLower) || stateLower === 'on' || stateLower === 'true';
    const isUnavail = ['unavailable', 'unknown', 'offline'].includes(stateLower);
    const dom = String(eid).split('.')[0] || '';
    const stateDisplay = isUnavail
        ? tState('unavailable')
        : entityStateForDisplay(dom, d.state, tState) + (d.unit ? ` ${d.unit}` : '');

    const row = document.querySelector(`.hyd-entity-row[data-entity="${CSS.escape(eid)}"]`);
    if (row) {
        const stateEl = row.querySelector('.hyd-entity-row__state');
        if (stateEl) stateEl.textContent = stateDisplay;
        row.classList.toggle('is-active', isOn);
        row.classList.toggle('is-offline', isUnavail);
    }
    const group = _findDeviceGroupByEntityId(eid);
    if (smarthomeDeviceState.openEntityId === eid) {
        const entity = smarthomeDeviceState.integrationEntitiesCache.find((x) => x.entity_id === eid);
        if (entity) {
            patchEntityDetailDom(entity);
            _syncEntityToggleDom(entity);
        }
    } else if (group && smarthomeDeviceState.openDeviceKey === group.device_key) {
        const synced = _syncDeviceGroupEntities(group);
        const primary = primaryDeviceEntity(synced);
        if (primary?.entity_id === eid) patchDeviceOverviewDom(synced);
    } else if (group) {
        const listRow = document.querySelector(`.hyd-row[data-device-key="${CSS.escape(group.device_key)}"]`);
        const readout = listRow?.querySelector('.hyd-row__state');
        if (readout) readout.textContent = stateDisplay;
    }

    // Entity rows inside the device detail modal (live state + toggle buttons)
    const modalStates = document.querySelectorAll(`[data-entity-state="${CSS.escape(eid)}"]`);
    for (const el of modalStates) {
        const tone = isOn ? 'text-accent' : (isUnavail ? 'text-slate-500' : 'text-slate-400');
        el.textContent = stateDisplay;
        el.classList.remove('text-accent', 'text-slate-400', 'text-slate-200', 'text-slate-500');
        el.classList.add(tone);
    }

    _syncEntityToggleDom(d);

    // Legacy pill toggles in integration modals (non app-toggle-switch)
    if (['switch', 'light', 'input_boolean'].includes(dom)) {
        const btns = document.querySelectorAll(`button[data-smarthome-entity-id="${CSS.escape(eid)}"][data-smarthome-device-action]:not(.app-toggle-switch)`);
        for (const btn of btns) {
            if (!btn.closest('#entity-detail-modal-body') && !btn.closest('[data-entity-list]')) continue;
            const newAction = isOn ? 'turn_off' : 'turn_on';
            btn.setAttribute('aria-checked', String(isOn));
            (btn as HTMLElement).dataset.smarthomeDeviceAction = newAction;
            btn.textContent = isOn ? 'ON' : 'OFF';
            btn.className = `px-3 py-1.5 rounded-full text-[11px] font-bold border transition-colors shrink-0 ${isOn ? 'bg-accent/20 border-accent/40 text-accent' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`;
        }
    }
}

export function _optimisticStateForAction(action: string, currentState: unknown, domain = '') {
    const state = _norm(currentState);
    const dom = String(domain || '').toLowerCase();
    const onActions: Record<string, string> = {
        turn_on: 'on', open_cover: 'open', unlock: 'unlocked', start: dom === 'lawn_mower' ? 'mowing' : 'cleaning', media_play: 'playing',
        start_mowing: 'mowing', pause: 'paused', return_to_base: 'returning',
    };
    const offActions: Record<string, string> = {
        turn_off: 'off', close_cover: 'closed', lock: 'locked', stop: 'off', media_pause: 'paused',
    };
    if (action === 'toggle') return _isActiveState(state) || state === 'on' ? 'off' : 'on';
    if (Object.prototype.hasOwnProperty.call(onActions, action)) return onActions[action];
    if (Object.prototype.hasOwnProperty.call(offActions, action)) return offActions[action];
    return currentState;
}

export function _markDeviceControlPending(entityId: string, pending: boolean) {
    if (!entityId || typeof document === 'undefined') return;
    const row = document.querySelector(`.hyd-entity-row[data-entity="${CSS.escape(entityId)}"]`);
    if (row) row.classList.toggle('is-control-pending', !!pending);
}

function _scrollDevicesViewTop() {
    const scroller = document.getElementById('view-smarthome');
    if (scroller) scroller.scrollTop = 0;
}

function _setDevicesViewMode(mode: 'list' | 'detail') {
    const stage = document.getElementById('hy-devices-stage');
    const listView = document.getElementById('hy-entity-list-view');
    const detailView = document.getElementById('hy-entity-detail-view');
    const wasDetail = stage?.classList.contains('hyd-stage--detail');
    const isDetail = mode === 'detail';
    stage?.classList.toggle('hyd-stage--detail', isDetail);
    listView?.classList.toggle('hidden', isDetail);
    detailView?.classList.toggle('hidden', !isDetail);
    if (isDetail && !wasDetail) _scrollDevicesViewTop();
}

function _updateStats() {
    const allGroups = _getAllDeviceGroups();
    const allEntities = _getAllEntities();
    const total = allGroups.length;
    const active = allGroups.filter((d) => deviceHasActiveEntity(d)).length;
    const aiSel = allEntities.filter((d) => d.selected).length;
    const el = (id: string, val: string | number) => { const e = document.getElementById(id); if (e) e.innerText = String(val); };
    el('hy-count', total);
    el('hy-active-count', active);
    el('hy-ai-count', `${aiSel}/${allEntities.length}`);
    el('hy-source-all-count', total);
    const tabs = document.getElementById('hy-entity-category-tabs');
    if (tabs) tabs.innerHTML = renderEntityCategoryTabs(smarthomeDeviceState.entityCategoryFilter);
}

function _getAllEntities() {
    return [...smarthomeDeviceState.integrationEntitiesCache];
}

function _getAllDevices() {
    return _getAllEntities();
}

function _getAllDeviceGroups(): PhysicalDeviceGroup[] {
    return groupEntitiesIntoDevices(smarthomeDeviceState.integrationEntitiesCache);
}

function _parseDeviceKey(key: string): { entryId: string; deviceId: string } | null {
    const idx = String(key || '').indexOf('::');
    if (idx < 0) return null;
    return { entryId: key.slice(0, idx), deviceId: key.slice(idx + 2) };
}

function _findDeviceGroupByKey(key: string): PhysicalDeviceGroup | null {
    return _getAllDeviceGroups().find((d) => d.device_key === key) || null;
}

/** Resolve device after rename/resync when device_key changed (e.g. fn:… friendly name). */
function _findDeviceGroupByKeyFallback(key: string): PhysicalDeviceGroup | null {
    const parsed = _parseDeviceKey(key);
    if (!parsed) return null;
    const groups = _getAllDeviceGroups().filter((d) => d.entry_id === parsed.entryId);
    const exact = groups.find((d) => d.device_id === parsed.deviceId);
    if (exact) return exact;
    if (parsed.deviceId.startsWith('fn:') && groups.length === 1) return groups[0];
    return null;
}

function _findDeviceGroupAfterRename(
    entryId: string,
    canonicalDeviceId: string,
    entityIds: string[],
    ieeeAddrs: Set<string>,
): PhysicalDeviceGroup | null {
    const groups = _getAllDeviceGroups();
    const byId = groups.find((d) => d.entry_id === entryId && d.device_id === canonicalDeviceId);
    if (byId) return byId;
    if (ieeeAddrs.size) {
        const byIeee = groups.find((d) => d.entry_id === entryId && (d.entities || []).some((e) => {
            const ieee = String((e.attributes as Record<string, unknown> | undefined)?.zigbee_ieee || '').trim();
            return ieee && ieeeAddrs.has(ieee);
        }));
        if (byIeee) return byIeee;
    }
    if (entityIds.length) {
        const idSet = new Set(entityIds);
        return groups.find((d) => (d.entities || []).some((e) => idSet.has(e.entity_id))) || null;
    }
    return null;
}

function _findDeviceGroupByEntityId(entityId: string): PhysicalDeviceGroup | null {
    return _getAllDeviceGroups().find((d) => (d.entities || []).some((e) => e.entity_id === entityId)) || null;
}

function _syncDeviceGroupEntities(group: PhysicalDeviceGroup): PhysicalDeviceGroup {
    const fresh = _findDeviceGroupByKey(group.device_key);
    return fresh || group;
}

function _getFilteredDeviceGroups() {
    _syncDevicesStateFromInputs();
    const sourceFilter = smarthomeDeviceState.devicesState.source;
    const areaFilter = smarthomeDeviceState.devicesState.area;
    const domainFilter = smarthomeDeviceState.devicesState.domain;
    const query = smarthomeDeviceState.devicesState.query;
    const filtered = _getAllDeviceGroups().filter((device) => {
        const ents = device.entities || [];
        if (!deviceMatchesCategory(device, smarthomeDeviceState.entityCategoryFilter)) return false;
        if (sourceFilter !== 'all' && !ents.some((e) => entityMatchesIntegration(e.source || '', sourceFilter))) return false;
        if (areaFilter !== 'all') {
            const area = _norm(device.area);
            if (areaFilter === '__none__') {
                if (area) return false;
            } else if (area !== areaFilter) return false;
        }
        if (domainFilter === 'active') {
            if (!deviceHasActiveEntity(device)) return false;
        } else if (domainFilter === 'ai') {
            if (!ents.some((e) => (e as SmarthomeEntity).selected)) return false;
        } else if (domainFilter !== 'all') {
            if (!ents.some((e) => {
                const domain = _entityDomain(e);
                if (domainFilter === 'sensor' && domain === 'binary_sensor') return true;
                return domain === domainFilter;
            })) return false;
        }
        if (query && !deviceSearchText(device).includes(query)) return false;
        return true;
    });

    const direction = smarthomeDeviceState.devicesState.sortDir === 'desc' ? -1 : 1;
    return filtered.sort((left, right) => {
        const sortKey = smarthomeDeviceState.devicesState.sortBy;
        let leftValue = '';
        let rightValue = '';
        if (sortKey === 'state') {
            leftValue = deviceHasActiveEntity(left) ? 'on' : 'off';
            rightValue = deviceHasActiveEntity(right) ? 'on' : 'off';
        } else if (sortKey === 'source') {
            leftValue = _norm(left.source_slug || left.entry_title);
            rightValue = _norm(right.source_slug || right.entry_title);
        } else {
            leftValue = _norm(left.name || left.device_id);
            rightValue = _norm(right.name || right.device_id);
        }
        return leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: 'base' }) * direction;
    });
}

export const SOURCE_ICONS: Record<string, SourceIconMeta> = {
    pago:           { icon: 'fa-credit-card',  color: 'text-emerald-400', label: 'Pago' },
    fusion_solar:   { icon: 'fa-solar-panel',  color: 'text-amber-400', label: 'Solar' },
    zigbee2mqtt:    { icon: 'fa-tower-broadcast', color: 'text-purple-400', label: 'Z2M' },
    derived:        { icon: 'fa-calculator',   color: 'text-pink-400',  label: 'Derived' },
};

export function patchOpenDetailForEntity(entity: SmarthomeEntity): boolean {
    return _patchOpenDetailForEntity(entity);
}

function _patchOpenDetailForEntity(entity: SmarthomeEntity): boolean {
    const eid = String(entity.entity_id || '');
    if (!eid) return false;
    if (smarthomeDeviceState.openEntityId === eid) {
        patchEntityDetailDom(entity);
        _syncEntityToggleDom(entity);
        return true;
    }
    if (smarthomeDeviceState.openDeviceKey) {
        const group = _findDeviceGroupByEntityId(eid);
        if (group && smarthomeDeviceState.openDeviceKey === group.device_key) {
            patchDeviceOverviewDom(_syncDeviceGroupEntities(group));
            _syncEntityToggleDom(entity);
            return true;
        }
    }
    return false;
}

function _detailShowsEntity(entityId: string): boolean {
    const detail = document.getElementById('hy-entity-detail-view');
    if (!detail || detail.classList.contains('hidden')) return false;
    return detail.querySelector(`[data-entity-detail-id="${CSS.escape(entityId)}"]`) != null;
}

function _detailShowsDevice(deviceKey: string): boolean {
    const detail = document.getElementById('hy-entity-detail-view');
    if (!detail || detail.classList.contains('hidden')) return false;
    return detail.querySelector(`[data-device-detail-key="${CSS.escape(deviceKey)}"]`) != null;
}

function _renderEntityDetailView(entity: SmarthomeEntity, options: { force?: boolean } = {}) {
    const detail = document.getElementById('hy-entity-detail-view');
    if (!detail) return;
    const eid = String(entity.entity_id || '');
    if (!options.force && _detailShowsEntity(eid)) {
        patchEntityDetailDom(entity);
        _syncEntityToggleDom(entity);
        return;
    }
    const prevRoot = detail.querySelector('[data-entity-detail-id]');
    const prevEid = prevRoot?.getAttribute('data-entity-detail-id') || '';
    const prevDomain = prevEid.includes('.') ? prevEid.split('.')[0] : '';
    const newDomain = eid.includes('.') ? eid.split('.')[0] : '';
    if (prevDomain === 'camera' || newDomain === 'camera') stopCameraPreviewRefresh();
    const slug = resolveEntityControlSlug(entity);
    const advanced = entity.source === 'derived' ? '' : renderEntityModal(entity, slug, { detailPage: true });
    detail.innerHTML = renderEntityDetailPage(entity, advanced, SOURCE_ICONS);
    wireEntityFriendlyNameEditor(detail, entity, {
        onUpdated: ({ name }) => {
            const idx = smarthomeDeviceState.integrationEntitiesCache.findIndex(
                (e) => e.entity_id === entity.entity_id,
            );
            if (idx >= 0) smarthomeDeviceState.integrationEntitiesCache[idx].name = name;
            smarthomeDeviceState.devicesVisibleEntityCache.set(entity.entity_id, entity);
        },
    });
    if (advanced) {
        wireEntityRegistryEditor(detail, entity, {
            onUpdated: ({ oldEntityId, newEntityId, uniqueId }) => {
                const idx = smarthomeDeviceState.integrationEntitiesCache.findIndex(
                    (e) => e.entity_id === oldEntityId || (uniqueId && e.unique_id === uniqueId),
                );
                if (idx >= 0) {
                    smarthomeDeviceState.integrationEntitiesCache[idx].entity_id = newEntityId;
                    smarthomeDeviceState.devicesVisibleEntityCache.delete(oldEntityId);
                    smarthomeDeviceState.devicesVisibleEntityCache.set(newEntityId, smarthomeDeviceState.integrationEntitiesCache[idx]);
                }
                smarthomeDeviceState.openEntityId = newEntityId;
                smarthomeModalState.haRowActionsEntityId = newEntityId;
                _renderEntityDetailView(smarthomeDeviceState.integrationEntitiesCache[idx], { force: true });
            },
        });
        bindCameraPreviewLoaders(detail);
        startCameraPreviewRefresh();
    }
}

function wireDeviceDetailNameEditor(container: ParentNode | null | undefined, device: PhysicalDeviceGroup) {
    if (!container || !canRenameIntegrationDevice(device)) return;
    const root = container.querySelector('[data-device-name-root]');
    if (!root) return;

    const viewWrap = root.querySelector('[data-device-name-view-wrap]');
    const panel = root.querySelector('[data-device-name-edit-panel]');
    const view = root.querySelector('[data-device-name-view]');
    const input = root.querySelector('[data-device-name-input]') as HTMLInputElement | null;
    const editBtn = root.querySelector('[data-device-name-edit]') as HTMLButtonElement | null;
    const saveBtn = root.querySelector('[data-device-name-save]') as HTMLButtonElement | null;
    const cancelBtn = root.querySelector('[data-device-name-cancel]') as HTMLButtonElement | null;

    const showView = () => {
        viewWrap?.classList.remove('hidden');
        panel?.classList.add('hidden');
    };
    const showEdit = () => {
        viewWrap?.classList.add('hidden');
        panel?.classList.remove('hidden');
        if (input) input.value = String(device.name || device.device_id || '');
        input?.focus();
        input?.select();
    };

    if (editBtn) editBtn.onclick = showEdit;
    if (cancelBtn) cancelBtn.onclick = showView;

    const submit = async () => {
        if (!input || saveBtn?.disabled) return;
        const slug = String(device.source_slug || '');
        const deviceId = String(device.device_id || '');
        const currentName = String(device.name || deviceId || '');
        const next = String(input.value || '').trim();
        if (!next || next === currentName) {
            showView();
            return;
        }
        if (saveBtn) saveBtn.disabled = true;
        const openKey = smarthomeDeviceState.openDeviceKey || device.device_key;
        const entryId = String(device.entry_id || '');
        const entityIds = (device.entities || []).map((e) => e.entity_id).filter(Boolean);
        const ieeeAddrs = new Set(
            (device.entities || [])
                .map((e) => String((e.attributes as Record<string, unknown> | undefined)?.zigbee_ieee || '').trim())
                .filter(Boolean),
        );
        try {
            const result = await renameIntegrationDevice(slug, deviceId, currentName, next, true, { skipDetailRefresh: true });
            device.name = next;
            if (view) view.textContent = next;
            showView();
            await loadSmarthome({ force: true });
            const canonicalId = String(result?.device_id || deviceId);
            let resolved = (openKey && _findDeviceGroupByKey(openKey))
                || _findDeviceGroupByKeyFallback(openKey)
                || _findDeviceGroupAfterRename(entryId, canonicalId, entityIds, ieeeAddrs);
            if (resolved) {
                smarthomeDeviceState.openDeviceKey = resolved.device_key;
                openDeviceDetail(resolved.device_key, { keepReturnContext: true });
            } else if (openKey) {
                smarthomeDeviceState.openDeviceKey = openKey;
                renderDeviceCards();
            }
        } catch (_) {
            /* toast handled in renameIntegrationDevice */
        } finally {
            if (saveBtn) saveBtn.disabled = false;
        }
    };

    if (saveBtn) saveBtn.onclick = () => { void submit(); };
    if (input) {
        input.onkeydown = (ev: KeyboardEvent) => {
            if (ev.key === 'Enter') { ev.preventDefault(); void submit(); }
            else if (ev.key === 'Escape') { ev.preventDefault(); showView(); }
        };
    }
}

function _renderDeviceDetailView(device: PhysicalDeviceGroup, options: { force?: boolean } = {}) {
    const detail = document.getElementById('hy-entity-detail-view');
    if (!detail) return;
    const synced = _syncDeviceGroupEntities(device);
    const key = String(synced.device_key || '');
    if (!options.force && _detailShowsDevice(key)) {
        patchDeviceOverviewDom(synced);
        return;
    }
    stopCameraPreviewRefresh();
    detail.innerHTML = renderDeviceDetailPage(synced, SOURCE_ICONS);
    wireDeviceDetailNameEditor(detail, synced);
}

export function openDeviceDetail(deviceKey: string, opts: { keepReturnContext?: boolean } = {}) {
    const key = String(deviceKey || '').trim();
    if (!key) return;
    if (!opts.keepReturnContext) {
        void import('../things/nav.js').then((m) => m.clearThingsReturnContext());
    }
    const device = _findDeviceGroupByKey(key);
    if (!device) return;
    smarthomeDeviceState.openDeviceKey = device.device_key;
    smarthomeDeviceState.openEntityId = null;
    smarthomeModalState.haRowActionsEntityId = null;
    renderDeviceCards();
}

export function closeDeviceDetail() {
    stopCameraPreviewRefresh();
    smarthomeDeviceState.openDeviceKey = null;
    smarthomeDeviceState.openEntityId = null;
    smarthomeModalState.haRowActionsEntityId = null;
    void _finishThingsDetailClose();
}

export function openEntityDetail(entityId: string, opts: { keepReturnContext?: boolean; skipDeviceParent?: boolean } = {}) {
    const entity = smarthomeDeviceState.integrationEntitiesCache.find((e) => e.entity_id === entityId)
        || smarthomeDeviceState.devicesVisibleEntityCache.get(entityId);
    if (!entity) return;
    if (!opts.keepReturnContext) {
        void import('../things/nav.js').then((m) => m.clearThingsReturnContext());
    }
    if (!opts.skipDeviceParent && !smarthomeDeviceState.openDeviceKey) {
        const group = _findDeviceGroupByEntityId(entityId);
        if (group) smarthomeDeviceState.openDeviceKey = group.device_key;
    }
    smarthomeDeviceState.openEntityId = entityId;
    smarthomeModalState.haRowActionsEntityId = entityId;
    renderDeviceCards();
}

export function closeEntityDetail() {
    stopCameraPreviewRefresh();
    smarthomeDeviceState.openEntityId = null;
    smarthomeModalState.haRowActionsEntityId = null;
    if (smarthomeDeviceState.openDeviceKey) {
        renderDeviceCards();
        return;
    }
    void _finishThingsDetailClose();
}

async function _finishThingsDetailClose() {
    const { getThingsReturnContext, restoreThingsReturnContext } = await import('../things/nav.js');
    if (getThingsReturnContext()) {
        await restoreThingsReturnContext();
    }
    renderDeviceCards();
}

export function filterEntityCategory(category: string) {
    smarthomeDeviceState.entityCategoryFilter = String(category || 'all').toLowerCase() || 'all';
    smarthomeDeviceState.devicesState.page = 1;
    _updateStats();
    renderDeviceCards();
}

export function renderDeviceCards() {
    const grid = document.getElementById('hy-entity-cards');
    const listView = document.getElementById('hy-entity-list-view');
    const detailView = document.getElementById('hy-entity-detail-view');
    if (!grid || !listView || !detailView) return;

    const openEntityId = smarthomeDeviceState.openEntityId;
    if (openEntityId) {
        const entity = smarthomeDeviceState.integrationEntitiesCache.find((e) => e.entity_id === openEntityId)
            || smarthomeDeviceState.devicesVisibleEntityCache.get(openEntityId);
        if (entity) {
            _setDevicesViewMode('detail');
            _renderEntityDetailView(entity);
            return;
        }
        if (smarthomeDeviceState.smarthomeLoadPromise || !smarthomeDeviceState.integrationEntitiesCache.length) {
            _renderDevicesDetailLoading();
            return;
        }
        smarthomeDeviceState.openEntityId = null;
    }

    const openDeviceKey = smarthomeDeviceState.openDeviceKey;
    if (openDeviceKey) {
        let device = _findDeviceGroupByKey(openDeviceKey);
        if (!device) {
            device = _findDeviceGroupByKeyFallback(openDeviceKey);
            if (device) smarthomeDeviceState.openDeviceKey = device.device_key;
        }
        if (device) {
            _setDevicesViewMode('detail');
            _renderDeviceDetailView(device);
            return;
        }
        if (smarthomeDeviceState.smarthomeLoadPromise
            || !smarthomeDeviceState.integrationEntitiesCache.length
            || smarthomeDeviceState.cacheRefreshTimer) {
            _renderDevicesDetailLoading();
            return;
        }
        smarthomeDeviceState.openDeviceKey = null;
    }

    stopCameraPreviewRefresh();
    _setDevicesViewMode('list');
    detailView.innerHTML = '';

    const devices = _getFilteredDeviceGroups();
    const pagination = document.getElementById('hy-devices-pagination');
    if (!devices.length) {
        const totalAll = _getAllDeviceGroups().length;
        if (!totalAll && smarthomeDeviceState.smarthomeLoadPromise) {
            _setDevicesLoading(smarthomeDeviceState.devicesState.query ? t('hy.searching') : t('hy.waiting_data'));
            return;
        }
        if (!totalAll && smarthomeDeviceState.devicesState.query) {
            _setDevicesLoading(t('hy.searching'));
            _scheduleSmarthomeLoadRetry();
            return;
        }
        const filtersActive = smarthomeDeviceState.devicesState.domain !== 'all'
            || smarthomeDeviceState.devicesState.source !== 'all'
            || smarthomeDeviceState.devicesState.area !== 'all'
            || smarthomeDeviceState.entityCategoryFilter !== 'all'
            || !!smarthomeDeviceState.devicesState.query;
        if (totalAll > 0 && filtersActive) {
            const msg = t('hy.empty_no_results');
            const reset = t('hy.reset_filters');
            grid.innerHTML = `<div class="hyd-list-placeholder">
                <i class="fas fa-filter-circle-xmark"></i>${escapeHtml(msg)}
                <button type="button" class="hy-btn hy-btn-ghost" data-smarthome-action="resetSmarthomeFilters"><i class="fas fa-rotate-left"></i>${escapeHtml(reset)}</button>
            </div>`;
        } else {
            grid.innerHTML = `<div class="hyd-list-placeholder"><i class="fas fa-plug"></i>${escapeHtml(t('hy.no_devices_found'))}</div>`;
        }
        if (pagination) pagination.innerHTML = '';
        return;
    }

    const totalPages = Math.max(1, Math.ceil(devices.length / smarthomeDeviceState.devicesState.pageSize));
    smarthomeDeviceState.devicesState.page = Math.min(Math.max(1, smarthomeDeviceState.devicesState.page), totalPages);
    const startIndex = (smarthomeDeviceState.devicesState.page - 1) * smarthomeDeviceState.devicesState.pageSize;
    const pageDevices = devices.slice(startIndex, startIndex + smarthomeDeviceState.devicesState.pageSize);
    const visibleEntities = pageDevices.flatMap((d) => d.entities || []);
    smarthomeDeviceState.devicesVisibleEntityCache = new Map(visibleEntities.map((entity) => [_entityId(entity), entity]));

    grid.innerHTML = pageDevices.map((device) => renderDeviceListCard(device, SOURCE_ICONS)).join('');
    _updateStats();
    if (pagination) {
        pagination.innerHTML = _renderDevicesPagination(
            devices.length,
            startIndex + 1,
            Math.min(startIndex + pageDevices.length, devices.length),
            totalPages,
        );
    }
}

function _renderDevicesPagination(total: number, from: number, to: number, totalPages: number) {
    const sizes = DEVICE_PAGE_SIZE_OPTIONS.map(size => `<option value="${size}" ${size === smarthomeDeviceState.devicesState.pageSize ? 'selected' : ''}>${size}</option>`).join('');
    return `<div class="hyd-pager__info">
            <span>${from}–${to}</span>
            <span>${escapeHtml(t('hy.pager_of'))}</span>
            <strong>${total}</strong>
        </div>
        <div class="hyd-pager__actions">
            <label class="hyd-pager__size"><span>${escapeHtml(t('hy.pager_rows'))}</span><select data-smarthome-change="setDevicesPageSize">${sizes}</select></label>
            <button type="button" class="hyd-pager__btn" data-smarthome-action="setDevicesPage" data-smarthome-page="${smarthomeDeviceState.devicesState.page - 1}" ${smarthomeDeviceState.devicesState.page <= 1 ? 'disabled' : ''} aria-label="${escapeHtmlAttr(t('common.prev_page'))}"><i class="fas fa-chevron-left"></i></button>
            <span class="hyd-pager__index">${smarthomeDeviceState.devicesState.page} / ${totalPages}</span>
            <button type="button" class="hyd-pager__btn" data-smarthome-action="setDevicesPage" data-smarthome-page="${smarthomeDeviceState.devicesState.page + 1}" ${smarthomeDeviceState.devicesState.page >= totalPages ? 'disabled' : ''} aria-label="${escapeHtmlAttr(t('common.next_page'))}"><i class="fas fa-chevron-right"></i></button>
        </div>`;
}

export function setDevicesPage(page: number) {
    const total = _getFilteredDeviceGroups().length;
    const totalPages = Math.max(1, Math.ceil(total / smarthomeDeviceState.devicesState.pageSize));
    smarthomeDeviceState.devicesState.page = Math.min(Math.max(1, Number(page) || 1), totalPages);
    renderDeviceCards();
}

export function setDevicesPageSize(value: string | number) {
    const next = Number(value);
    smarthomeDeviceState.devicesState.pageSize = DEVICE_PAGE_SIZE_OPTIONS.includes(next) ? next : 50;
    smarthomeDeviceState.devicesState.page = 1;
    renderDeviceCards();
}

export function sortDevicesBy(sortBy: string) {
    const nextSort = String(sortBy || 'name');
    if (smarthomeDeviceState.devicesState.sortBy === nextSort) {
        smarthomeDeviceState.devicesState.sortDir = smarthomeDeviceState.devicesState.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
        smarthomeDeviceState.devicesState.sortBy = nextSort;
        smarthomeDeviceState.devicesState.sortDir = 'asc';
    }
    smarthomeDeviceState.devicesState.page = 1;
    renderDeviceCards();
}

export function filterHAByDomain(domain: string) {
    smarthomeDeviceState.haCurrentFilter = domain;
    _syncDevicesStateFromInputs({ resetPage: true });
    _syncSmarthomeFilterPickers();
    renderDeviceCards();
}

export function filterHABySource(source: string) {
    smarthomeDeviceState.haCurrentSource = source;
    _syncDevicesStateFromInputs({ resetPage: true });
    _syncSmarthomeFilterPickers();
    renderDeviceCards();
}

export function filterHAByArea(area: string) {
    smarthomeDeviceState.haCurrentArea = area;
    _syncDevicesStateFromInputs({ resetPage: true });
    _syncSmarthomeFilterPickers();
    renderDeviceCards();
}

function _filterChoice(value: string, label: string, count: number | null = null): SmarthomeFilterChoice {
    return { value: String(value), label: String(label), count: Number.isFinite(count) ? count : null };
}

function _filterChoiceText(choice: SmarthomeFilterChoice) {
    const suffix = Number.isFinite(choice?.count) ? ` (${choice.count})` : '';
    return `${choice?.label || ''}${suffix}`;
}

function _filterPickerMarkup(id: string, label: string, icon: string, currentValue: string, choices: SmarthomeFilterChoice[], kind: string) {
    const list = Array.isArray(choices) ? choices : [];
    const selected = list.find(choice => choice.value === String(currentValue)) || list[0] || _filterChoice('all', t('hy.filter_all'));
    const options = list.map(choice => {
        const selectedAttr = choice.value === selected.value ? 'true' : 'false';
        const count = Number.isFinite(choice.count) ? `<span class="hy-picker-option-count">${choice.count}</span>` : '';
        return `<button type="button" role="option" class="hy-picker-option" data-filter-kind="${escapeHtmlAttr(kind)}" data-value="${escapeHtmlAttr(choice.value)}" data-label="${escapeHtmlAttr(_filterChoiceText(choice))}" data-selected="${selectedAttr}" aria-selected="${selectedAttr}" data-smarthome-action="selectPickerOption">
            <span class="hy-picker-option-label">${escapeHtml(choice.label)}</span>${count}
        </button>`;
    }).join('');
    return `<div class="hy-picker-field">
        <span class="hy-picker-label"><i class="fas ${escapeHtmlAttr(icon)}"></i>${escapeHtml(label)}</span>
        <div class="hy-picker" id="${escapeHtmlAttr(id)}" data-value="${escapeHtmlAttr(selected.value)}">
        <button type="button" class="hy-picker-button" data-hy-picker-toggle aria-haspopup="listbox" aria-expanded="false" data-smarthome-action="togglePicker">
            <span class="hy-picker-current">${escapeHtml(_filterChoiceText(selected))}</span>
            <i class="fas fa-chevron-down hy-picker-chevron" aria-hidden="true"></i>
        </button>
        <div class="hy-picker-menu" role="listbox">${options}</div>
        </div>
    </div>`;
}

export function _domainLabel(domain: string) {
    const key = String(domain || '').trim().toLowerCase();
    const mapped = DOMAIN_LABEL_KEYS[key];
    if (mapped) {
        const label = t(mapped);
        if (label !== mapped) return label;
    }
    const nested = t(`hy.domains.${key}`);
    if (nested !== `hy.domains.${key}`) return nested;
    return key.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()) || t('common.unknown');
}

function _domainCount(domain: string) {
    return smarthomeDeviceState.integrationEntitiesCache.filter(entity => {
        const dom = entity.domain || String(entity.entity_id || '').split('.')[0];
        return domain === 'sensor' ? (dom === 'sensor' || dom === 'binary_sensor') : dom === domain;
    }).length;
}

function _syncSmarthomeFilterPickers() {
    _syncSmarthomeFilterPicker('hy-source-picker', smarthomeDeviceState.haCurrentSource);
    _syncSmarthomeFilterPicker('hy-area-picker', smarthomeDeviceState.haCurrentArea);
    _syncSmarthomeFilterPicker('hy-domain-picker', smarthomeDeviceState.haCurrentFilter);
}

function _syncSmarthomeFilterPicker(id: string, value: string) {
    const picker = document.getElementById(id);
    if (!picker) return;
    const current = String(value || 'all');
    picker.dataset.value = current;
    const currentLabel = picker.querySelector('.hy-picker-current');
    let selectedLabel = '';
    picker.querySelectorAll('.hy-picker-option').forEach(option => {
        const opt = option as HTMLElement;
        const selected = opt.dataset.value === current;
        opt.dataset.selected = selected ? 'true' : 'false';
        opt.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (selected) selectedLabel = opt.dataset.label || opt.textContent?.trim() || '';
    });
    if (currentLabel && selectedLabel) currentLabel.textContent = selectedLabel;
}

function _closeSmarthomeFilterPickers(except: HTMLElement | null = null) {
    document.querySelectorAll('.hy-picker[data-open="true"]').forEach(picker => {
        const pickerEl = picker as HTMLElement;
        if (except && pickerEl === except) return;
        pickerEl.dataset.open = 'false';
        pickerEl.querySelector('[data-hy-picker-toggle]')?.setAttribute('aria-expanded', 'false');
    });
}

export function closeDevicePrimaryModal() {
    closeDevicePrimaryEntityModal();
}

export function selectDevicePrimaryEntity(deviceKey: string, entityId: string | null) {
    const key = String(deviceKey || '').trim();
    if (!key) return;
    setDevicePrimaryEntityOverride(key, entityId);
    closeDevicePrimaryEntityModal();
    if (smarthomeDeviceState.openDeviceKey === key) {
        const device = _findDeviceGroupByKey(key);
        if (device) _renderDeviceDetailView(_syncDeviceGroupEntities(device));
        return;
    }
    renderDeviceCards();
}

export function toggleSmarthomePicker(event: Event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const current = event.currentTarget as HTMLElement | null;
    const tgt = event.target as HTMLElement | null;
    const toggle = current?.matches?.('[data-hy-picker-toggle]')
        ? current
        : tgt?.closest?.('[data-hy-picker-toggle]') as HTMLElement | null;
    const picker = toggle?.closest?.('.hy-picker') as HTMLElement | null;
    if (!picker || !toggle) return;
    const open = picker.dataset.open === 'true';
    _closeSmarthomeFilterPickers(picker);
    picker.dataset.open = open ? 'false' : 'true';
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
}

export function selectSmarthomePickerOption(event: Event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const current = event.currentTarget as HTMLElement | null;
    const tgt = event.target as HTMLElement | null;
    const option = current?.matches?.('.hy-picker-option[data-filter-kind]')
        ? current
        : tgt?.closest?.('.hy-picker-option[data-filter-kind]') as HTMLElement | null;
    if (!option) return;
    const kind = option.dataset.filterKind;
    const value = option.dataset.value || 'all';
    _closeSmarthomeFilterPickers();
    if (kind === 'source') filterHABySource(value);
    else if (kind === 'area') filterHAByArea(value);
    else if (kind === 'domain') filterHAByDomain(value);
}

let _smarthomeFilterPickerEventsWired = false;
function _wireSmarthomeFilterPickerEvents() {
    if (smarthomeDeviceState.filterPickerEventsWired || typeof document === 'undefined') return;
    smarthomeDeviceState.filterPickerEventsWired = true;
    document.addEventListener('click', (event: MouseEvent) => {
        const tgt = event.target as HTMLElement | null;
        if (!tgt) return;
        if (tgt.closest('[data-smarthome-action="togglePicker"], [data-smarthome-action="selectPickerOption"]')) return;
        if (tgt.closest('[data-smarthome-action="selectDevicePrimaryEntity"]')) return;
        if (!tgt.closest('.hy-picker')) _closeSmarthomeFilterPickers();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            _closeSmarthomeFilterPickers();
            closeDevicePrimaryEntityModal();
        }
    });
}

function _buildSourceFilters(sources: SourceFilterMeta[]) {
    const nav = document.getElementById('hy-source-filters');
    if (!nav) return;
    const allCount = _getAllDevices().length;
    const choices = [_filterChoice('all', t('hy.filter_all_sources'), allCount)];

    for (const src of sources) {
        const count = smarthomeDeviceState.integrationEntitiesCache.filter(e => e.source === src.slug).length;
        if (count === 0) continue;
        choices.push(_filterChoice(src.slug, src.label, count));
    }
    nav.innerHTML = _filterPickerMarkup('hy-source-picker', t('hy.filter_integration'), 'fa-layer-group', smarthomeDeviceState.haCurrentSource, choices, 'source');
}

function _buildAreaFilters(areas: AreaFilterMeta[]) {
    const nav = document.getElementById('hy-area-filters');
    if (!nav) return;
    nav.classList.remove('hidden');
    const allLabel = t('hy.area_all');
    const noneLabel = t('hy.area_none');
    const noneCount = smarthomeDeviceState.integrationEntitiesCache.filter(e => !(e.area || '').trim()).length;
    const choices = [_filterChoice('all', allLabel, _getAllDevices().length)];
    for (const a of areas) {
        const name = a.name || '';
        if (!name) continue;
        choices.push(_filterChoice(name, name, a.count));
    }
    if (noneCount > 0) {
        choices.push(_filterChoice('__none__', noneLabel, noneCount));
    }
    nav.innerHTML = _filterPickerMarkup('hy-area-picker', t('hy.filter_area'), 'fa-map-location-dot', smarthomeDeviceState.haCurrentArea, choices, 'area');
}

function _buildDomainFilters() {
    const nav = document.getElementById('hy-domain-filters');
    if (!nav) return;
    const total = _getAllDevices().length;
    const active = _getAllDevices().filter(d => _isActiveState(String(d.state).toLowerCase())).length;
    const aiSelected = _getAllDevices().filter(d => d.selected).length;
    const domains = [...new Set(smarthomeDeviceState.integrationEntitiesCache.map(entity => entity.domain || String(entity.entity_id || '').split('.')[0]).filter(Boolean))]
        .sort((a, b) => {
            const ia = DOMAIN_ORDER.indexOf(a);
            const ib = DOMAIN_ORDER.indexOf(b);
            if (ia !== -1 || ib !== -1) return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
            return _domainLabel(a).localeCompare(_domainLabel(b));
        });
    const choices = [
        _filterChoice('all', t('hy.filter_all_entities'), total),
        _filterChoice('active', t('hy.filter_active_now'), active),
        _filterChoice('ai', t('hy.filter_in_ai'), aiSelected),
    ];
    domains.forEach(domain => {
        const count = _domainCount(domain);
        if (count > 0) choices.push(_filterChoice(domain, _domainLabel(domain), count));
    });
    nav.innerHTML = _filterPickerMarkup('hy-domain-picker', t('hy.filter_entity_type'), 'fa-shapes', smarthomeDeviceState.haCurrentFilter, choices, 'domain');
}

export function filterDevices() {
    _syncDevicesStateFromInputs({ resetPage: true });
    if (!smarthomeDeviceState.integrationEntitiesCache.length) {
        if (_restoreSmarthomeEntitySnapshot()) {
            renderDeviceCards();
            loadSmarthome().catch(() => {});
            return;
        }
        _setDevicesLoading(smarthomeDeviceState.devicesState.query ? t('hy.searching') : t('hy.waiting_data'));
        loadSmarthome().then(() => renderDeviceCards()).catch(() => {});
        return;
    }
    renderDeviceCards();
}

export function toggleSmarthomeFilters(forceOpen: boolean | null = null) {
    const toolbar = document.querySelector('.hy-sticky-toolbar') as HTMLElement | null;
    const toggle = document.getElementById('hy-mobile-filter-toggle');
    if (!toolbar) return;
    const nextOpen = forceOpen === null ? toolbar.dataset.filtersOpen !== 'true' : !!forceOpen;
    toolbar.dataset.filtersOpen = nextOpen ? 'true' : 'false';
    if (toggle) {
        toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
        toggle.dataset.active = nextOpen ? 'true' : 'false';
    }
    if (!nextOpen) _closeSmarthomeFilterPickers();
}

// Reset all smarthome filters (search, source, domain) to "all".
export function resetSmarthomeFilters() {
    smarthomeDeviceState.haCurrentFilter = 'all';
    smarthomeDeviceState.haCurrentSource = 'all';
    smarthomeDeviceState.haCurrentArea = 'all';
    smarthomeDeviceState.entityCategoryFilter = 'all';
    smarthomeDeviceState.openDeviceKey = null;
    smarthomeDeviceState.openEntityId = null;
    const search = document.getElementById('hy-search') as HTMLInputElement | null;
    if (search) search.value = '';
    _syncDevicesStateFromInputs({ resetPage: true });
    _syncSmarthomeFilterPickers();
    renderDeviceCards();
}

// Copy the currently-open row-actions entity_id to the clipboard.
export async function copyEntityIdFromRowActions() {
    if (!smarthomeModalState.haRowActionsEntityId) return;
    try {
        await navigator.clipboard.writeText(smarthomeModalState.haRowActionsEntityId);
        showToast(t('hy.copied'), 'success');
    } catch (e) {
        showToast(t('hy.clipboard_error'), 'error');
    }
}

export async function toggleSelection(eid: string, sel: boolean) {
    const item = Array.isArray(smarthomeDeviceState.integrationEntitiesCache)
        ? smarthomeDeviceState.integrationEntitiesCache.find(x => x.entity_id === eid)
        : null;
    const revertCheckbox = () => {
        const selEsc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(eid) : eid.replace(/"/g, '\\"');
        document.querySelectorAll(`input[data-smarthome-change="toggleSelection"][data-smarthome-entity-id="${selEsc}"]`)
            .forEach((cb) => { (cb as HTMLInputElement).checked = !sel; });
    };
    try {
        const body: { entity_id: string; selected: boolean; unique_id?: string } = { entity_id: eid, selected: !!sel };
        if (item?.unique_id) body.unique_id = item.unique_id;
        await apiCall('/api/integrations/entities/selection', {
            method: 'POST',
            body,
        });
        // Reflect change locally so the AI counter and "AI only" filter
        // update without a full reload.
        if (item) item.selected = !!sel;
    } catch {
        revertCheckbox();
        showToast(t('hy.network_error'), 'error');
    }
}

export async function toggleAllAI(checked: boolean) {
    const cache = Array.isArray(smarthomeDeviceState.integrationEntitiesCache) ? smarthomeDeviceState.integrationEntitiesCache : [];
    const visibleEids = smarthomeDeviceState.devicesVisibleEntityCache.size
        ? [...smarthomeDeviceState.devicesVisibleEntityCache.keys()]
        : cache.map((d) => d.entity_id);
    const visibleSet = new Set(visibleEids);
    const targets = cache.filter(d => visibleSet.has(d.entity_id) && d.source !== 'derived');
    if (!targets.length) return;
    try {
        await Promise.all(targets.map(d => {
            const body: { entity_id: string; selected: boolean; unique_id?: string } = { entity_id: d.entity_id, selected: !!checked };
            if (d.unique_id) body.unique_id = d.unique_id;
            return apiCall('/api/integrations/entities/selection', {
                method: 'POST',
                body,
            }).catch(() => null);
        }));
        targets.forEach((d) => { d.selected = !!checked; });
        _updateStats();
        if (smarthomeDeviceState.openEntityId) {
            const ent = smarthomeDeviceState.integrationEntitiesCache.find(
                (e) => e.entity_id === smarthomeDeviceState.openEntityId,
            );
            if (ent) patchEntityDetailDom(ent);
        }
    } catch {
        showToast(t('hy.network_error'), 'error');
    }
}

export async function syncHA() {
    loadSmarthome({ force: true });
}

/** Read-only view of cached integration entities (automation picker fallback). */
export function getIntegrationEntities() {
    return Array.isArray(smarthomeDeviceState.integrationEntitiesCache) ? smarthomeDeviceState.integrationEntitiesCache : [];
}
