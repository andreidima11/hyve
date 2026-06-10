import { apiCall } from './api.js';
import { initIntegrationsLiveWs, refreshIntegrationsLiveConnection, subscribeIntegrationsLive, } from './integrations_live_ws.js';
import { getCameraStreamToken, cameraProxyUrlSync, startCameraPreviewRefresh, stopCameraPreviewRefresh } from './camera_auth.js';
import { cameraLoaderMarkup, bindCameraPreviewLoaders } from './camera_loader.js';
import { t, tState, applyTranslations } from './lang/index.js';
import { escapeHtml, escapeHtmlAttr, showToast, debounce } from './utils.js';
import { cameraPreferWebmPlayer } from './camera_live.js';
import { renderEntityRegistrySection, wireEntityRegistryEditor } from './entity_renderers.js';
import { entityMatchesIntegration } from './integration_sources.js';
import { ACTIVE_STATES, CONTROLLABLE } from './entity_constants.js';
function _errMsg(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
function _isActiveState(state) {
    return ACTIVE_STATES.includes(state);
}
export { ACTIVE_STATES, CONTROLLABLE };
// --- SMART HOME (IoT) ---
let _haCurrentFilter = 'all';
let _haCurrentSource = 'all';
let _haCurrentArea = 'all';
let _integrationEntitiesCache = [];
let _devicesVisibleEntityCache = new Map();
let _smarthomeLoadPromise = null;
let _smarthomeLoadRetryTimer = null;
let _deviceControlPending = new Map();
let _deviceOptimisticGuards = new Map();
const DEVICES_ENTITY_CACHE_KEY = 'hyve.devices.entities.cache.v1';
const DEVICES_ENTITY_CACHE_TTL_MS = 10 * 60 * 1000;
const DEVICE_OPTIMISTIC_GUARD_MS = 3500;
const DEVICE_PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const _devicesState = {
    query: '',
    source: 'all',
    area: 'all',
    domain: 'all',
    page: 1,
    pageSize: 50,
    sortBy: 'name',
    sortDir: 'asc',
};
let _devicesShellMounted = false;
function _mountDevicesPageShell() {
    const host = document.querySelector('#view-smarthome .hy-page-inner');
    if (!host || document.getElementById('hy-devices-root'))
        return;
    _devicesShellMounted = true;
    host.innerHTML = `
        <div id="hy-devices-root" class="hy-devices-root">
            <header class="hy-devices-hero">
                <div class="hy-devices-heading-wrap">
                    <button type="button" data-smarthome-action="openConfigHub" class="hy-devices-back" data-i18n-title="hy.back" aria-label="Back">
                        <i class="fas fa-arrow-left"></i>
                    </button>
                    <div class="hy-devices-hero-copy">
                        <span class="hy-devices-kicker" data-i18n="hy.kicker">Hyve Devices</span>
                        <h1 data-i18n="nav.smarthome">Devices</h1>
                        <p data-i18n="hy.page_subtitle">Devices and entities</p>
                    </div>
                </div>
                <div class="hy-devices-hero-actions">
                    <button type="button" data-smarthome-action="syncSmartHome" class="hy-btn hy-btn-ghost" data-i18n-title="common.reload"><i class="fas fa-arrows-rotate"></i><span data-i18n="hy.sync_all">Sync</span></button>
                    <button type="button" data-smarthome-action="openDerivedModal" class="hy-btn hy-btn-primary" data-i18n-title="hy.add_derived_title"><i class="fas fa-wand-magic-sparkles"></i><span data-i18n="hy.add_derived">Derived</span></button>
                </div>
            </header>

            <section class="hy-devices-commandbar" data-i18n-aria-label="hy.device_tools_aria" aria-label="Device tools">
                <div class="hy-search-wrap hy-devices-search-wrap">
                    <i class="fas fa-magnifying-glass hy-search-icon" aria-hidden="true"></i>
                    <input type="search" id="hy-search" class="hy-search-input" data-i18n-placeholder="hy.search_placeholder" placeholder="Search..." autocomplete="off">
                </div>
                <button type="button" id="hy-mobile-filter-toggle" class="hy-mobile-filter-toggle" data-smarthome-action="toggleSmarthomeFilters" aria-controls="hy-filter-panel" aria-expanded="false" data-i18n-title="hy.filters">
                    <i class="fas fa-sliders" aria-hidden="true"></i>
                    <span data-i18n="hy.filters">Filters</span>
                </button>
            </section>

            <section class="hy-devices-statbar" aria-live="polite">
                <div><span data-i18n="hy.total_devices">Total</span><strong id="hy-count">--</strong></div>
                <div><span data-i18n="hy.active_now">Active</span><strong id="hy-active-count">--</strong></div>
                <div><span data-i18n="hy.ai_selected">AI</span><strong id="hy-ai-count">--</strong></div>
            </section>

            <section class="hy-sticky-toolbar" data-filters-open="false">
                <div class="hy-filter-panel" id="hy-filter-panel" data-i18n-aria-label="hy.filters_panel_aria" aria-label="Device filters">
                    <div class="hy-filter-picker-grid">
                        <div class="hy-filter-slot" id="hy-source-filters"></div>
                        <div class="hy-filter-slot" id="hy-area-filters"></div>
                        <div class="hy-filter-slot" id="hy-domain-filters"></div>
                        <button type="button" class="hy-filter-reset" data-smarthome-action="resetSmarthomeFilters" data-i18n-title="hy.reset_filters">
                            <i class="fas fa-rotate-left"></i>
                            <span data-i18n="hy.reset_filters">Reset filters</span>
                        </button>
                    </div>
                </div>
            </section>

            <section id="hy-cards-grid" class="hy-list-wrap hy-devices-table-shell">
                <div class="hy-table-header">
                    <div class="hy-devices-table-titlebar">
                        <h2 class="hy-table-caption" data-i18n="hy.list_title">Device list</h2>
                        <span id="hy-source-all-count" class="hy-devices-total-pill">--</span>
                    </div>
                    <table class="hy-list-table" data-i18n-aria-label="hy.table_aria" aria-label="Devices">
                        <thead>
                            <tr>
                                <th class="hy-col-bulk" aria-hidden="true"></th>
                                <th class="hy-col-icon" aria-hidden="true"></th>
                                <th class="hy-col-name"><button type="button" class="hy-th-sort" data-smarthome-action="sortDevices" data-smarthome-sort="name"><span data-i18n="hy.col_name">Name</span><i class="fas fa-sort"></i></button></th>
                                <th class="hy-col-alias" data-i18n="hy.col_alias">Alias</th>
                                <th class="hy-col-state"><button type="button" class="hy-th-sort" data-smarthome-action="sortDevices" data-smarthome-sort="state"><span data-i18n="hy.col_state">State</span><i class="fas fa-sort"></i></button></th>
                                <th class="hy-col-ai"><label class="inline-flex items-center gap-1.5 cursor-pointer select-none" data-i18n-title="hy.toggle_ai_all_title"><input type="checkbox" id="hy-ai-select-all" class="accent-accent cursor-pointer" data-smarthome-change="toggleAllAIVisible" data-i18n-aria-label="hy.toggle_ai_all_aria"><span data-i18n="hy.ai_selected">AI</span></label></th>
                            </tr>
                        </thead>
                        <tbody id="hy-list-tbody"></tbody>
                    </table>
                    <div id="hy-devices-pagination" class="hy-devices-pagination"></div>
                </div>
            </section>
        </div>`;
    applyTranslations();
    const searchInput = host.querySelector('#hy-search');
    if (searchInput && !searchInput.dataset.hySearchWired) {
        searchInput.dataset.hySearchWired = '1';
        searchInput.addEventListener('input', debounce(filterDevices, 160));
    }
}
function _setDevicesLoading(message = t('integrations.loading_devices')) {
    const tbody = document.getElementById('hy-list-tbody');
    const pagination = document.getElementById('hy-devices-pagination');
    if (tbody)
        tbody.innerHTML = `<tr><td colspan="6" class="hy-list-placeholder"><i class="fas fa-circle-notch fa-spin mr-2"></i>${escapeHtml(message)}</td></tr>`;
    if (pagination)
        pagination.innerHTML = '';
}
function _setDevicesError(message) {
    const tbody = document.getElementById('hy-list-tbody');
    const pagination = document.getElementById('hy-devices-pagination');
    if (tbody)
        tbody.innerHTML = `<tr><td colspan="6" class="hy-list-placeholder hy-list-error">
        <i class="fas fa-triangle-exclamation mr-2"></i>${escapeHtml(message || t('integrations.devices_load_error'))}
        <button type="button" class="ml-3 text-accent hover:underline text-xs font-semibold" data-smarthome-action="syncSmartHome"><i class="fas fa-arrows-rotate mr-1"></i>${escapeHtml(t('integrations.retry'))}</button>
    </td></tr>`;
    if (pagination)
        pagination.innerHTML = '';
}
async function _apiCallWithTimeout(url, options = {}, timeoutMs = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await apiCall(url, { ...options, signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
const DOMAIN_ICONS = {
    light: 'fa-lightbulb', switch: 'fa-toggle-on', script: 'fa-play',
    input_boolean: 'fa-toggle-on', cover: 'fa-door-open', lock: 'fa-lock',
    sensor: 'fa-gauge', binary_sensor: 'fa-circle-dot', climate: 'fa-temperature-half',
    media_player: 'fa-music', vacuum: 'fa-robot', weather: 'fa-cloud-sun',
    person: 'fa-user', image: 'fa-image', camera: 'fa-video'
};
const DOMAIN_COLORS = {
    light: 'bg-yellow-500/15 text-yellow-400', switch: 'bg-blue-500/15 text-blue-400',
    script: 'bg-emerald-500/15 text-emerald-400', input_boolean: 'bg-blue-500/15 text-blue-400',
    cover: 'bg-orange-500/15 text-orange-400', lock: 'bg-red-500/15 text-red-400',
    sensor: 'bg-cyan-500/15 text-cyan-400', binary_sensor: 'bg-teal-500/15 text-teal-400',
    climate: 'bg-rose-500/15 text-rose-400', media_player: 'bg-purple-500/15 text-purple-400',
    vacuum: 'bg-indigo-500/15 text-indigo-400', weather: 'bg-sky-500/15 text-sky-400',
    person: 'bg-slate-500/15 text-slate-400',
    image: 'bg-violet-500/15 text-violet-400', camera: 'bg-sky-500/15 text-sky-400'
};
const DOMAIN_LABEL_KEYS = {
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
    'media_player', 'camera', 'image', 'vacuum', 'weather', 'person', 'number', 'select',
    'button', 'script', 'input_boolean',
];
// Normalize an icon spec into a usable CSS class. Mirrors dashboard.js _iconClass
// so smarthome rows accept the same syntaxes (mdi:*, fa-*, fas fa-*, mdi-*).
function _iconClass(spec) {
    const raw = String(spec || '').trim();
    if (!raw)
        return '';
    if (raw.startsWith('mdi:'))
        return `mdi mdi-${raw.slice(4)}`;
    if (/^mdi(\s|-)/.test(raw))
        return raw.startsWith('mdi-') ? `mdi ${raw}` : raw;
    if (/\bfa[srlbd]?\b/.test(raw))
        return raw;
    if (raw.startsWith('fa-'))
        return `fas ${raw}`;
    return raw;
}
function _norm(value) {
    return String(value ?? '').trim().toLowerCase();
}
function _entityId(entity) {
    return String(entity?.entity_id || '');
}
function _entityDomain(entity) {
    const eid = _entityId(entity);
    return _norm(entity?.domain || eid.split('.')[0] || 'unknown');
}
function _entityAliases(entity) {
    return Array.isArray(entity?.aliases) ? entity.aliases : [];
}
function _syncDevicesStateFromInputs({ resetPage = false } = {}) {
    _devicesState.query = _norm(document.getElementById('hy-search')?.value || '');
    _devicesState.source = _norm(_haCurrentSource || 'all') || 'all';
    _devicesState.area = _norm(_haCurrentArea || 'all') || 'all';
    _devicesState.domain = _norm(_haCurrentFilter || 'all') || 'all';
    if (resetPage)
        _devicesState.page = 1;
}
function _deriveSourcesFromEntities(entities) {
    const sources = new Map();
    for (const entity of Array.isArray(entities) ? entities : []) {
        const slug = String(entity?.source || '').trim();
        if (!slug || sources.has(slug))
            continue;
        const meta = SOURCE_ICONS[slug] || null;
        sources.set(slug, {
            slug,
            label: meta?.label || entity.entry_title || slug.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()),
        });
    }
    return [...sources.values()];
}
function _deriveAreasFromEntities(entities) {
    const areas = new Map();
    for (const entity of Array.isArray(entities) ? entities : []) {
        const name = String(entity?.area || '').trim();
        if (!name)
            continue;
        areas.set(name, (areas.get(name) || 0) + 1);
    }
    return [...areas.entries()]
        .sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
        .map(([name, count]) => ({ name, count }));
}
function _rebuildSmarthomeFilters(sources = null, areas = null) {
    _buildSourceFilters(Array.isArray(sources) ? sources : _deriveSourcesFromEntities(_integrationEntitiesCache));
    _buildAreaFilters(Array.isArray(areas) ? areas : _deriveAreasFromEntities(_integrationEntitiesCache));
    _buildDomainFilters();
    _syncSmarthomeFilterPickers();
}
function _saveSmarthomeEntitySnapshot(entities, meta = {}) {
    if (!Array.isArray(entities) || !entities.length || typeof localStorage === 'undefined')
        return;
    try {
        localStorage.setItem(DEVICES_ENTITY_CACHE_KEY, JSON.stringify({
            ts: Date.now(),
            entities,
            sources: Array.isArray(meta.sources) ? meta.sources : _deriveSourcesFromEntities(entities),
            areas: Array.isArray(meta.areas) ? meta.areas : _deriveAreasFromEntities(entities),
        }));
    }
    catch (_) { }
}
function _restoreSmarthomeEntitySnapshot() {
    if (_integrationEntitiesCache.length || typeof localStorage === 'undefined')
        return false;
    try {
        const raw = localStorage.getItem(DEVICES_ENTITY_CACHE_KEY);
        if (!raw)
            return false;
        const data = JSON.parse(raw);
        if (!data || !Array.isArray(data.entities) || !data.entities.length)
            return false;
        if (Date.now() - Number(data.ts || 0) > DEVICES_ENTITY_CACHE_TTL_MS)
            return false;
        _integrationEntitiesCache = data.entities;
        _rebuildSmarthomeFilters(data.sources, data.areas);
        _updateStats();
        return true;
    }
    catch (_) {
        return false;
    }
}
function _scheduleSmarthomeLoadRetry(delayMs = 1500) {
    if (_smarthomeLoadRetryTimer)
        return;
    _smarthomeLoadRetryTimer = setTimeout(() => {
        _smarthomeLoadRetryTimer = null;
        const view = document.getElementById('view-smarthome');
        if (!view || view.classList.contains('hidden') || _integrationEntitiesCache.length)
            return;
        loadSmarthome({ force: true }).catch(() => { });
    }, delayMs);
}
function _deviceSearchText(entity) {
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
export async function loadSmarthome(options = {}) {
    getCameraStreamToken().catch(() => { });
    const force = !!options?.force;
    if (_smarthomeLoadPromise && !force)
        return _smarthomeLoadPromise;
    _mountDevicesPageShell();
    const grid = document.getElementById('hy-cards-grid');
    if (!grid)
        return;
    _wireSmarthomeFilterPickerEvents();
    const restoredSnapshot = _restoreSmarthomeEntitySnapshot();
    if (restoredSnapshot)
        renderDeviceCards();
    else if (!_integrationEntitiesCache.length)
        _setDevicesLoading();
    _smarthomeLoadPromise = (async () => {
        try {
            const resIntegrations = await _apiCallWithTimeout('/api/integrations/all-entities', {}, 20000).catch((err) => {
                console.warn('[hyve] devices load failed', err);
                return null;
            });
            // Don't wipe the cache before we have new data — if the API fails or
            // is slow, the user can still search through whatever was loaded
            // previously instead of seeing "no devices found".
            let nextEntities = null;
            let intData = null;
            if (resIntegrations && resIntegrations.ok) {
                try {
                    intData = await resIntegrations.json();
                }
                catch (_) {
                    intData = null;
                }
                if (intData && Array.isArray(intData.entities)) {
                    nextEntities = intData.entities;
                }
            }
            if (nextEntities) {
                if (nextEntities.length) {
                    _integrationEntitiesCache = nextEntities;
                    _saveSmarthomeEntitySnapshot(nextEntities, intData || {});
                    _rebuildSmarthomeFilters((intData && intData.sources) || null, (intData && intData.areas) || null);
                }
                else if (_integrationEntitiesCache.length) {
                    console.warn('[hyve] devices load returned an empty entity list; keeping last good cache');
                }
            }
            if (!_integrationEntitiesCache.length) {
                const shouldRetry = !nextEntities || !!_devicesState.query;
                if (shouldRetry) {
                    _setDevicesLoading(_devicesState.query ? t('hy.searching') : t('hy.waiting_data'));
                    _scheduleSmarthomeLoadRetry();
                    return;
                }
                _setDevicesError('Nu exista entitati de afisat. Activeaza o integrare in Configurari > Integrari.');
                _updateStats();
                return;
            }
            if (_smarthomeLoadRetryTimer) {
                clearTimeout(_smarthomeLoadRetryTimer);
                _smarthomeLoadRetryTimer = null;
            }
            _updateStats();
            renderDeviceCards();
            // Live updates so state changes show without manual refresh.
            _connectSmarthomeLive();
        }
        catch (e) {
            if (_integrationEntitiesCache.length) {
                _updateStats();
                renderDeviceCards();
                return;
            }
            _setDevicesLoading(_devicesState.query ? t('hy.searching') : t('hy.waiting_data'));
            _scheduleSmarthomeLoadRetry();
        }
        finally {
            _smarthomeLoadPromise = null;
        }
    })();
    return _smarthomeLoadPromise;
}
// ── Live entity-state updates (shared integrations WS hub) ───────────────
let _smarthomeLiveUnsub = null;
let _smarthomeCacheRefreshTimer = null;
function _ensureSmarthomeLiveSubscription() {
    if (_smarthomeLiveUnsub)
        return;
    initIntegrationsLiveWs({ apiCall });
    _smarthomeLiveUnsub = subscribeIntegrationsLive({
        id: 'smarthome',
        isActive: () => {
            const view = document.getElementById('view-smarthome');
            return !!(view && !view.classList.contains('hidden'));
        },
        onItems: (items, isSnapshot) => _applySmarthomeLiveItems(items, isSnapshot),
        onRemoved: _removeSmarthomeLiveItems,
    });
}
function _connectSmarthomeLive() {
    _ensureSmarthomeLiveSubscription();
    refreshIntegrationsLiveConnection();
}
export function disconnectSmarthomeLive() {
    refreshIntegrationsLiveConnection();
}
function _applySmarthomeLiveItems(items, isSnapshot) {
    if (!Array.isArray(_integrationEntitiesCache))
        _integrationEntitiesCache = [];
    const idx = new Map();
    _integrationEntitiesCache.forEach((it, i) => idx.set(it.entity_id, i));
    let needsRerender = false;
    const patched = [];
    for (const item of items) {
        if (!item || !item.entity_id)
            continue;
        if (_shouldHoldOptimisticState(item.entity_id, item.state))
            continue;
        const pos = idx.get(item.entity_id);
        if (pos == null) {
            // Brand-new entity (e.g. derived just added). Need full re-render
            // to show it in the list with proper row markup.
            _integrationEntitiesCache.push({
                entity_id: item.entity_id,
                name: item.entity_id,
                state: item.state,
                attributes: item.attributes || {},
                unit: item.unit || '',
                aliases: [],
                source: '',
            });
            idx.set(item.entity_id, _integrationEntitiesCache.length - 1);
            needsRerender = true;
        }
        else {
            const cur = _integrationEntitiesCache[pos];
            const stateChanged = cur.state !== item.state || cur.unit !== (item.unit || cur.unit);
            cur.state = item.state;
            cur.attributes = { ...(cur.attributes || {}), ...(item.attributes || {}) };
            if (item.unit)
                cur.unit = item.unit;
            if (stateChanged)
                patched.push(cur);
        }
    }
    // Patch visible rows in place — snapshot (WS reconnect) and diff alike.
    for (const d of patched)
        _patchRowInPlace(d);
    if (needsRerender) {
        _updateStats();
        renderDeviceCards();
    }
    else if (patched.length || isSnapshot) {
        _updateStats();
    }
}
function _shouldHoldOptimisticState(entityId, incomingState) {
    const guard = _deviceOptimisticGuards.get(entityId);
    if (!guard)
        return false;
    if (Date.now() > guard.until) {
        _deviceOptimisticGuards.delete(entityId);
        return false;
    }
    if (_norm(incomingState) === _norm(guard.state)) {
        _deviceOptimisticGuards.delete(entityId);
        return false;
    }
    return true;
}
function _removeSmarthomeLiveItems(entityIds) {
    if (!entityIds || !entityIds.length)
        return;
    const currentCount = Array.isArray(_integrationEntitiesCache) ? _integrationEntitiesCache.length : 0;
    if (currentCount && entityIds.length >= Math.max(10, Math.floor(currentCount * 0.8))) {
        console.warn('[hyve] ignoring suspicious mass entity removal', entityIds.length, 'of', currentCount);
        if (!_smarthomeCacheRefreshTimer) {
            _smarthomeCacheRefreshTimer = setTimeout(() => {
                _smarthomeCacheRefreshTimer = null;
                loadSmarthome();
            }, 1500);
        }
        return;
    }
    const set = new Set(entityIds);
    let removed = 0;
    _integrationEntitiesCache = _integrationEntitiesCache.filter(d => {
        if (set.has(d.entity_id)) {
            removed++;
            return false;
        }
        return true;
    });
    if (removed) {
        for (const eid of entityIds) {
            const row = document.querySelector(`#hy-list-tbody tr[data-entity="${CSS.escape(eid)}"]`);
            if (row)
                row.remove();
        }
        _updateStats();
    }
}
// Patch a single visible row's state cell in place. Falls back silently if
// the row isn't currently rendered (e.g. filtered out).
function _patchRowInPlace(d) {
    const eid = d.entity_id;
    const stateLower = String(d.state).toLowerCase();
    const isOn = _isActiveState(stateLower);
    const isOff = ['off', 'closed', 'locked', 'idle', 'docked', 'paused'].includes(stateLower);
    const isUnavail = ['unavailable', 'unknown', 'offline'].includes(stateLower);
    const stateDisplay = isUnavail ? 'Offline' : `${d.state}${d.unit ? ' ' + d.unit : ''}`;
    // Main list row
    const row = document.querySelector(`#hy-list-tbody tr[data-entity="${CSS.escape(eid)}"]`);
    if (row) {
        const stateEl = row.querySelector('.hy-row-state');
        if (stateEl) {
            stateEl.textContent = stateDisplay;
            stateEl.classList.remove('text-red-500/70', 'text-accent', 'text-slate-400');
            stateEl.classList.add(isUnavail ? 'text-red-500/70' : (isOn ? 'text-accent' : 'text-slate-400'));
        }
        row.classList.toggle('hy-row-unavailable', isUnavail);
        row.classList.remove('hy-row-flash');
        void row.offsetWidth;
        row.classList.add('hy-row-flash');
    }
    // Entity rows inside the device detail modal (live state + toggle buttons)
    const modalStates = document.querySelectorAll(`[data-entity-state="${CSS.escape(eid)}"]`);
    for (const el of modalStates) {
        const tone = isOn ? 'text-accent' : (isOff ? 'text-slate-400' : 'text-slate-200');
        el.textContent = `${d.state}${d.unit ? ' ' + d.unit : ''}`;
        el.classList.remove('text-accent', 'text-slate-400', 'text-slate-200');
        el.classList.add(tone);
    }
    // Update toggle buttons inside the modal for this entity
    const dom = String(eid).split('.')[0] || '';
    if (['switch', 'light', 'input_boolean'].includes(dom)) {
        const btns = document.querySelectorAll(`button[data-smarthome-entity-id="${CSS.escape(eid)}"][data-smarthome-device-action]`);
        for (const btn of btns) {
            if (!btn.closest('#entity-detail-modal-body') && !btn.closest('[data-entity-list]'))
                continue;
            const newAction = isOn ? 'turn_off' : 'turn_on';
            btn.setAttribute('aria-checked', String(isOn));
            btn.dataset.smarthomeDeviceAction = newAction;
            btn.textContent = isOn ? 'ON' : 'OFF';
            btn.className = `px-3 py-1.5 rounded-full text-[11px] font-bold border transition-colors shrink-0 ${isOn ? 'bg-accent/20 border-accent/40 text-accent' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}`;
        }
    }
}
function _optimisticStateForAction(action, currentState) {
    const state = _norm(currentState);
    const onActions = {
        turn_on: 'on', open_cover: 'open', unlock: 'unlocked', start: 'cleaning', media_play: 'playing',
    };
    const offActions = {
        turn_off: 'off', close_cover: 'closed', lock: 'locked', stop: 'off', media_pause: 'paused',
    };
    if (action === 'toggle')
        return _isActiveState(state) || state === 'on' ? 'off' : 'on';
    if (Object.prototype.hasOwnProperty.call(onActions, action))
        return onActions[action];
    if (Object.prototype.hasOwnProperty.call(offActions, action))
        return offActions[action];
    return currentState;
}
function _markDeviceControlPending(entityId, pending) {
    if (!entityId || typeof document === 'undefined')
        return;
    const row = document.querySelector(`#hy-list-tbody tr[data-entity="${CSS.escape(entityId)}"]`);
    if (row) {
        row.classList.toggle('hy-row-control-pending', !!pending);
        row.querySelector('.hy-row-state-wrap')?.classList.toggle('is-pending', !!pending);
    }
}
function _updateStats() {
    const allDevices = _getAllDevices();
    const total = allDevices.length;
    const active = allDevices.filter(d => _isActiveState(String(d.state).toLowerCase())).length;
    const aiSel = allDevices.filter(d => d.selected).length;
    const el = (id, val) => { const e = document.getElementById(id); if (e)
        e.innerText = String(val); };
    el('hy-count', total);
    el('hy-active-count', active);
    el('hy-ai-count', `${aiSel}/${total}`);
    el('hy-source-all-count', total);
}
function _getAllDevices() {
    return [..._integrationEntitiesCache];
}
function _getFilteredDevices() {
    _syncDevicesStateFromInputs();
    const allDevices = _getAllDevices();
    const sourceFilter = _devicesState.source;
    const areaFilter = _devicesState.area;
    const domainFilter = _devicesState.domain;
    const query = _devicesState.query;
    const filtered = allDevices.filter(entity => {
        if (!entity || typeof entity !== 'object')
            return false;
        // Source filter
        if (sourceFilter !== 'all') {
            if (!entityMatchesIntegration(entity.source || '', sourceFilter))
                return false;
        }
        // Area filter
        if (areaFilter !== 'all') {
            if (areaFilter === '__none__') {
                if (String(entity.area || '').trim())
                    return false;
            }
            else if (_norm(entity.area) !== areaFilter) {
                return false;
            }
        }
        if (domainFilter === 'active') {
            if (!_isActiveState(_norm(entity.state)))
                return false;
        }
        else if (domainFilter === 'ai') {
            if (!entity.selected)
                return false;
        }
        else if (domainFilter !== 'all') {
            const domain = _entityDomain(entity);
            if (domainFilter === 'sensor' && domain === 'binary_sensor') { /* include */ }
            else if (domain !== domainFilter)
                return false;
        }
        if (query) {
            if (!_deviceSearchText(entity).includes(query))
                return false;
        }
        return true;
    });
    const direction = _devicesState.sortDir === 'desc' ? -1 : 1;
    return filtered.sort((leftEntity, rightEntity) => {
        const sortKey = _devicesState.sortBy;
        let leftValue = '';
        let rightValue = '';
        if (sortKey === 'state') {
            leftValue = _norm(leftEntity.state);
            rightValue = _norm(rightEntity.state);
        }
        else if (sortKey === 'domain') {
            leftValue = _entityDomain(leftEntity);
            rightValue = _entityDomain(rightEntity);
        }
        else if (sortKey === 'source') {
            leftValue = _norm(leftEntity.source);
            rightValue = _norm(rightEntity.source);
        }
        else {
            leftValue = _norm(leftEntity.name || leftEntity.entity_id);
            rightValue = _norm(rightEntity.name || rightEntity.entity_id);
        }
        return leftValue.localeCompare(rightValue, undefined, { numeric: true, sensitivity: 'base' }) * direction;
    });
}
let _haBulkMode = false;
export function toggleHABulkMode() {
    const wrap = document.querySelector('.hy-list-wrap');
    const btn = document.getElementById('hy-bulk-mode-btn');
    if (!wrap || !btn)
        return;
    _haBulkMode = !_haBulkMode;
    wrap.classList.toggle('hy-bulk-mode', _haBulkMode);
    if (!_haBulkMode) {
        document.querySelectorAll('.hy-bulk-check').forEach(cb => { cb.checked = false; });
        const allCheck = document.getElementById('hy-select-all');
        if (allCheck)
            allCheck.checked = false;
        updateHABulkCount();
    }
    btn.classList.toggle('active', _haBulkMode);
    btn.querySelector('span').textContent = _haBulkMode ? (t('hy.cancel')) : (t('hy.select'));
}
const SOURCE_ICONS = {
    pago: { icon: 'fa-credit-card', color: 'text-emerald-400', label: 'Pago' },
    fusion_solar: { icon: 'fa-solar-panel', color: 'text-amber-400', label: 'Solar' },
    zigbee2mqtt: { icon: 'fa-tower-broadcast', color: 'text-purple-400', label: 'Z2M' },
    derived: { icon: 'fa-calculator', color: 'text-pink-400', label: 'Derived' },
};
function renderDeviceCards() {
    const tbody = document.getElementById('hy-list-tbody');
    if (!tbody)
        return;
    const devices = _getFilteredDevices();
    const pagination = document.getElementById('hy-devices-pagination');
    if (!devices.length) {
        const totalAll = _getAllDevices().length;
        if (!totalAll && _smarthomeLoadPromise) {
            _setDevicesLoading(_devicesState.query ? t('hy.searching') : t('hy.waiting_data'));
            return;
        }
        if (!totalAll && _devicesState.query) {
            _setDevicesLoading(t('hy.searching'));
            _scheduleSmarthomeLoadRetry();
            return;
        }
        const filtersActive = _devicesState.domain !== 'all' || _devicesState.source !== 'all' || _devicesState.area !== 'all' || !!_devicesState.query;
        if (totalAll > 0 && filtersActive) {
            const msg = t('hy.empty_no_results');
            const reset = t('hy.reset_filters');
            tbody.innerHTML = `<tr><td colspan="6" class="hy-list-placeholder">
                <i class="fas fa-filter-circle-xmark text-slate-600 mr-2"></i>${msg}
                <button type="button" class="ml-3 text-accent hover:underline text-xs font-semibold" data-smarthome-action="resetSmarthomeFilters"><i class="fas fa-rotate-left mr-1"></i>${reset}</button>
            </td></tr>`;
        }
        else {
            tbody.innerHTML = `<tr><td colspan="6" class="hy-list-placeholder"><i class="fas fa-plug text-slate-600 mr-2"></i>${t('hy.no_devices_found')}</td></tr>`;
        }
        if (pagination)
            pagination.innerHTML = '';
        updateHABulkCount();
        return;
    }
    const totalPages = Math.max(1, Math.ceil(devices.length / _devicesState.pageSize));
    _devicesState.page = Math.min(Math.max(1, _devicesState.page), totalPages);
    const startIndex = (_devicesState.page - 1) * _devicesState.pageSize;
    const pageDevices = devices.slice(startIndex, startIndex + _devicesState.pageSize);
    _devicesVisibleEntityCache = new Map(pageDevices.map(entity => [_entityId(entity), entity]));
    tbody.innerHTML = pageDevices.map(entity => {
        const source = entity.source || '';
        const isDerived = source === 'derived';
        const entityId = _entityId(entity);
        const domain = _entityDomain(entity);
        const stateLower = _norm(entity.state);
        const isOn = _isActiveState(stateLower);
        const isUnavail = ['unavailable', 'unknown', 'offline'].includes(stateLower);
        // Prefer entity-supplied icon (mdi:* or fa-*) over the domain default.
        const customIconCls = _iconClass(entity.icon);
        const fallbackIcon = isDerived ? 'fa-calculator' : (DOMAIN_ICONS[domain] || 'fa-microchip');
        const iconClass = customIconCls || `fas ${fallbackIcon}`;
        const color = isDerived ? 'bg-pink-500/15 text-pink-400' : (DOMAIN_COLORS[domain] || 'bg-slate-500/15 text-slate-400');
        const stateDisplay = isUnavail ? tState('unavailable') : `${entity.state ?? ''}${entity.unit ? ' ' + entity.unit : ''}`;
        const aliases = _entityAliases(entity);
        const aliasCount = aliases.length;
        const aliasBtnText = aliasCount === 0 ? t('hy.alias_add') : aliasCount === 1 ? t('hy.alias_1') : t('hy.alias_n', { count: aliasCount });
        const aliasStr = aliases.join(', ');
        const name = escapeHtml(entity.name || entityId);
        const escapedId = escapeHtml(entityId);
        const escapedIdAttr = escapeHtmlAttr(entityId);
        const srcMeta = SOURCE_ICONS[source] || null;
        const sourceLabel = srcMeta?.label || entity.entry_title || entity.source || 'Unknown';
        const sourceBadge = `<span class="hy-source-badge ${srcMeta?.color || 'text-slate-400'}"><i class="fas ${srcMeta?.icon || 'fa-puzzle-piece'}"></i>${escapeHtml(sourceLabel)}</span>`;
        const rowAction = isDerived
            ? `data-smarthome-action="openDerivedModal" data-smarthome-entity-id="${escapedIdAttr}"`
            : `data-smarthome-action="haRowClick"`;
        return `<tr class="hy-row hy-row-clickable ${isUnavail ? 'hy-row-unavailable' : ''}" data-entity="${escapedIdAttr}" data-domain="${escapeHtmlAttr(domain)}" data-source="${escapeHtmlAttr(source)}" data-search="${escapeHtmlAttr(_deviceSearchText(entity))}" ${rowAction}>
            <td class="hy-col-bulk"></td>
            <td class="hy-col-icon"><div class="hy-row-icon ${color}"><i class="${iconClass}"></i></div></td>
            <td class="hy-col-name">
                <div class="hy-row-name">${name} ${sourceBadge}</div>
                <div class="hy-row-entity mono">${escapedId}</div>
            </td>
            <td class="hy-col-alias">
                ${isDerived
            ? (aliasCount ? `<span class="hy-row-alias-btn text-slate-400">${escapeHtml(aliasBtnText)}</span>` : '')
            : `<button type="button" class="hy-row-alias-btn" data-smarthome-action="openAliasModal" data-smarthome-entity-id="${escapedIdAttr}" data-smarthome-stop-propagation="true" title="${t('hy.alias_modal_title')}">${escapeHtml(aliasBtnText)}</button>`}
            </td>
            <td class="hy-col-state">
                <span class="hy-row-state-wrap">
                    <span class="hy-row-state mono ${isUnavail ? 'text-red-500/70' : (isOn ? 'text-accent' : 'text-slate-400')}">${stateDisplay}</span>
                </span>
            </td>
            <td class="hy-col-ai">${isDerived
            ? `<label class="hy-row-ai cursor-pointer select-none" title="${escapeHtmlAttr(t('hy.include_ai_context_title'))}" data-smarthome-stop-propagation="true"><input type="checkbox" data-smarthome-change="toggleDerivedSelection" data-smarthome-entity-id="${escapedIdAttr}" ${entity.selected ? 'checked' : ''} class="accent-accent cursor-pointer" aria-label="${escapeHtmlAttr(t('hy.ai_selected'))}"></label>`
            : `<label class="hy-row-ai cursor-pointer select-none" title="${escapeHtmlAttr(t('hy.include_ai_context_title'))}" data-smarthome-stop-propagation="true"><input type="checkbox" data-smarthome-change="toggleSelection" data-smarthome-entity-id="${escapedIdAttr}" ${entity.selected ? 'checked' : ''} class="accent-accent cursor-pointer" aria-label="${escapeHtmlAttr(t('hy.ai_selected'))}"></label>`}</td>
        </tr>`;
    }).join('');
    if (pagination)
        pagination.innerHTML = _renderDevicesPagination(devices.length, startIndex + 1, Math.min(startIndex + pageDevices.length, devices.length), totalPages);
    updateHABulkCount();
}
function _renderDevicesPagination(total, from, to, totalPages) {
    const sizes = DEVICE_PAGE_SIZE_OPTIONS.map(size => `<option value="${size}" ${size === _devicesState.pageSize ? 'selected' : ''}>${size}</option>`).join('');
    return `<div class="hy-devices-pager-info">
            <span>${from}-${to}</span>
            <span>${escapeHtml(t('hy.pager_of'))}</span>
            <strong>${total}</strong>
        </div>
        <div class="hy-devices-pager-actions">
            <label class="hy-page-size"><span>${escapeHtml(t('hy.pager_rows'))}</span><select data-smarthome-change="setDevicesPageSize">${sizes}</select></label>
            <button type="button" class="hy-pager-btn" data-smarthome-action="setDevicesPage" data-smarthome-page="${_devicesState.page - 1}" ${_devicesState.page <= 1 ? 'disabled' : ''} aria-label="${escapeHtmlAttr(t('common.prev_page'))}"><i class="fas fa-chevron-left"></i></button>
            <span class="hy-page-index">${_devicesState.page} / ${totalPages}</span>
            <button type="button" class="hy-pager-btn" data-smarthome-action="setDevicesPage" data-smarthome-page="${_devicesState.page + 1}" ${_devicesState.page >= totalPages ? 'disabled' : ''} aria-label="${escapeHtmlAttr(t('common.next_page'))}"><i class="fas fa-chevron-right"></i></button>
        </div>`;
}
export function setDevicesPage(page) {
    const total = _getFilteredDevices().length;
    const totalPages = Math.max(1, Math.ceil(total / _devicesState.pageSize));
    _devicesState.page = Math.min(Math.max(1, Number(page) || 1), totalPages);
    renderDeviceCards();
}
export function setDevicesPageSize(value) {
    const next = Number(value);
    _devicesState.pageSize = DEVICE_PAGE_SIZE_OPTIONS.includes(next) ? next : 50;
    _devicesState.page = 1;
    renderDeviceCards();
}
export function sortDevicesBy(sortBy) {
    const nextSort = String(sortBy || 'name');
    if (_devicesState.sortBy === nextSort) {
        _devicesState.sortDir = _devicesState.sortDir === 'asc' ? 'desc' : 'asc';
    }
    else {
        _devicesState.sortBy = nextSort;
        _devicesState.sortDir = 'asc';
    }
    _devicesState.page = 1;
    renderDeviceCards();
}
export function filterHAByDomain(domain) {
    _haCurrentFilter = domain;
    _syncDevicesStateFromInputs({ resetPage: true });
    _syncSmarthomeFilterPickers();
    renderDeviceCards();
}
export function filterHABySource(source) {
    _haCurrentSource = source;
    _syncDevicesStateFromInputs({ resetPage: true });
    _syncSmarthomeFilterPickers();
    renderDeviceCards();
}
export function filterHAByArea(area) {
    _haCurrentArea = area;
    _syncDevicesStateFromInputs({ resetPage: true });
    _syncSmarthomeFilterPickers();
    renderDeviceCards();
}
function _filterChoice(value, label, count = null) {
    return { value: String(value), label: String(label), count: Number.isFinite(count) ? count : null };
}
function _filterChoiceText(choice) {
    const suffix = Number.isFinite(choice?.count) ? ` (${choice.count})` : '';
    return `${choice?.label || ''}${suffix}`;
}
function _filterPickerMarkup(id, label, icon, currentValue, choices, kind) {
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
function _domainLabel(domain) {
    const key = String(domain || '').trim().toLowerCase();
    const mapped = DOMAIN_LABEL_KEYS[key];
    if (mapped) {
        const label = t(mapped);
        if (label !== mapped)
            return label;
    }
    const nested = t(`hy.domains.${key}`);
    if (nested !== `hy.domains.${key}`)
        return nested;
    return key.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase()) || t('common.unknown');
}
function _domainCount(domain) {
    return _integrationEntitiesCache.filter(entity => {
        const dom = entity.domain || String(entity.entity_id || '').split('.')[0];
        return domain === 'sensor' ? (dom === 'sensor' || dom === 'binary_sensor') : dom === domain;
    }).length;
}
function _syncSmarthomeFilterPickers() {
    _syncSmarthomeFilterPicker('hy-source-picker', _haCurrentSource);
    _syncSmarthomeFilterPicker('hy-area-picker', _haCurrentArea);
    _syncSmarthomeFilterPicker('hy-domain-picker', _haCurrentFilter);
}
function _syncSmarthomeFilterPicker(id, value) {
    const picker = document.getElementById(id);
    if (!picker)
        return;
    const current = String(value || 'all');
    picker.dataset.value = current;
    const currentLabel = picker.querySelector('.hy-picker-current');
    let selectedLabel = '';
    picker.querySelectorAll('.hy-picker-option').forEach(option => {
        const opt = option;
        const selected = opt.dataset.value === current;
        opt.dataset.selected = selected ? 'true' : 'false';
        opt.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (selected)
            selectedLabel = opt.dataset.label || opt.textContent?.trim() || '';
    });
    if (currentLabel && selectedLabel)
        currentLabel.textContent = selectedLabel;
}
function _closeSmarthomeFilterPickers(except = null) {
    document.querySelectorAll('.hy-picker[data-open="true"]').forEach(picker => {
        const pickerEl = picker;
        if (except && pickerEl === except)
            return;
        pickerEl.dataset.open = 'false';
        pickerEl.querySelector('[data-hy-picker-toggle]')?.setAttribute('aria-expanded', 'false');
    });
}
export function toggleSmarthomePicker(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const current = event.currentTarget;
    const tgt = event.target;
    const toggle = current?.matches?.('[data-hy-picker-toggle]')
        ? current
        : tgt?.closest?.('[data-hy-picker-toggle]');
    const picker = toggle?.closest?.('.hy-picker');
    if (!picker || !toggle)
        return;
    const open = picker.dataset.open === 'true';
    _closeSmarthomeFilterPickers(picker);
    picker.dataset.open = open ? 'false' : 'true';
    toggle.setAttribute('aria-expanded', open ? 'false' : 'true');
}
export function selectSmarthomePickerOption(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const current = event.currentTarget;
    const tgt = event.target;
    const option = current?.matches?.('.hy-picker-option[data-filter-kind]')
        ? current
        : tgt?.closest?.('.hy-picker-option[data-filter-kind]');
    if (!option)
        return;
    const kind = option.dataset.filterKind;
    const value = option.dataset.value || 'all';
    _closeSmarthomeFilterPickers();
    if (kind === 'source')
        filterHABySource(value);
    else if (kind === 'area')
        filterHAByArea(value);
    else if (kind === 'domain')
        filterHAByDomain(value);
}
let _smarthomeFilterPickerEventsWired = false;
function _wireSmarthomeFilterPickerEvents() {
    if (_smarthomeFilterPickerEventsWired || typeof document === 'undefined')
        return;
    _smarthomeFilterPickerEventsWired = true;
    document.addEventListener('click', (event) => {
        const tgt = event.target;
        if (!tgt)
            return;
        const toggle = tgt.closest('[data-hy-picker-toggle]');
        if (toggle) {
            toggleSmarthomePicker(event);
            return;
        }
        const option = tgt.closest('.hy-picker-option[data-filter-kind]');
        if (option) {
            selectSmarthomePickerOption(event);
            return;
        }
        if (!tgt.closest('.hy-picker'))
            _closeSmarthomeFilterPickers();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape')
            _closeSmarthomeFilterPickers();
    });
}
function _buildSourceFilters(sources) {
    const nav = document.getElementById('hy-source-filters');
    if (!nav)
        return;
    const allCount = _getAllDevices().length;
    const choices = [_filterChoice('all', t('hy.filter_all_sources'), allCount)];
    for (const src of sources) {
        const count = _integrationEntitiesCache.filter(e => e.source === src.slug).length;
        if (count === 0)
            continue;
        choices.push(_filterChoice(src.slug, src.label, count));
    }
    nav.innerHTML = _filterPickerMarkup('hy-source-picker', t('hy.filter_integration'), 'fa-layer-group', _haCurrentSource, choices, 'source');
}
function _buildAreaFilters(areas) {
    const nav = document.getElementById('hy-area-filters');
    if (!nav)
        return;
    nav.classList.remove('hidden');
    const allLabel = t('hy.area_all');
    const noneLabel = t('hy.area_none');
    const noneCount = _integrationEntitiesCache.filter(e => !(e.area || '').trim()).length;
    const choices = [_filterChoice('all', allLabel, _getAllDevices().length)];
    for (const a of areas) {
        const name = a.name || '';
        if (!name)
            continue;
        choices.push(_filterChoice(name, name, a.count));
    }
    if (noneCount > 0) {
        choices.push(_filterChoice('__none__', noneLabel, noneCount));
    }
    nav.innerHTML = _filterPickerMarkup('hy-area-picker', t('hy.filter_area'), 'fa-map-location-dot', _haCurrentArea, choices, 'area');
}
function _buildDomainFilters() {
    const nav = document.getElementById('hy-domain-filters');
    if (!nav)
        return;
    const total = _getAllDevices().length;
    const active = _getAllDevices().filter(d => _isActiveState(String(d.state).toLowerCase())).length;
    const aiSelected = _getAllDevices().filter(d => d.selected).length;
    const domains = [...new Set(_integrationEntitiesCache.map(entity => entity.domain || String(entity.entity_id || '').split('.')[0]).filter(Boolean))]
        .sort((a, b) => {
        const ia = DOMAIN_ORDER.indexOf(a);
        const ib = DOMAIN_ORDER.indexOf(b);
        if (ia !== -1 || ib !== -1)
            return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
        return _domainLabel(a).localeCompare(_domainLabel(b));
    });
    const choices = [
        _filterChoice('all', t('hy.filter_all_entities'), total),
        _filterChoice('active', t('hy.filter_active_now'), active),
        _filterChoice('ai', t('hy.filter_in_ai'), aiSelected),
    ];
    domains.forEach(domain => {
        const count = _domainCount(domain);
        if (count > 0)
            choices.push(_filterChoice(domain, _domainLabel(domain), count));
    });
    nav.innerHTML = _filterPickerMarkup('hy-domain-picker', t('hy.filter_entity_type'), 'fa-shapes', _haCurrentFilter, choices, 'domain');
}
export function filterDevices() {
    _syncDevicesStateFromInputs({ resetPage: true });
    if (!_integrationEntitiesCache.length) {
        if (_restoreSmarthomeEntitySnapshot()) {
            renderDeviceCards();
            loadSmarthome().catch(() => { });
            return;
        }
        _setDevicesLoading(_devicesState.query ? t('hy.searching') : t('hy.waiting_data'));
        loadSmarthome().then(() => renderDeviceCards()).catch(() => { });
        return;
    }
    renderDeviceCards();
}
export function toggleSmarthomeFilters(forceOpen = null) {
    const toolbar = document.querySelector('.hy-sticky-toolbar');
    const toggle = document.getElementById('hy-mobile-filter-toggle');
    if (!toolbar)
        return;
    const nextOpen = forceOpen === null ? toolbar.dataset.filtersOpen !== 'true' : !!forceOpen;
    toolbar.dataset.filtersOpen = nextOpen ? 'true' : 'false';
    if (toggle) {
        toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
        toggle.dataset.active = nextOpen ? 'true' : 'false';
    }
    if (!nextOpen)
        _closeSmarthomeFilterPickers();
}
// Reset all smarthome filters (search, source, domain) to "all".
export function resetSmarthomeFilters() {
    _haCurrentFilter = 'all';
    _haCurrentSource = 'all';
    _haCurrentArea = 'all';
    const search = document.getElementById('hy-search');
    if (search)
        search.value = '';
    _syncDevicesStateFromInputs({ resetPage: true });
    _syncSmarthomeFilterPickers();
    renderDeviceCards();
}
// Copy the currently-open row-actions entity_id to the clipboard.
export async function copyEntityIdFromRowActions() {
    if (!_haRowActionsEntityId)
        return;
    try {
        await navigator.clipboard.writeText(_haRowActionsEntityId);
        showToast(t('hy.copied'), 'success');
    }
    catch (e) {
        showToast(t('hy.clipboard_error'), 'error');
    }
}
export function toggleAllHA(checked) {
    document.querySelectorAll('.hy-bulk-check').forEach(cb => { cb.checked = checked; });
    updateHABulkCount();
}
export function updateHABulkCount() {
    const count = document.querySelectorAll('.hy-bulk-check:checked').length;
    const panel = document.getElementById('hy-bulk-panel');
    const info = document.getElementById('bulk-selection-info');
    const bulkModeOn = !!document.querySelector('.hy-list-wrap.hy-bulk-mode');
    if (panel) {
        if (bulkModeOn && count > 0) {
            panel.classList.remove('hidden');
            if (info)
                info.innerText = t('hy.bulk_selected', { count });
        }
        else {
            panel.classList.add('hidden');
        }
    }
}
export async function deleteHABulk() {
    // No-op: bulk delete was Home Assistant only.
}
export async function deleteHASingle(eid) {
    // No-op: single-entity delete was Home Assistant only.
}
export async function toggleDevice(eid, btnEl) {
    // No-op: device toggling was Home Assistant only.
}
export async function toggleSelection(eid, sel) {
    const item = Array.isArray(_integrationEntitiesCache)
        ? _integrationEntitiesCache.find(x => x.entity_id === eid)
        : null;
    const revertCheckbox = () => {
        const selEsc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(eid) : eid.replace(/"/g, '\\"');
        document.querySelectorAll(`input[data-smarthome-change="toggleSelection"][data-smarthome-entity-id="${selEsc}"]`)
            .forEach((cb) => { cb.checked = !sel; });
    };
    try {
        const body = { entity_id: eid, selected: !!sel };
        if (item?.unique_id)
            body.unique_id = item.unique_id;
        await apiCall('/api/integrations/entities/selection', {
            method: 'POST',
            body,
        });
        // Reflect change locally so the AI counter and "AI only" filter
        // update without a full reload.
        if (item)
            item.selected = !!sel;
        try {
            updateHABulkCount();
        }
        catch (_) { }
    }
    catch {
        revertCheckbox();
        showToast(t('hy.network_error'), 'error');
    }
}
export async function toggleAllAI(checked) {
    const cache = Array.isArray(_integrationEntitiesCache) ? _integrationEntitiesCache : [];
    const tbody = document.querySelector('#hy-list-tbody');
    // Limit to currently visible (filtered) rows so users don't accidentally
    // toggle entities they can't see.
    const visibleEids = tbody
        ? Array.from(tbody.querySelectorAll('tr.hy-row:not(.hidden)'))
            .map(tr => tr.getAttribute('data-entity'))
            .filter(Boolean)
        : cache.map(d => d.entity_id);
    const visibleSet = new Set(visibleEids);
    const targets = cache.filter(d => visibleSet.has(d.entity_id) && d.source !== 'derived');
    if (!targets.length)
        return;
    try {
        await Promise.all(targets.map(d => {
            const body = { entity_id: d.entity_id, selected: !!checked };
            if (d.unique_id)
                body.unique_id = d.unique_id;
            return apiCall('/api/integrations/entities/selection', {
                method: 'POST',
                body,
            }).catch(() => null);
        }));
        targets.forEach(d => { d.selected = !!checked; });
        // Re-sync checkbox state in the visible rows without a full re-render.
        if (tbody) {
            tbody.querySelectorAll('tr.hy-row:not(.hidden) .hy-row-ai input[type="checkbox"]').forEach(cb => {
                cb.checked = !!checked;
            });
        }
        try {
            updateHABulkCount();
        }
        catch (_) { }
    }
    catch {
        showToast(t('hy.network_error'), 'error');
    }
}
let _haAliasModalEntityId = null;
let _haAliasModalOriginalParent = null;
export function openAliasModal(eid) {
    const modal = document.getElementById('hy-alias-modal');
    const container = document.getElementById('hy-alias-inputs');
    const titleEl = document.getElementById('hy-alias-modal-title');
    const entityEl = document.getElementById('hy-alias-modal-entity');
    if (!modal || !container)
        return;
    const d = _integrationEntitiesCache?.find(x => x.entity_id === eid);
    _haAliasModalEntityId = eid;
    if (titleEl)
        titleEl.textContent = t('hy.alias_modal_title');
    if (entityEl)
        entityEl.textContent = eid;
    container.innerHTML = '';
    const list = d?.aliases?.length ? [...d.aliases] : [''];
    list.forEach(alias => _appendAliasInput(container, alias));
    if (modal.parentNode !== document.body) {
        _haAliasModalOriginalParent = modal.parentNode;
        document.body.appendChild(modal);
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}
function _appendAliasInput(container, value = '') {
    const wrap = document.createElement('div');
    wrap.className = 'flex gap-2 items-center';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'flex-1 bg-slate-900 border border-white/10 rounded-xl px-3 py-2 text-sm text-slate-200 focus:border-accent outline-none';
    input.placeholder = t('hy.alias_placeholder');
    input.value = value;
    input.dataset.haAlias = '1';
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'w-9 h-9 rounded-lg bg-white/5 hover:bg-red-500/20 text-slate-400 hover:text-red-400 flex items-center justify-center flex-shrink-0';
    rm.innerHTML = '<i class="fas fa-minus text-xs"></i>';
    rm.setAttribute('aria-label', 'Remove alias');
    rm.setAttribute('data-smarthome-action', 'removeAliasRow');
    wrap.appendChild(input);
    wrap.appendChild(rm);
    container.appendChild(wrap);
}
export function addAliasInput() {
    const container = document.getElementById('hy-alias-inputs');
    if (!container)
        return;
    _appendAliasInput(container, '');
}
export function closeAliasModal() {
    const modal = document.getElementById('hy-alias-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        if (_haAliasModalOriginalParent && modal.parentNode === document.body) {
            _haAliasModalOriginalParent.appendChild(modal);
            _haAliasModalOriginalParent = null;
        }
    }
    _haAliasModalEntityId = null;
}
let _haRowActionsEntityId = null;
let _haRowActionsModalOriginalParent = null;
export function handleHaRowClick(event) {
    const row = event.currentTarget;
    if (!row || row.getAttribute('data-entity') == null)
        return;
    const tgt = event.target;
    if (tgt?.closest('button, input, a, label'))
        return;
    const eid = row.getAttribute('data-entity');
    if (eid)
        openRowActionsModal(eid);
}
export async function openRowActionsModal(entityId) {
    const modal = document.getElementById('entity-detail-modal');
    const iconEl = document.getElementById('entity-detail-modal-icon');
    const labelEl = document.getElementById('entity-detail-modal-label');
    const body = document.getElementById('entity-detail-modal-body');
    let entity = _integrationEntitiesCache?.find(candidate => candidate.entity_id === entityId) || _devicesVisibleEntityCache.get(entityId);
    if (!modal || !body)
        return;
    if (!entity) {
        try {
            await loadSmarthome();
        }
        catch (_) { }
        entity = _integrationEntitiesCache?.find(candidate => candidate.entity_id === entityId) || _devicesVisibleEntityCache.get(entityId);
    }
    if (!entity) {
        showToast(t('hy.entity_not_found_sync'), 'error');
        return;
    }
    _haRowActionsEntityId = entityId;
    stopCameraPreviewRefresh();
    const domain = _entityDomain(entity);
    const stateLower = _norm(entity.state);
    const rawState = entity.state ?? 'unknown';
    const stateDisplay = `${tState(rawState)}${entity.unit ? ' ' + entity.unit : ''}`;
    const iconClass = _iconClass(entity.icon) || `fas ${DOMAIN_ICONS[domain] || 'fa-microchip'}`;
    const sourceMeta = SOURCE_ICONS[entity.source ?? ''] || { icon: 'fa-puzzle-piece', label: entity.source || 'Unknown', color: 'text-slate-400' };
    const attrs = entity.attributes && typeof entity.attributes === 'object' ? entity.attributes : {};
    const cameraPreview = _cameraPreviewMarkup(entity, attrs);
    const attrsRows = Object.entries(attrs).slice(0, 24).map(([key, value]) => `
        <div class="hy-detail-attr">
            <span>${escapeHtml(key)}</span>
            <strong>${escapeHtml(typeof value === 'object' ? JSON.stringify(value) : String(value))}</strong>
        </div>`).join('');
    if (iconEl)
        iconEl.className = iconClass;
    if (labelEl)
        labelEl.textContent = entity.name || entity.entity_id || t('integrations.device');
    body.innerHTML = `
        <div class="hy-detail-hero">
            <div class="hy-detail-icon ${DOMAIN_COLORS[domain] || 'bg-slate-500/15 text-slate-400'}"><i class="${iconClass}"></i></div>
            <div class="hy-detail-titlebox">
                <div class="hy-detail-kicker"><i class="fas ${sourceMeta.icon}"></i>${escapeHtml(sourceMeta.label || entity.source || 'Unknown')}</div>
                <h3>${escapeHtml(entity.name || entity.entity_id)}</h3>
            </div>
        </div>
        ${renderEntityRegistrySection(entity)}
        <div class="hy-detail-status-row">
            <div class="hy-detail-status ${['unavailable', 'unknown', 'offline'].includes(stateLower) ? 'is-offline' : _isActiveState(stateLower) ? 'is-active' : ''}">
                <span>${escapeHtml(t('hy.detail_state'))}</span>
                <strong>${escapeHtml(stateDisplay)}</strong>
            </div>
            <div class="hy-detail-status">
                <span>${escapeHtml(t('hy.detail_domain'))}</span>
                <strong>${escapeHtml(_domainLabel(domain))}</strong>
            </div>
        </div>
        ${cameraPreview}
        <div class="hy-detail-actions">
            ${_deviceControlButtons(entity)}
            <button type="button" class="hy-detail-btn" data-smarthome-action="copyEntityIdFromRowActions"><i class="fas fa-copy"></i><span>${escapeHtml(t('hy.copy_id_short'))}</span></button>
            <button type="button" class="hy-detail-btn" data-smarthome-action="openAliasModalFromDetail" data-smarthome-entity-id="${escapeHtmlAttr(entityId)}"><i class="fas fa-tag"></i><span>${escapeHtml(t('hy.col_alias'))}</span></button>
            ${entity.source === 'derived' ? '' : `<label class="hy-detail-toggle"><span><i class="fas fa-robot"></i>${escapeHtml(t('hy.row_action_ai'))}</span><input type="checkbox" data-smarthome-change="toggleSelection" data-smarthome-entity-id="${escapeHtmlAttr(entityId)}" ${entity.selected ? 'checked' : ''}></label>`}
        </div>
        <div class="hy-detail-section">
            <div class="hy-detail-section-title">${escapeHtml(t('hy.detail_attributes'))}</div>
            <div class="hy-detail-attrs">${attrsRows || `<div class="hy-detail-empty">${escapeHtml(t('hy.detail_no_attributes'))}</div>`}</div>
        </div>`;
    if (modal.parentNode !== document.body)
        document.body.appendChild(modal);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    wireEntityRegistryEditor(body, entity, {
        onUpdated: ({ oldEntityId, newEntityId, uniqueId }) => {
            const idx = _integrationEntitiesCache.findIndex((e) => e.entity_id === oldEntityId || (uniqueId && e.unique_id === uniqueId));
            if (idx >= 0) {
                _integrationEntitiesCache[idx].entity_id = newEntityId;
                _devicesVisibleEntityCache.delete(oldEntityId);
                _devicesVisibleEntityCache.set(newEntityId, _integrationEntitiesCache[idx]);
            }
            _haRowActionsEntityId = newEntityId;
            openRowActionsModal(newEntityId);
        },
    });
    startCameraPreviewRefresh();
    bindCameraPreviewLoaders(body);
    _wireCameraPreviewMute();
}
function _wireCameraPreviewMute() {
    const wrap = document.querySelector('#entity-detail-modal .hy-detail-camera');
    const video = wrap?.querySelector('video[data-camera-live-webm]');
    const btn = wrap?.querySelector('[data-camera-mute-toggle]');
    if (!video || !btn)
        return;
    btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        video.muted = !video.muted;
        btn.textContent = video.muted ? '🔇' : '🔊';
    });
}
function _cameraPreviewMarkup(entity, attrs) {
    const domain = _entityDomain(entity);
    if (domain === 'image')
        return _imagePreviewMarkup(entity, attrs);
    if (domain !== 'camera')
        return '';
    const hasAudio = !!(attrs.has_audio);
    const playUrl = cameraPreferWebmPlayer(attrs) ? _cameraProxyUrl(entity.entity_id, 'play') : '';
    if (playUrl) {
        const muted = !hasAudio;
        return `<div class="hy-detail-camera relative" data-camera-preview-shell>
            ${cameraLoaderMarkup()}
            <video src="${escapeHtmlAttr(playUrl)}" ${muted ? 'muted' : ''} autoplay playsinline controls data-camera-live-webm class="hy-camera-preview-media"></video>
            <button type="button" data-camera-mute-toggle class="absolute left-2 bottom-2 z-10 px-2 py-1 rounded-lg bg-black/60 text-white text-sm border-0 cursor-pointer" title="${escapeHtmlAttr(t('entity.render.sound'))}">${muted ? '🔇' : '🔊'}</button>
        </div>`;
    }
    const mjpeg = String(attrs.mjpeg_url || '').trim();
    const proxyMode = (mjpeg.startsWith('http://') || mjpeg.startsWith('https://')) ? 'stream' : 'snapshot';
    const imageUrl = _cameraProxyUrl(entity.entity_id, proxyMode);
    const videoUrl = attrs.stream_url || attrs.preview_url || '';
    if (imageUrl) {
        const shouldRefresh = proxyMode === 'snapshot';
        return `<div class="hy-detail-camera" data-camera-preview-shell>
            ${cameraLoaderMarkup()}
            <img src="${escapeHtmlAttr(_cacheBustCameraUrl(imageUrl))}" data-camera-src="${escapeHtmlAttr(imageUrl)}" data-camera-refresh="${shouldRefresh ? 'true' : 'false'}" alt="${escapeHtmlAttr(entity.name || entity.entity_id || 'Camera')}" loading="eager" class="hy-camera-preview-media">
        </div>`;
    }
    if (videoUrl) {
        return `<div class="hy-detail-camera" data-camera-preview-shell>
            ${cameraLoaderMarkup()}
            <video src="${escapeHtmlAttr(videoUrl)}" autoplay muted playsinline controls class="hy-camera-preview-media"></video>
        </div>`;
    }
    return '';
}
function _imagePreviewMarkup(entity, attrs) {
    const hasImage = attrs.image_url || attrs.snapshot_url || attrs.entity_picture || attrs.url
        || /^https?:\/\//.test(String(entity.state || ''));
    if (!hasImage)
        return '';
    const proxyUrl = _imageProxyUrl(entity.entity_id);
    if (!proxyUrl)
        return '';
    return `<div class="hy-detail-camera" data-camera-preview-shell>
        ${cameraLoaderMarkup()}
        <img src="${escapeHtmlAttr(_cacheBustCameraUrl(proxyUrl))}" data-camera-src="${escapeHtmlAttr(proxyUrl)}" data-camera-refresh="true" alt="${escapeHtmlAttr(entity.name || entity.entity_id || 'Image')}" loading="eager" class="hy-camera-preview-media">
    </div>`;
}
function _imageProxyUrl(entityId) {
    if (!entityId)
        return '';
    return cameraProxyUrlSync(entityId, 'image');
}
function _cameraProxyUrl(entityId, mode = 'snapshot') {
    if (!entityId)
        return '';
    const paths = { stream: 'stream', play: 'play', snapshot: 'snapshot' };
    const path = paths[mode] || 'snapshot';
    return cameraProxyUrlSync(entityId, path);
}
function _cacheBustCameraUrl(url) {
    const raw = String(url || '');
    if (!raw)
        return '';
    return `${raw}${raw.includes('?') ? '&' : '?'}_hyve=${Date.now()}`;
}
function _deviceControlButtons(entity) {
    if (!entity || entity.source === 'derived')
        return '';
    const entityId = escapeHtmlAttr(entity.entity_id || '');
    const source = escapeHtmlAttr(entity.source || '');
    const domain = _entityDomain(entity);
    const stateLower = _norm(entity.state);
    const isActive = _isActiveState(stateLower) || stateLower === 'on';
    const pending = _deviceControlPending.has(entity.entity_id || '');
    const _er = (key) => t('entity.render.' + key);
    const button = (action, icon, label, tone = '') => {
        const busyIcon = pending ? 'fa-circle-notch fa-spin' : icon;
        const busyLabel = pending ? t('integrations.applying') : label;
        return `<button type="button" class="hy-detail-btn ${tone}${pending ? ' is-pending' : ''}" ${pending ? 'aria-busy="true" data-pending="true"' : ''} data-smarthome-action="controlDevice" data-smarthome-source="${source}" data-smarthome-entity-id="${entityId}" data-smarthome-device-action="${action}"><i class="fas ${busyIcon}"></i><span>${busyLabel}</span></button>`;
    };
    if (['light', 'switch', 'input_boolean', 'fan'].includes(domain)) {
        return button(isActive ? 'turn_off' : 'turn_on', 'fa-power-off', isActive ? _er('turn_off') : _er('turn_on'), isActive ? 'is-danger' : 'is-primary');
    }
    if (domain === 'cover') {
        return [button('open_cover', 'fa-arrow-up', _er('up')), button('stop_cover', 'fa-stop', _er('stop')), button('close_cover', 'fa-arrow-down', _er('down'))].join('');
    }
    if (domain === 'lock') {
        return button(isActive ? 'lock' : 'unlock', isActive ? 'fa-lock' : 'fa-unlock', isActive ? _er('lock_action') : _er('unlock_action'), isActive ? '' : 'is-primary');
    }
    if (domain === 'button' || domain === 'script') {
        return button('press', 'fa-play', _er('send'), 'is-primary');
    }
    if (domain === 'vacuum') {
        return [
            button('start', 'fa-play', _er('vacuum_start'), 'is-primary'),
            button('stop', 'fa-stop', _er('stop')),
            button('return_to_base', 'fa-house', _er('vacuum_dock')),
            button('locate', 'fa-location-crosshairs', _er('vacuum_locate')),
        ].join('');
    }
    if (domain === 'media_player') {
        return [button('media_play', 'fa-play', _er('media_play')), button('media_pause', 'fa-pause', _er('media_pause'))].join('');
    }
    if (entity.controllable) {
        return button('toggle', 'fa-sliders', _er('toggle'), 'is-primary');
    }
    return `<div class="hy-detail-empty">${escapeHtml(_er('read_only'))}</div>`;
}
export async function controlDeviceEntity(source, entityId, action, buttonEl = null) {
    const entity = _integrationEntitiesCache?.find(candidate => candidate.entity_id === entityId);
    if (!entity || !source || source === 'derived')
        return;
    if (_deviceControlPending.has(entityId))
        return;
    const previousState = entity.state;
    const optimisticState = _optimisticStateForAction(action, previousState);
    _deviceControlPending.set(entityId, { action, previousState, optimisticState, startedAt: Date.now() });
    if (buttonEl) {
        buttonEl.classList.add('is-pending');
        buttonEl.setAttribute('aria-busy', 'true');
        const icon = buttonEl.querySelector('i');
        const label = buttonEl.querySelector('span');
        if (icon)
            icon.className = 'fas fa-circle-notch fa-spin';
        if (label)
            label.textContent = t('integrations.applying');
    }
    entity.state = optimisticState;
    renderDeviceCards();
    _markDeviceControlPending(entityId, true);
    if (_haRowActionsEntityId === entityId)
        await openRowActionsModal(entityId);
    try {
        const response = await apiCall(`/api/integrations/${encodeURIComponent(source)}/control`, {
            method: 'POST',
            body: { entity_id: entityId, action, data: {} },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok)
            throw new Error(payload.detail || payload.message || t('integrations.action_failed'));
        _deviceOptimisticGuards.set(entityId, { state: optimisticState, until: Date.now() + DEVICE_OPTIMISTIC_GUARD_MS });
        showToast(t('hy.command_sent'), 'success');
    }
    catch (error) {
        _deviceOptimisticGuards.delete(entityId);
        entity.state = previousState;
        renderDeviceCards();
        showToast(_errMsg(error) || t('hy.control_error'), 'error');
    }
    finally {
        _deviceControlPending.delete(entityId);
        _markDeviceControlPending(entityId, false);
        if (_haRowActionsEntityId === entityId)
            openRowActionsModal(entityId);
    }
}
export function openAliasModalFromDetail(entityId) {
    closeEntityDetailModal();
    openAliasModal(entityId);
}
export function closeEntityDetailModal() {
    const modal = document.getElementById('entity-detail-modal');
    stopCameraPreviewRefresh();
    if (modal) {
        modal.querySelectorAll('hv-camera-stream').forEach(el => {
            try {
                el.pauseStream?.();
            }
            catch (_) { }
        });
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    _haRowActionsEntityId = null;
}
export function closeRowActionsModal() {
    closeEntityDetailModal();
}
export async function saveAliasesFromModal() {
    if (!_haAliasModalEntityId)
        return;
    const container = document.getElementById('hy-alias-inputs');
    if (!container)
        return;
    const inputs = container.querySelectorAll('input[data-ha-alias="1"]');
    const aliases = Array.from(inputs).map(inp => inp.value.trim()).filter(s => s);
    const d = _integrationEntitiesCache?.find(x => x.entity_id === _haAliasModalEntityId);
    await apiCall('/api/integrations/entity/rename', { method: 'POST', body: { entity_id: _haAliasModalEntityId, aliases } });
    if (d)
        d.aliases = aliases;
    closeAliasModal();
    renderDeviceCards();
}
export async function saveAliases(eid, val) {
    const aliases = val.split(',').map(s => s.trim()).filter(s => s);
    await apiCall('/api/integrations/entity/rename', { method: 'POST', body: { entity_id: eid, aliases } });
    const d = _integrationEntitiesCache.find(x => x.entity_id === eid);
    if (d)
        d.aliases = aliases;
}
// --- Add Devices Modal ---
let _availableDevices = [];
export async function openAddDevicesModal() {
    // No-op: legacy Home Assistant "add devices" picker.
}
export function closeAddDevicesModal() {
    const modal = document.getElementById('add-devices-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    _availableDevices = [];
}
function _renderAvailableDevices() {
    const list = document.getElementById('add-devices-list');
    if (!list)
        return;
    const search = (document.getElementById('add-devices-search')?.value || '').toLowerCase();
    const filtered = search ? _availableDevices.filter(d => `${d.name} ${d.entity_id}`.toLowerCase().includes(search)) : _availableDevices;
    if (!filtered.length) {
        list.innerHTML = `<div class="text-center text-slate-500 text-sm py-8">${search ? t('hy.no_devices_found') : t('hy.all_synced')}</div>`;
        _updateAddCount();
        return;
    }
    let currentDomain = '';
    let html = '';
    filtered.forEach(d => {
        const domain = d.domain || d.entity_id.split('.')[0];
        if (domain !== currentDomain) {
            currentDomain = domain;
            html += `<div class="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-3 mb-1 px-1">${domain.replace('_', ' ')}</div>`;
        }
        const icon = DOMAIN_ICONS[domain] || 'fa-microchip';
        const color = DOMAIN_COLORS[domain] || 'bg-slate-500/15 text-slate-400';
        const isActive = _isActiveState(String(d.state).toLowerCase());
        html += `<div class="add-device-item" data-smarthome-action="toggleAvailableDevice" data-smarthome-entity-id="${escapeHtmlAttr(d.entity_id)}">
            <input type="checkbox" class="add-device-check accent-accent cursor-pointer w-3.5 h-3.5 flex-shrink-0" value="${d.entity_id}" data-smarthome-action="toggleAvailableDevice" data-smarthome-entity-id="${escapeHtmlAttr(d.entity_id)}" data-smarthome-stop-propagation="true">
            <div class="ha-card-icon ${color} w-8 h-8 text-xs"><i class="fas ${icon}"></i></div>
            <div class="min-w-0 flex-1">
                <div class="text-sm text-white font-medium truncate">${escapeHtml(d.name || d.entity_id)}</div>
                <div class="text-[10px] text-slate-500 mono truncate">${d.entity_id}</div>
            </div>
            <span class="text-[10px] font-bold mono ${isActive ? 'text-green-400' : 'text-slate-500'}">${d.state}</span>
        </div>`;
    });
    list.innerHTML = html;
    _updateAddCount();
}
export function toggleAvailableDevice(el, eid) {
    const cb = el.querySelector('.add-device-check');
    if (cb && document.activeElement !== cb)
        cb.checked = !cb.checked;
    el.classList.toggle('selected', cb?.checked);
    _updateAddCount();
}
export function toggleAllAvailableDevices() {
    const checks = document.querySelectorAll('.add-device-check');
    const allChecked = Array.from(checks).every(c => c.checked);
    checks.forEach(c => { c.checked = !allChecked; c.closest('.add-device-item')?.classList.toggle('selected', !allChecked); });
    _updateAddCount();
}
function _updateAddCount() {
    const count = document.querySelectorAll('.add-device-check:checked').length;
    const el = document.getElementById('add-devices-count');
    if (el)
        el.innerText = t('hy.bulk_selected', { count });
}
export function filterAvailableDevices() {
    _renderAvailableDevices();
}
export async function confirmAddDevices() {
    // No-op: legacy Home Assistant "add devices" picker.
    closeAddDevicesModal();
}
export async function syncHA() {
    loadSmarthome({ force: true });
}
/** Read-only view of cached integration entities (automation picker fallback). */
export function getIntegrationEntities() {
    return Array.isArray(_integrationEntitiesCache) ? _integrationEntitiesCache : [];
}
