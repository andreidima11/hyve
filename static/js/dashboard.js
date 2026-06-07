import { apiCall } from './api.js';
import { cameraPreferWebmPlayer, cameraSupportsGo2rtc } from './camera_live.js';
import { getCameraStreamToken } from './camera_auth.js';
import { showConfirm, showToast, setupCodeEditor, setCodeEditorValue, getCodeEditorValue, refreshCodeEditor, syncModalViewportMetrics } from './utils.js';
import { t, translateApiDetail, tVacuumStatus } from './lang/index.js';
import './entity_renderers.js';
// Hyveview bare-path imports dedupe to a single module instance (see hyveview_setup.js).
import '/static/hyveview/elements/camera_stream.js';
import '/static/hyveview/elements/camera_carousel.js';
import { dashDebug, DASH_DEBUG_ENABLED } from './dashboard/debug.js';
import { HVBridge, HVSetHost, hvOpenEditor, registerHyveviewDashboardCards } from './dashboard/hyveview_setup.js';
import { createDashboardYamlEditor } from './dashboard/yaml_editor.js';
import { initDashboardPullToRefresh } from './dashboard/pull_refresh.js';
import { createDashboardLiveWs } from './dashboard/live_ws.js';
import { createDashboardEntityPatcher } from './dashboard/entity_patch.js';
import { fusionSolarEntityIdsFromPower, fusionSolarWidgetEntityIds } from '/static/hyveview/cards/fusion_solar.js';
import { widgetTitle } from '/static/hyveview/host.js';
import { normalizeIconClass, widgetIconSpec } from './icon_utils.js';
import {
    DEFAULT_PREFS,
    DEFAULT_META,
    DASHBOARD_LOCAL_KEY,
    DASHBOARD_PAGES_NAV_KEY,
    DASHBOARD_LAST_PAGE_KEY,
    DASHBOARD_STANDALONE_PANEL_ID,
    DASHBOARD_OPTIMISTIC_GUARD_MS,
    DASHBOARD_PENDING_VISUAL_MS,
    SECTION_COLS,
    DASHBOARD_COL_POINTS_MIN,
    DASHBOARD_COL_POINTS_MAX,
    DEFAULT_CAMERA_INTERVAL,
    DASHBOARD_GRID_COLS,
    DASHBOARD_CUSTOM_SELECT_IDS,
} from './dashboard/constants.js';
import { dashApiError as _dashApiError, escapeHtml as _escape, stateOn as _stateOn } from './dashboard/helpers.js';
import { initDashboardWidgetActions } from './dashboard/widget_actions.js';
import {
    initDashboardDragResize,
    startDashboardDrag,
    startDashboardPanelDrag,
    startDashboardResize,
    moveDashboardWidget,
    setupDashboardSortables,
    teardownDashboardSortables,
    syncDashboardPanelGridSpans,
    dashboardPanelSpan,
} from './dashboard/drag_resize.js';
export {
    startDashboardDrag,
    startDashboardPanelDrag,
    startDashboardResize,
    moveDashboardWidget,
} from './dashboard/drag_resize.js';
import { initDashboardEventBindings } from './dashboard/event_bindings.js';
import { initDashboardClimate, renderClimateCard, climateConfiguredIds,
    toggleDashboardClimateModeMenu, selectDashboardClimateSlide, shiftDashboardClimateSlide,
    startDashboardClimateSwipe, moveDashboardClimateSwipe, endDashboardClimateSwipe,
    adjustDashboardClimateTemperature, setDashboardClimateMode,
    setDashboardClimateEntitySelection, clearDashboardClimateEntitySelection,
    addDashboardClimateEntityId, climateEntityRecordsForSave,
    renderDashboardClimateEntityChips,
    updateDashboardClimateEntityMeta, addSelectedDashboardClimateEntity, removeDashboardClimateEntity,
} from './dashboard/climate.js';
export {
    toggleDashboardClimateModeMenu,
    selectDashboardClimateSlide,
    shiftDashboardClimateSlide,
    startDashboardClimateSwipe,
    moveDashboardClimateSwipe,
    endDashboardClimateSwipe,
    adjustDashboardClimateTemperature,
    setDashboardClimateMode,
    updateDashboardClimateEntityMeta,
    addSelectedDashboardClimateEntity,
    removeDashboardClimateEntity,
} from './dashboard/climate.js';
export {
    onDashboardBrightnessInput,
    onDashboardBrightnessChange,
    onDashboardLockAction,
    onDashboardVacuumAction,
} from './dashboard/widget_actions.js';

const _effectiveWidgetCardType = (widget) =>
    HVBridge.effectiveCardType(widget) || String(widget?.type || widget?.renderer || 'button').toLowerCase();

let _dashboardCache = {
    widgets: [],
    available_entities: [],
    preferences: { ...DEFAULT_PREFS },
    title: DEFAULT_META.title,
    subtitle: DEFAULT_META.subtitle,
    pages: [],
    panels: [],
    page_id: null,
    current_page_id: null,
    icon: '',
    columns: 0,
};
let _pageEditorMode = 'edit';
let _entityPickerMode = 'add';
let _entityPickerActiveIndex = -1;
let _dashboardEditMode = false;
let _dashboardCurrentEditorId = null;
let _dashboardWidgetEditorMode = 'visual';
let _currentPageId = null;
let _hashRouterBound = false;
const _dashboardPendingControls = new Map();
const _dashboardOptimisticGuards = new Map();
let _dashboardPanelModalMode = 'add';
let _dashboardPanelModalPanelId = null;
let _dashboardPanelModalPages = [];
const _dashboardCustomSelects = new WeakMap();
let _dashboardCustomSelectOutsideBound = false;

function _dashboardSelectLabel(option) {
    return String(option?.label || option?.textContent || option?.value || '').trim() || '—';
}

function _closeDashboardCustomSelects(exceptWrap = null) {
    document.querySelectorAll('.dashboard-custom-select[data-open="true"]').forEach(wrap => {
        if (exceptWrap && wrap === exceptWrap) return;
        wrap.dataset.open = 'false';
        const button = wrap.querySelector('.dashboard-custom-select__button');
        if (button) button.setAttribute('aria-expanded', 'false');
    });
}

function _syncDashboardCustomSelect(select) {
    const state = _dashboardCustomSelects.get(select);
    if (!state) return;
    const options = Array.from(select.options || []);
    const selectedIndex = Math.max(0, select.selectedIndex);
    const selected = options[selectedIndex] || options[0];
    state.value.textContent = _dashboardSelectLabel(selected);
    state.button.disabled = !!select.disabled || !options.length;
    state.wrap.dataset.disabled = state.button.disabled ? 'true' : 'false';
    state.menu.innerHTML = options.map((option, index) => {
        const isSelected = index === selectedIndex;
        const disabled = option.disabled ? ' disabled' : '';
        return `<button type="button" role="option" class="dashboard-custom-select__option" data-index="${index}" data-selected="${isSelected ? 'true' : 'false'}" aria-selected="${isSelected ? 'true' : 'false'}"${disabled}>${_escape(_dashboardSelectLabel(option))}</button>`;
    }).join('');
}

function _enhanceDashboardCustomSelect(select) {
    if (!select || select.tagName !== 'SELECT') return;
    if (!DASHBOARD_CUSTOM_SELECT_IDS.has(select.id) && !select.matches('[data-vis-field="op"]')) return;

    let state = _dashboardCustomSelects.get(select);
    if (!state) {
        // The global native-<select> auto-upgrade (features.js) may have already
        // wrapped this select with its own `.js-generic-select` overlay on page
        // load. If we build a second wrapper on top, the user sees two stacked
        // dropdowns. The dashboard system owns these specific IDs (richer
        // keyboard nav + labels), so drop the generic overlay first.
        const genericOverlay = select.nextElementSibling;
        if (genericOverlay
            && genericOverlay.classList.contains('dashboard-custom-select')
            && genericOverlay.classList.contains('js-generic-select')
            && genericOverlay.getAttribute('data-target') === select.id) {
            genericOverlay.remove();
        }
        const wrap = document.createElement('div');
        wrap.className = 'dashboard-custom-select';
        if (select.matches('[data-vis-field="op"]') || String(select.className || '').includes('text-xs')) {
            wrap.classList.add('dashboard-custom-select--compact');
        }
        wrap.dataset.open = 'false';
        wrap.innerHTML = `
            <button type="button" class="dashboard-custom-select__button" aria-haspopup="listbox" aria-expanded="false">
                <span class="dashboard-custom-select__value"></span>
                <i class="fas fa-chevron-down"></i>
            </button>
            <div class="dashboard-custom-select__menu" role="listbox"></div>
        `;
        select.classList.add('dashboard-custom-select-native');
        select.setAttribute('aria-hidden', 'true');
        select.tabIndex = -1;
        select.insertAdjacentElement('afterend', wrap);

        state = {
            wrap,
            button: wrap.querySelector('.dashboard-custom-select__button'),
            value: wrap.querySelector('.dashboard-custom-select__value'),
            menu: wrap.querySelector('.dashboard-custom-select__menu'),
        };
        _dashboardCustomSelects.set(select, state);

        state.button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const willOpen = state.wrap.dataset.open !== 'true';
            _closeDashboardCustomSelects(state.wrap);
            state.wrap.dataset.open = willOpen ? 'true' : 'false';
            state.button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        });
        state.button.addEventListener('keydown', event => {
            if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            _closeDashboardCustomSelects(state.wrap);
            state.wrap.dataset.open = 'true';
            state.button.setAttribute('aria-expanded', 'true');
            const selectedButton = state.menu.querySelector('[data-selected="true"]') || state.menu.querySelector('.dashboard-custom-select__option:not(:disabled)');
            selectedButton?.focus?.();
        });
        state.menu.addEventListener('click', event => {
            const optionButton = event.target.closest('.dashboard-custom-select__option');
            if (!optionButton || optionButton.disabled) return;
            event.preventDefault();
            event.stopPropagation();
            const index = Number(optionButton.getAttribute('data-index'));
            if (Number.isFinite(index) && select.options[index]) {
                select.selectedIndex = index;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
            _syncDashboardCustomSelect(select);
            _closeDashboardCustomSelects();
            state.button.focus?.();
        });
        state.menu.addEventListener('keydown', event => {
            const items = Array.from(state.menu.querySelectorAll('.dashboard-custom-select__option:not(:disabled)'));
            const currentIndex = items.indexOf(document.activeElement);
            if (event.key === 'Escape') {
                event.preventDefault();
                _closeDashboardCustomSelects();
                state.button.focus?.();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                const nextIndex = Math.min(Math.max(currentIndex + delta, 0), items.length - 1);
                items[nextIndex]?.focus?.();
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                document.activeElement?.click?.();
            }
        });
        select.addEventListener('change', () => _syncDashboardCustomSelect(select));
    }

    _syncDashboardCustomSelect(select);

    if (!_dashboardCustomSelectOutsideBound) {
        _dashboardCustomSelectOutsideBound = true;
        document.addEventListener('click', event => {
            if (event.target.closest('.dashboard-custom-select')) return;
            _closeDashboardCustomSelects();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') _closeDashboardCustomSelects();
        });
    }
}

function _enhanceDashboardCustomSelects(root = document) {
    const scope = root?.querySelectorAll ? root : document;
    const selectors = [
        ...Array.from(DASHBOARD_CUSTOM_SELECT_IDS, id => `#${id}`),
        'select[data-vis-field="op"]',
    ].join(',');
    scope.querySelectorAll(selectors).forEach(select => _enhanceDashboardCustomSelect(select));
}

function _normalizeCache(payload = {}) {
    const panels = _normalizeDashboardSectionPanels(payload.panels, payload.widgets);
    return {
        widgets: panels.flatMap(panel => Array.isArray(panel.widgets) ? panel.widgets : []),
        available_entities: Array.isArray(payload.available_entities) ? payload.available_entities : [],
        preferences: { ...DEFAULT_PREFS, ...(payload.preferences || {}) },
        title: String(payload.title || DEFAULT_META.title),
        subtitle: String(payload.subtitle || DEFAULT_META.subtitle),
        pages: Array.isArray(payload.pages) ? payload.pages : [],
        panels,
        page_id: payload.page_id || null,
        current_page_id: payload.current_page_id || payload.page_id || null,
        default_page_id: payload.default_page_id || null,
        icon: String(payload.icon || ''),
        columns: Number.isFinite(payload.columns) ? Number(payload.columns) : 0,
    };
}

function _normalizeDashboardSectionPanels(rawPanels = [], rawWidgets = []) {
    const panels = Array.isArray(rawPanels) ? rawPanels : [];
    const sectionPanels = [];
    const standaloneWidgets = [];
    panels.forEach(panel => {
        if (!panel || typeof panel !== 'object') return;
        const copy = { ...panel, widgets: Array.isArray(panel.widgets) ? panel.widgets : [] };
        if (_isDashboardStandalonePanel(copy)) standaloneWidgets.push(...copy.widgets);
        else sectionPanels.push(copy);
    });
    if (sectionPanels.length) {
        if (standaloneWidgets.length) {
            sectionPanels[0] = {
                ...sectionPanels[0],
                widgets: [...standaloneWidgets, ...(sectionPanels[0].widgets || [])],
            };
        }
        return sectionPanels;
    }
    const looseWidgets = !panels.length && Array.isArray(rawWidgets) ? rawWidgets : [];
    const widgets = [...standaloneWidgets, ...looseWidgets];
    if (!widgets.length) return [];
    return [{
        id: 'panel_1',
        title: 'Panou',
        size: 'wide',
        icon: '',
        pages: [],
        show_pagination: true,
        widgets,
    }];
}

function _dashboardViewCachePayload(payload = {}) {
    const normalized = _normalizeCache(payload);
    return {
        ...normalized,
        available_entities: [],
        cached_at: Date.now(),
    };
}

function _saveDashboardViewCache(payload = _dashboardCache) {
    try {
        localStorage.setItem(DASHBOARD_LOCAL_KEY, JSON.stringify(_dashboardViewCachePayload(payload)));
    } catch (_) {}
}

function _readDashboardViewCache() {
    try {
        const raw = localStorage.getItem(DASHBOARD_LOCAL_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const normalized = _normalizeCache(parsed);
        if (!normalized.panels.length && !normalized.widgets.length && !normalized.pages.length) return null;
        return normalized;
    } catch (_) {
        return null;
    }
}

function _renderCachedDashboardIfEmpty() {
    const grid = document.getElementById('dashboard-grid');
    if (!grid || grid.firstElementChild) return false;
    const cached = _readDashboardViewCache();
    if (!cached) return false;
    _dashboardCache = {
        ...cached,
        available_entities: Array.isArray(_dashboardCache.available_entities) ? _dashboardCache.available_entities : [],
    };
    if (_dashboardCache.page_id) _currentPageId = _dashboardCache.page_id;
    _renderDashboard();
    return true;
}

// ===========================================================================
// Per-page snapshot cache. Lets us render the new page INSTANTLY when the
// user switches, then refresh silently in the background.
// ===========================================================================
const DASHBOARD_PAGE_SNAPSHOTS_KEY = 'hyve.dash.pageSnapshots';
const DASHBOARD_PAGE_SNAPSHOTS_VERSION = '2';
const DASHBOARD_PAGE_SNAPSHOTS_VERSION_KEY = 'hyve.dash.pageSnapshots.v';
const DASHBOARD_PAGE_SNAPSHOTS_MAX = 24;
const _dashboardPageSnapshots = new Map(); // pageId -> normalized cache (panels/widgets/title/...)
let _dashboardPageSnapshotsHydrated = false;

function _hydrateDashboardPageSnapshots() {
    if (_dashboardPageSnapshotsHydrated) return;
    _dashboardPageSnapshotsHydrated = true;
    try {
        // Drop the cache if the schema version changed (avoids feeding stale
        // shapes into _normalizeCache after an app upgrade).
        const v = localStorage.getItem(DASHBOARD_PAGE_SNAPSHOTS_VERSION_KEY);
        if (v !== DASHBOARD_PAGE_SNAPSHOTS_VERSION) {
            localStorage.removeItem(DASHBOARD_PAGE_SNAPSHOTS_KEY);
            localStorage.setItem(DASHBOARD_PAGE_SNAPSHOTS_VERSION_KEY, DASHBOARD_PAGE_SNAPSHOTS_VERSION);
            return;
        }
        const raw = localStorage.getItem(DASHBOARD_PAGE_SNAPSHOTS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            for (const [pid, snap] of Object.entries(parsed)) {
                if (pid && snap && typeof snap === 'object' && Array.isArray(snap.panels)) {
                    _dashboardPageSnapshots.set(String(pid), snap);
                }
            }
        }
    } catch (_) {}
}

function _persistDashboardPageSnapshots() {
    try {
        // Keep map bounded; drop oldest if needed.
        if (_dashboardPageSnapshots.size > DASHBOARD_PAGE_SNAPSHOTS_MAX) {
            const overflow = _dashboardPageSnapshots.size - DASHBOARD_PAGE_SNAPSHOTS_MAX;
            const keys = Array.from(_dashboardPageSnapshots.keys()).slice(0, overflow);
            for (const k of keys) _dashboardPageSnapshots.delete(k);
        }
        const obj = {};
        for (const [pid, snap] of _dashboardPageSnapshots) obj[pid] = snap;
        localStorage.setItem(DASHBOARD_PAGE_SNAPSHOTS_KEY, JSON.stringify(obj));
    } catch (_) {}
}

function _stashDashboardPageSnapshot(pageId, cache) {
    if (!pageId || !cache) return;
    _hydrateDashboardPageSnapshots();
    const lite = {
        panels: cache.panels || [],
        widgets: cache.widgets || [],
        pages: cache.pages || [],
        preferences: cache.preferences || DEFAULT_PREFS,
        title: cache.title || DEFAULT_META.title,
        subtitle: cache.subtitle || DEFAULT_META.subtitle,
        icon: cache.icon || '',
        columns: cache.columns || 0,
        page_id: cache.page_id || pageId,
        current_page_id: cache.current_page_id || pageId,
        cached_at: Date.now(),
    };
    _dashboardPageSnapshots.delete(String(pageId)); // re-insert for recency
    _dashboardPageSnapshots.set(String(pageId), lite);
    _persistDashboardPageSnapshots();
}

function _getDashboardPageSnapshot(pageId) {
    if (!pageId) return null;
    _hydrateDashboardPageSnapshots();
    return _dashboardPageSnapshots.get(String(pageId)) || null;
}

function _dashboardSnapshotFingerprint(snap) {
    if (!snap) return '';
    // Cheap structural hash; ignores volatile fields like cached_at + available_entities.
    try {
        return JSON.stringify({
            p: snap.panels,
            t: snap.title,
            s: snap.subtitle,
            i: snap.icon,
            c: snap.columns,
            pr: snap.preferences,
        });
    } catch (_) { return String(Date.now()); }
}

// Fetch a page's config WITHOUT touching the global cache; used for background
// prefetch + silent refresh.
async function _fetchDashboardPageSnapshot(pageId) {
    if (!pageId) return null;
    try {
        const params = new URLSearchParams();
        params.set('page_id', pageId);
        params.set('include_entities', 'false');
        const res = await apiCall(`/api/dashboard/widgets?${params.toString()}`);
        if (!res.ok) return null;
        const payload = await res.json();
        const normalized = _normalizeCache(payload);
        _stashDashboardPageSnapshot(pageId, normalized);
        return normalized;
    } catch (_) { return null; }
}

let _dashboardPrefetchTimer = null;
function _schedulePagePrefetch() {
    // Prefetch disabled: it floods the backend `_AVAIL_BUILD_LOCK` (TTL 5s)
    // and starves the foreground request. Live WS keeps cards fresh; we'll
    // rely on the per-page snapshot cache populated as the user navigates.
}

let _dashboardRefreshIndicatorSafetyTimer = null;
function _setDashboardRefreshIndicator(active) {
    let bar = document.getElementById('dashboard-refresh-bar');
    if (!bar) {
        const grid = document.getElementById('dashboard-grid');
        if (!grid || !grid.parentElement) return;
        bar = document.createElement('div');
        bar.id = 'dashboard-refresh-bar';
        bar.style.cssText = 'position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,var(--accent,#6366f1),transparent);background-size:200% 100%;animation:hyveDashRefresh 1.1s linear infinite;opacity:0;transition:opacity .2s;z-index:5;pointer-events:none;';
        if (!document.getElementById('hyve-dash-refresh-style')) {
            const st = document.createElement('style');
            st.id = 'hyve-dash-refresh-style';
            st.textContent = '@keyframes hyveDashRefresh{0%{background-position:200% 0}100%{background-position:-200% 0}}';
            document.head.appendChild(st);
        }
        const host = grid.parentElement;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(bar);
    }
    bar.style.opacity = active ? '1' : '0';
    // Safety: never leave the indicator running for more than 15s, even if
    // the caller forgot (or couldn't) clear it (hung request, navigation, etc.).
    if (_dashboardRefreshIndicatorSafetyTimer) {
        clearTimeout(_dashboardRefreshIndicatorSafetyTimer);
        _dashboardRefreshIndicatorSafetyTimer = null;
    }
    if (active) {
        _dashboardRefreshIndicatorSafetyTimer = setTimeout(() => {
            const b = document.getElementById('dashboard-refresh-bar');
            if (b) b.style.opacity = '0';
            _dashboardRefreshIndicatorSafetyTimer = null;
        }, 15000);
    }
}

function _withDashboardTimeout(promise, ms, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message || 'Dashboard refresh timeout')), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

async function _fetchDashboardLayoutJson(url, timeoutMs = 8000, externalSignal = null) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    let externalAborted = false;
    const onExternalAbort = () => {
        externalAborted = true;
        try { ctrl.abort(); } catch (_) {}
    };
    if (externalSignal) {
        if (externalSignal.aborted) onExternalAbort();
        else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const headers = {};
    const token = localStorage.getItem('hyve_token') || '';
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
        let res = await fetch(url, { headers, signal: ctrl.signal, cache: 'no-store' });
        if (res.status === 401) {
            const refreshToken = localStorage.getItem('hyve_refresh_token') || '';
            if (refreshToken) {
                const refreshRes = await fetch('/api/token/refresh', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refresh_token: refreshToken }),
                    signal: ctrl.signal,
                });
                if (refreshRes.ok) {
                    const data = await refreshRes.json();
                    if (data?.access_token) localStorage.setItem('hyve_token', data.access_token);
                    if (data?.refresh_token) localStorage.setItem('hyve_refresh_token', data.refresh_token);
                    headers.Authorization = `Bearer ${data.access_token}`;
                    res = await fetch(url, { headers, signal: ctrl.signal, cache: 'no-store' });
                }
            }
        }
        if (!res.ok) throw new Error(`Dashboard page request failed (${res.status})`);
        return await res.json();
    } catch (err) {
        if (err && err.name === 'AbortError') {
            if (timedOut) throw new Error('Refresh-ul dashboardului a expirat.');
            const abortErr = new Error('Dashboard refresh superseded.');
            abortErr.name = 'DashboardRefreshAbortError';
            throw abortErr;
        }
        throw err;
    } finally {
        clearTimeout(timeoutId);
        if (externalSignal) {
            try { externalSignal.removeEventListener('abort', onExternalAbort); } catch (_) {}
        }
    }
}

function _dashboardControlPending(widgetId) {
    return _dashboardPendingControls.has(String(widgetId || ''));
}

function _dashboardControlVisuallyPending(widgetId) {
    const pending = _dashboardPendingControls.get(String(widgetId || ''));
    if (!pending) return false;
    return Date.now() - Number(pending.startedAt || 0) <= DASHBOARD_PENDING_VISUAL_MS;
}

function _dashboardPendingForEntity(entityId) {
    const target = String(entityId || '');
    if (!target) return null;
    for (const entry of _dashboardPendingControls.values()) {
        if (entry && entry.entityId === target) return entry;
    }
    return null;
}

function _dashboardExpectedStateForEntity(entityId) {
    const target = String(entityId || '');
    if (!target) return null;
    const pending = _dashboardPendingForEntity(target);
    if (pending?.nextState != null) return String(pending.nextState);
    const guard = _dashboardOptimisticGuards.get(target);
    if (!guard) return null;
    if (Date.now() > guard.until) {
        _dashboardOptimisticGuards.delete(target);
        return null;
    }
    return String(guard.state);
}

function _shouldHoldDashboardOptimisticState(entityId, incomingState) {
    const expected = _dashboardExpectedStateForEntity(entityId);
    if (expected == null) return false;
    const matches = String(incomingState || '').toLowerCase() === expected.toLowerCase();
    if (matches) {
        _dashboardOptimisticGuards.delete(String(entityId || ''));
        const pending = _dashboardPendingForEntity(entityId);
        if (pending) _dashboardPendingControls.delete(pending.widgetId);
        return false;
    }
    return true;
}

function _isControllableDomain(domain) {
    return ['light', 'switch', 'script', 'input_boolean', 'cover', 'lock', 'vacuum', 'climate', 'media_player', 'fan'].includes(String(domain || '').toLowerCase());
}

// Resolves the effective renderer (card type). Dedicated card types (fusion_solar,
// camera, gauge, …) win over a stale generic renderer saved as "button".
function _widgetRenderer(widget) {
    const kind = _effectiveWidgetCardType(widget);
    if (kind && kind !== 'button' && kind !== 'tile') return kind;
    const eid = String(widget?.entity_id || '');
    if (eid.startsWith('image.')) return 'picture';
    return kind || 'button';
}

function _dashboardIntentAction(widget, desiredState) {
    const domain = String(widget?.domain || widget?.entity_id?.split?.('.')[0] || '').toLowerCase();
    const kind = String(widget?.renderer || widget?.type || '').toLowerCase();
    const switchStyle = Boolean(widget?.switch_style || kind === 'switch');
    if (
        switchStyle
        || ['light', 'switch', 'fan', 'input_boolean', 'cover', 'lock'].includes(domain)
        || ['light', 'switch'].includes(kind)
    ) {
        return desiredState === 'on' ? 'turn_on' : 'turn_off';
    }
    return '';
}

function _isInfoDomain(domain) {
    return ['sensor', 'binary_sensor', 'weather', 'person', 'sun', 'device_tracker', 'update'].includes(String(domain || '').toLowerCase());
}

function _entityIcon(domain) {
    switch (String(domain || '').toLowerCase()) {
        case 'light': return 'fas fa-lightbulb';
        case 'switch': return 'fas fa-toggle-on';
        case 'cover': return 'fas fa-blinds';
        case 'climate': return 'fas fa-temperature-half';
        case 'media_player': return 'fas fa-music';
        case 'lock': return 'fas fa-lock';
        case 'sensor': return 'fas fa-gauge-high';
        case 'binary_sensor': return 'fas fa-circle-dot';
        case 'vacuum': return 'fas fa-broom';
        case 'person': return 'fas fa-user';
        case 'camera': return 'fas fa-video';
        default: return 'fas fa-bolt';
    }
}

function _dashboardCardMeta(type) {
    const id = String(type || '').trim();
    const cards = Array.isArray(_dashboardCardCatalogCache) ? _dashboardCardCatalogCache : [];
    return cards.find(card => card && card.id === id) || {};
}

function _entityAllowedForCard(item, type = 'button') {
    const domain = String(item?.domain || item?.entity_id?.split?.('.')[0] || '').toLowerCase();
    const meta = _dashboardCardMeta(type);
    const renderer = String(meta.renderer || type || '').toLowerCase();
    const filter = String(meta.entity_filter || (renderer === 'label' ? 'none' : (renderer === 'info' ? 'all' : 'controllable'))).toLowerCase();
    if (filter === 'none') return false;
    if (filter === 'all') return true;
    if (filter === 'controllable') return item?.controllable !== false;
    if (filter === 'weather') return domain === 'weather';
    if (filter === 'climate') return domain === 'climate';
    if (filter === 'scene') return domain === 'scene';
    return domain === filter;
}

function _dashboardDefaultRowsForType(type) {
    const renderer = String(_dashboardCardMeta(type).renderer || type || '').toLowerCase();
    if (renderer === 'climate') return 2;
    if (renderer === 'weather_rich') return 3;
    if (renderer === 'fusion_solar') return 2;
    if (renderer === 'gauge') return 2;
    if (renderer === 'camera' || renderer === 'picture') return 3;
    return 1;
}

function _dashboardEditorRenderer(type) {
    const renderer = String(_dashboardCardMeta(type).renderer || type || '').trim().toLowerCase();
    const editingWidget = _dashboardCurrentEditorId ? _findWidget(_dashboardCurrentEditorId) : null;
    const editingRenderer = editingWidget ? _widgetRenderer(editingWidget) : '';
    if (editingRenderer === 'camera') return 'camera';
    return renderer || 'button';
}

// Normalize an icon spec to a full CSS class string for use in `<i class="...">`.
function _iconClass(spec) {
    const normalized = normalizeIconClass(spec);
    return normalized || 'fas fa-bolt';
}

// State-aware icon — different glyph for on/off where it makes sense.
function _entityIconForState(domain, on) {
    const d = String(domain || '').toLowerCase();
    switch (d) {
        case 'switch':       return on ? 'fas fa-toggle-on'   : 'fas fa-toggle-off';
        case 'light':        return on ? 'fas fa-lightbulb'   : 'far fa-lightbulb';
        case 'lock':         return on ? 'fas fa-lock'        : 'fas fa-lock-open';
        case 'cover':        return on ? 'fas fa-blinds-open' : 'fas fa-blinds';
        case 'media_player': return on ? 'fas fa-play'        : 'fas fa-music';
        case 'binary_sensor':return on ? 'fas fa-circle-dot'  : 'far fa-circle';
        case 'fan':          return on ? 'fas fa-fan'         : 'far fa-circle';
        default:             return _entityIcon(domain);
    }
}

function _setEntitySelectState(message, disabled = true, mode = 'add') {
    const input = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-select' : 'dashboard-entity-select');
    const list = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-options' : 'dashboard-entity-options');
    if (!input) return;
    input.disabled = !!disabled;
    input.value = '';
    input.dataset.currentValue = '';
    input.placeholder = message;
    if (list) list.innerHTML = '';
}

function _getEntitySearchValue(input) {
    return String(input?.value || '').trim().toLowerCase();
}

function _entityMatchesSearch(item, query) {
    if (!query) return true;
    const aliases = Array.isArray(item?.aliases) ? item.aliases : [];
    const haystack = [item?.name, item?.entity_id, item?.source, item?.domain, ...aliases]
        .map(value => String(value || '').toLowerCase())
        .join(' ');
    return haystack.includes(query);
}

function _entityOptionLabel(item) {
    const sourcePrefix = item?.source && item.source !== 'zigbee2mqtt' ? `${String(item.source).toUpperCase()} • ` : '';
    return `${sourcePrefix}${item?.name || item?.entity_id} • ${item?.entity_id}`;
}

function _resolveEntityMatch(input, type = 'button') {
    if (!input || type === 'label') return null;
    const raw = String(input.value || '').trim();
    if (!raw) return null;

    const allItems = Array.isArray(_dashboardCache.available_entities) ? _dashboardCache.available_entities : [];

    // The picker writes the chosen entity_id into dataset.currentValue. Trust
    // that first so that entities marked controllable=false (e.g. mosquitto
    // fallback) can still be selected via the picker.
    const currentId = input.dataset.currentValue;
    if (currentId) {
        const direct = allItems.find(item => item.entity_id === currentId);
        if (direct && _entityAllowedForCard(direct, type)) return direct;
    }

    // Fallback: text matching against the visible label / id / name. Search
    // across ALL entities (don't filter by controllable) — the picker shows
    // them all, so resolution must accept them all.
    const items = allItems.filter(item => _entityAllowedForCard(item, type));

    const normalized = raw.toLowerCase();
    const exact = items.find(item => {
        const candidates = [item.entity_id, item.name, _entityOptionLabel(item)];
        return candidates.some(value => String(value || '').toLowerCase() === normalized);
    });
    if (exact) {
        input.dataset.currentValue = exact.entity_id;
        input.value = _entityOptionLabel(exact);
        return exact;
    }

    const matches = items.filter(item => _entityMatchesSearch(item, normalized));
    if (matches.length === 1) {
        input.dataset.currentValue = matches[0].entity_id;
        input.value = _entityOptionLabel(matches[0]);
        return matches[0];
    }

    return null;
}

function _syncPreferenceControls() {
    const prefs = _dashboardCache.preferences || DEFAULT_PREFS;

    const titleEl = document.getElementById('dashboard-page-title');
    const titleInput = document.getElementById('dashboard-page-title-input');
    const pageLayoutInput = document.getElementById('dashboard-page-layout-mode');
    const pageHideInput = document.getElementById('dashboard-page-hide-unavailable');
    const effectiveTitle = _dashboardCache.title || DEFAULT_META.title;
    if (titleEl) titleEl.textContent = effectiveTitle;
    if (titleInput) titleInput.value = effectiveTitle;
    if (pageLayoutInput) pageLayoutInput.value = prefs.layout_mode || DEFAULT_PREFS.layout_mode;
    if (pageHideInput) pageHideInput.checked = !prefs.show_unavailable;

    // Reflect the active page title in the global header (where it used to say "Dashboard").
    const headerTitleEl = document.getElementById('current-view-title');
    if (headerTitleEl) {
        const onDashTab = (() => {
            const view = document.getElementById('view-dashboard');
            return !!view && !view.classList.contains('hidden');
        })();
        if (onDashTab) headerTitleEl.textContent = effectiveTitle;
    }
    // Cache the resolved title so the next tab switch can render it instantly
    // instead of flashing "Dashboard" while the page config is fetched.
    try { if (effectiveTitle) localStorage.setItem('hyve.lastDashboardTitle', effectiveTitle); } catch (_) {}

    // Keep the sidebar pages list in sync with the active page's title.
    const activeId = _currentPageId || _dashboardCache.current_page_id || _dashboardCache.page_id;
    if (activeId && Array.isArray(_dashboardCache.pages)) {
        const page = _dashboardCache.pages.find(p => p && String(p.id) === String(activeId));
        if (page && page.title !== effectiveTitle) {
            page.title = effectiveTitle;
        }
    }

    const layoutBtn = document.getElementById('dashboard-layout-toggle');
    if (layoutBtn) {
        const compact = prefs.layout_mode === 'compact';
        layoutBtn.dataset.mode = compact ? 'compact' : 'comfortable';
        layoutBtn.innerHTML = compact
            ? `<i class="fas fa-table-cells mr-1.5"></i>${t('dashboard.layout_compact')}`
            : `<i class="fas fa-grip mr-1.5"></i>${t('dashboard.layout_comfortable')}`;
    }

    const hideCb = document.getElementById('dashboard-hide-unavailable');
    if (hideCb) hideCb.checked = !prefs.show_unavailable;

    const editModeLabel = document.getElementById('dashboard-edit-mode-label');
    const editModeIcon = document.getElementById('dashboard-edit-mode-icon');
    if (editModeLabel) editModeLabel.textContent = _dashboardEditMode ? t('dashboard.done') : t('dashboard.edit_mode');
    if (editModeIcon) editModeIcon.className = _dashboardEditMode ? 'fas fa-check' : 'fas fa-pen-to-square';

    const editModeLabelMenu = document.getElementById('dashboard-edit-mode-label-menu');
    const editModeIconMenu = document.getElementById('dashboard-edit-mode-icon-menu');
    if (editModeLabelMenu) editModeLabelMenu.textContent = _dashboardEditMode ? t('dashboard.done') : t('common.edit');
    if (editModeIconMenu) editModeIconMenu.className = _dashboardEditMode ? 'fas fa-check w-4' : 'fas fa-pen-to-square w-4';
}

function _updateStats() {
    const widgets = Array.isArray(_dashboardCache.widgets) ? _dashboardCache.widgets : [];
    const count = document.getElementById('dashboard-count');
    if (count) count.textContent = String(widgets.length);
}

function _filteredWidgets() {
    return Array.isArray(_dashboardCache.widgets) ? _dashboardCache.widgets : [];
}

/**
 * Resolve a widget object by its id from anywhere in the dashboard cache
 * (top-level widgets, panel widgets, paged widgets/panels). Used by the
 * Hyveview bridge to configure mounted custom-element cards.
 */
function _dashboardWidgetById(widgetId) {
    if (!widgetId) return null;
    const id = String(widgetId);
    const walk = (list) => {
        if (!Array.isArray(list)) return null;
        for (const w of list) {
            if (w && String(w.id) === id) return w;
        }
        return null;
    };
    const hit = walk(_dashboardCache.widgets);
    if (hit) return hit;
    if (Array.isArray(_dashboardCache.panels)) {
        for (const p of _dashboardCache.panels) {
            const h = walk(p && p.widgets);
            if (h) return h;
        }
    }
    if (Array.isArray(_dashboardCache.pages)) {
        for (const pg of _dashboardCache.pages) {
            if (!pg) continue;
            const h = walk(pg.widgets);
            if (h) return h;
            if (Array.isArray(pg.panels)) {
                for (const p of pg.panels) {
                    const h2 = walk(p && p.widgets);
                    if (h2) return h2;
                }
            }
        }
    }
    return null;
}

let _entityPatcher = null;
let _dashboardLive = null;

function _ensureDashboardEntityLive() {
    if (!_entityPatcher) {
        _entityPatcher = createDashboardEntityPatcher({
            HVBridge,
            getCache: () => _dashboardCache,
            shouldHoldOptimisticState: _shouldHoldDashboardOptimisticState,
            pendingForEntity: _dashboardPendingForEntity,
            clearPendingControl: (widgetId) => _dashboardPendingControls.delete(widgetId),
            climateConfiguredIds,
            cameraWidgetEntities: _cameraWidgetEntities,
            widgetRenderer: _widgetRenderer,
            widgetById: _dashboardWidgetById,
            renderDashboard: _renderDashboard,
        });
        _dashboardLive = createDashboardLiveWs({
            apiCall,
            dashDebug,
            DASH_DEBUG_ENABLED,
            onLiveItems: (items, isSnapshot) => _entityPatcher.applyLiveItems(items, isSnapshot),
            onLiveRemoved: (entityIds) => _entityPatcher.removeLiveItems(entityIds),
        });
        _dashboardLive.initTabWatch();
    }
    return { patcher: _entityPatcher, live: _dashboardLive };
}

function _dashboardWidgetEntityIds(widget) {
    return _ensureDashboardEntityLive().patcher.widgetEntityIds(widget);
}

function _configureHyveviewMounted(root) {
    _ensureDashboardEntityLive().patcher.configureHyveviewMounted(root);
}

function _tryFastPathForEntities(entityIds) {
    return _ensureDashboardEntityLive().patcher.tryFastPathForEntities(entityIds);
}

export function disconnectDashboardLive() {
    if (_dashboardLive) _dashboardLive.disconnectDashboardLive();
}

export function resumeDashboardCameras() {
    if (_dashboardLive) _dashboardLive.resumeDashboardCameras();
}

function _connectDashboardLive() {
    _ensureDashboardEntityLive().live.connectDashboardLive();
}

function _isDashboardStandalonePanel(panel) {
    return String(panel?.id || '') === DASHBOARD_STANDALONE_PANEL_ID || panel?.kind === 'standalone';
}

function _makeDashboardStandalonePanel(widgets = []) {
    return {
        id: DASHBOARD_STANDALONE_PANEL_ID,
        title: '',
        size: 'wide',
        icon: '',
        pages: [],
        show_pagination: false,
        kind: 'standalone',
        widgets: Array.isArray(widgets) ? widgets : [],
    };
}

function _ensureDashboardStandalonePanelLocal() {
    const panels = Array.isArray(_dashboardCache.panels) ? _dashboardCache.panels : [];
    let panel = panels.find(_isDashboardStandalonePanel);
    if (panel) return panel;
    panel = _makeDashboardStandalonePanel();
    panels.unshift(panel);
    _dashboardCache.panels = panels;
    return panel;
}

function _positionDashboardMenu() {
    const menu = document.getElementById('dashboard-more-menu');
    if (!menu || menu.classList.contains('hidden')) return;

    menu.style.transform = 'translateX(0)';
    const padding = 8;
    const rect = menu.getBoundingClientRect();

    if (rect.right > window.innerWidth - padding) {
        const shift = rect.right - (window.innerWidth - padding);
        menu.style.transform = `translateX(-${shift}px)`;
        return;
    }
    if (rect.left < padding) {
        const shift = padding - rect.left;
        menu.style.transform = `translateX(${shift}px)`;
    }
}

function _setDashboardMenuOpen(open) {
    const menu = document.getElementById('dashboard-more-menu');
    const btn = document.getElementById('dashboard-menu-button');
    if (!menu) return;
    menu.classList.toggle('hidden', !open);
    if (btn) btn.classList.toggle('is-open', !!open);
    if (open) requestAnimationFrame(_positionDashboardMenu);
}

export function toggleDashboardMenu() {
    const menu = document.getElementById('dashboard-more-menu');
    if (!menu) return;
    _setDashboardMenuOpen(menu.classList.contains('hidden'));
}

export function closeDashboardMenu() {
    _setDashboardMenuOpen(false);
}

export function resetDashboardEditingState() {
    // Leaving the dashboard should cancel any visual loading state. A pending
    // request may still finish, but it must not keep the top bar stuck when
    // the user comes back from another tab.
    try { _dashboardPageNavToken += 1; } catch (_) {}
    try { _setDashboardRefreshIndicator(false); } catch (_) {}
    _dashboardEditMode = false;
    document.documentElement.removeAttribute('data-dashboard-editing');
    _dashboardCurrentEditorId = null;
    closeDashboardMenu();
    closeDashboardAddModal();
    closeDashboardPageModal();
    closeDashboardWidgetEditor();
    const grid = document.getElementById('dashboard-grid');
    const view = document.getElementById('view-dashboard');
    const onDashboardTab = !!view && !view.classList.contains('hidden');
    if (grid && onDashboardTab) _renderDashboard();
}

// ── Section / card conditional visibility + background (HA-style) ──────────
// The server folds entity + user conditions into a `visible` boolean. Screen /
// media-query conditions are device-dependent, so the client resolves those
// here as an additional AND gate and re-renders on viewport changes.
function _dashboardScreenGate(visibility) {
    if (!visibility || visibility.enabled === false) return true;
    const conditions = Array.isArray(visibility.conditions) ? visibility.conditions : [];
    const screens = conditions.filter(c => String((c && (c.condition || c.type)) || '').toLowerCase() === 'screen' && (c.media || c.value));
    if (!screens.length) return true;
    return screens.every(c => {
        const query = String(c.media || c.value || '').trim();
        if (!query) return true;
        try { return window.matchMedia(query).matches; } catch (_) { return true; }
    });
}

function _dashboardElementVisible(obj) {
    if (_dashboardEditMode) return true;
    if (!obj) return true;
    if (obj.visible === false) return false;
    return _dashboardScreenGate(obj.visibility);
}

function _visibleDashboardWidgets(list) {
    const widgets = Array.isArray(list) ? list : [];
    if (_dashboardEditMode) return widgets;
    return widgets.filter(_dashboardElementVisible);
}

function _hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
    if (!m) return '';
    const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    const a = (typeof alpha === 'number' && alpha >= 0 && alpha <= 1) ? alpha : 1;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function _dashboardPanelBackgroundCss(panel) {
    const bg = panel && panel.background;
    if (!bg || !bg.color) return '';
    const opacity = (typeof bg.opacity === 'number') ? bg.opacity : 1;
    return _hexToRgba(bg.color, opacity);
}

let _dashboardScreenWatchBound = false;
function _bindDashboardScreenWatch() {
    if (_dashboardScreenWatchBound) return;
    _dashboardScreenWatchBound = true;
    let raf = null;
    window.addEventListener('resize', () => {
        if (_dashboardEditMode) return;
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            const view = document.getElementById('view-dashboard');
            if (view && !view.classList.contains('hidden')) _renderDashboard();
        });
    }, { passive: true });
}

function _renderDashboard() {
    const grid = document.getElementById('dashboard-grid');
    if (!grid) return;
    _bindDashboardScreenWatch();

    teardownDashboardSortables();

    _syncPreferenceControls();
    _updateStats();
    _renderDashboardPagesList();

    const compact = (_dashboardCache.preferences || DEFAULT_PREFS).layout_mode === 'compact';
    const panels = Array.isArray(_dashboardCache.panels) ? _dashboardCache.panels : [];
    const sectionPanels = panels.filter(panel => !_isDashboardStandalonePanel(panel));
    const hasGroupedPanels = sectionPanels.length > 0;

    // Reset grid container styling — when grouped we use HA-like responsive sections.
    if (hasGroupedPanels) {
        grid.className = _dashboardEditMode
            ? 'dashboard-panels-stack dashboard-panel__grid--editing'
            : 'dashboard-panels-stack';
        grid.removeAttribute('data-panel-grid');
    } else {
        const standaloneGridClass = compact
            ? 'grid dashboard-panel__grid dashboard-panel__grid--compact dashboard-panel__grid--standalone'
            : 'grid dashboard-panel__grid dashboard-panel__grid--standalone';
        grid.className = _dashboardEditMode
            ? `${standaloneGridClass} dashboard-panel__grid--editing`
            : standaloneGridClass;
        grid.setAttribute('data-panel-grid', '');
    }

    // Empty state — no panels at all, or all panels empty.
    const totalWidgets = panels.reduce((acc, p) => acc + (Array.isArray(p.widgets) ? p.widgets.length : 0), 0)
        || _filteredWidgets().length;
    if (!totalWidgets && !hasGroupedPanels) {
        if (_dashboardEditMode) {
            grid.className = 'dashboard-panels-stack';
            grid.removeAttribute('data-panel-grid');
            grid.innerHTML = `
                <button type="button" class="dashboard-panel dashboard-panel--add-section" data-dash-action="openPanelCreator" aria-label="${_escape(t('dashboard.aria.add_section'))}">
                    <i class="fas fa-plus"></i>
                    <span>${t('dashboard.create_section') || 'Secțiune nouă'}</span>
                </button>`;
        } else {
            grid.innerHTML = `
                <div class="hyve-dashboard-empty">
                    <div class="hyve-dashboard-empty__icon"><i class="fas fa-table-cells-large"></i></div>
                    <h3 class="hyve-dashboard-empty__title">Dashboard gol</h3>
                    <p class="hyve-dashboard-empty__sub">Apasă pe cele 3 puncte din dreapta sus ca să adaugi un card sau un panou.</p>
                </div>`;
        }
        setupDashboardSortables();
        return;
    }

    if (!hasGroupedPanels) {
        const standalonePanel = panels.find(_isDashboardStandalonePanel);
        const widgets = standalonePanel
            ? (standalonePanel.widgets || [])
            : panels.length
            ? (panels[0].widgets || [])
            : _filteredWidgets();
        grid.innerHTML = _visibleDashboardWidgets(widgets).map(widget => _renderWidgetCard(widget)).join('');
        _enhanceSparklines();
        try { _configureHyveviewMounted(grid); } catch (_) {}
        setupDashboardSortables();
        try { resumeDashboardCameras(); } catch (_) {}
        return;
    }

    const items = sectionPanels.map(panel => _renderPanelSection(panel, compact));
    const addSectionBtn = _dashboardEditMode
        ? `<button type="button" class="dashboard-panel dashboard-panel--add-section" data-dash-action="openPanelCreator" aria-label="${_escape(t('dashboard.aria.add_section'))}">
                <i class="fas fa-plus"></i>
                <span>${t('dashboard.create_section') || 'Secțiune nouă'}</span>
           </button>`
        : '';
    grid.innerHTML = items.join('') + addSectionBtn;
    _enhanceSparklines();
        try { _configureHyveviewMounted(grid); } catch (_) {}
    syncDashboardPanelGridSpans();
    setupDashboardSortables();
    try { resumeDashboardCameras(); } catch (_) {}
}

const _panelActivePage = new Map(); // panel.id -> active page id

function _renderStandaloneDashboardItems(panel) {
    const widgets = _visibleDashboardWidgets(Array.isArray(panel?.widgets) ? panel.widgets : []);
    if (!widgets.length && !_dashboardEditMode) return '';
    if (widgets.length) return widgets.map(widget => _renderWidgetCard(widget)).join('');
    return '<div class="dashboard-standalone-drop-hint dashboard-standalone-drop-hint--root">Carduri fără secțiune</div>';
}

function _renderStandaloneDashboardPanel(panel, compact) {
    const widgets = Array.isArray(panel?.widgets) ? panel.widgets : [];
    if (!widgets.length && !_dashboardEditMode) return '';
    const gridClass = compact
        ? 'dashboard-panel__grid dashboard-panel__grid--compact dashboard-panel__grid--standalone'
        : 'dashboard-panel__grid dashboard-panel__grid--standalone';
    const gridClassFull = _dashboardEditMode
        ? `${gridClass} dashboard-panel__grid--editing`
        : gridClass;
    const body = widgets.length
        ? widgets.map(widget => _renderWidgetCard(widget)).join('')
        : '<div class="dashboard-standalone-drop-hint">Carduri fără secțiune</div>';
    return `
        <section class="dashboard-panel dashboard-panel--standalone" data-panel-kind="standalone" data-empty="${widgets.length ? 'false' : 'true'}">
            <div class="${gridClassFull}" data-panel-grid="${DASHBOARD_STANDALONE_PANEL_ID}">${body}</div>
        </section>`;
}

/**
 * Lay sections out on the free 2D grid: measure each section's content height
 * (to derive its row span), then pack them so stored positions are honored and
 * the rest fall into the first free slot — never overlapping.
 */

function _renderPanelSection(panel, compact) {
    const panelId = String(panel.id || '');
    if (!_dashboardElementVisible(panel)) return '';
    const widgets = Array.isArray(panel.widgets) ? panel.widgets : [];
    const pages = Array.isArray(panel.pages) ? panel.pages : [];
    const showTabs = pages.length > 0 && panel.show_pagination !== false;

    // Determine active page (per-panel) and filter widgets accordingly.
    let activePageId = _panelActivePage.get(panelId);
    if (showTabs) {
        if (!activePageId || !pages.some(p => String(p.id) === String(activePageId))) {
            activePageId = String(pages[0].id);
            _panelActivePage.set(panelId, activePageId);
        }
    } else {
        activePageId = null;
    }

    const visibleWidgets = _visibleDashboardWidgets(activePageId
        ? widgets.filter(w => String(w.page_id || '') === String(activePageId))
        : widgets);

    const title = String(panel.title || '').trim();
    const icon = String(panel.icon || '').trim();
    const titleHtml = title || icon || _dashboardEditMode
        ? `<div class="dashboard-panel__title">
                ${icon ? `<i class="${_escape(_iconClass(icon))} dashboard-panel__icon"></i>` : ''}
                ${title ? `<span>${_escape(title)}</span>` : ''}
            </div>`
        : '';

    const tabsHtml = showTabs
        ? `<div class="dashboard-panel__tabs" role="tablist">
                ${pages.map(p => {
                    const id = String(p.id);
                    const isActive = id === activePageId;
                    return `<button type="button" role="tab"
                        class="dashboard-panel__tab"
                        data-active="${isActive ? 'true' : 'false'}"
                        data-dash-action="selectPanelPage" data-panel-id="${_escape(panelId)}" data-page-id="${_escape(id)}">
                        ${p.icon ? `<i class="${_escape(_iconClass(p.icon))}"></i>` : ''}
                        <span>${_escape(p.title || 'Pagină')}</span>
                    </button>`;
                }).join('')}
            </div>`
        : '';

    const editControls = _dashboardEditMode
        ? `<div class="dashboard-panel__edit">
                <button type="button" class="dashboard-panel__add" data-dash-action="openAddPicker" aria-label="${_escape(t('dashboard.aria.add_card'))}"><i class="fas fa-plus"></i></button>
                <button type="button" data-dash-action="openPanelEditor" data-panel-id="${_escape(panelId)}" aria-label="${_escape(t('dashboard.aria.edit_section'))}"><i class="fas fa-pen"></i></button>
                <button type="button" class="is-danger" data-dash-action="removePanel" data-panel-id="${_escape(panelId)}" aria-label="${_escape(t('dashboard.aria.delete_section'))}"><i class="fas fa-trash"></i></button>
            </div>`
        : '';
    const dragHandle = _dashboardEditMode
        ? `<button type="button" class="dashboard-panel__drag" data-dash-pointer="panelDrag" data-panel-id="${_escape(panelId)}" title="${_escape(t('dashboard.aria.move_section'))}" aria-label="${_escape(t('dashboard.aria.move_section'))}"><i class="fas fa-grip-vertical"></i></button>`
        : '';

    const gridClass = compact
        ? 'dashboard-panel__grid dashboard-panel__grid--compact'
        : 'dashboard-panel__grid';
    const gridClassFull = _dashboardEditMode
        ? `${gridClass} dashboard-panel__grid--editing`
        : gridClass;

    const body = visibleWidgets.length
        ? `<div class="${gridClassFull}" data-panel-grid="${_escape(panelId)}">${visibleWidgets.map(w => _renderWidgetCard(w)).join('')}</div>`
        : (_dashboardEditMode
            ? `<div class="dashboard-panel__empty dashboard-panel__empty--edit" data-panel-grid="${_escape(panelId)}"><button type="button" class="dashboard-panel__add-card" data-dash-action="openAddPicker"><i class="fas fa-plus"></i></button></div>`
            : `<div class="dashboard-panel__empty" data-panel-grid="${_escape(panelId)}">Niciun card pe această pagină.</div>`);

    const headerHtml = titleHtml || editControls
        ? `<header class="dashboard-panel__header"><div class="dashboard-panel__header-main">${dragHandle}${titleHtml || '<span></span>'}</div>${editControls}</header>`
        : '';

    const span = dashboardPanelSpan(panel);
    const panelBg = _dashboardPanelBackgroundCss(panel);
    const styleVars = [
        `--panel-col-span:${span.col}`,
        span.colStart ? `--panel-col-start:${span.colStart}` : '',
        span.rowStart ? `--panel-row-start:${span.rowStart}` : '',
        `--panel-row-span:${span.row}`,
        panelBg ? `--panel-bg:${panelBg}` : '',
    ].filter(Boolean).join('; ');

    return `
        <section class="dashboard-panel" data-panel-id="${_escape(panelId)}" data-size="${_escape(panel.size || 'md')}" style="${styleVars}">
            ${headerHtml}
            ${tabsHtml}
            ${body}
        </section>`;
}

export function selectDashboardPanelPage(panelId, pageId) {
    if (!panelId || !pageId) return;
    _panelActivePage.set(String(panelId), String(pageId));
    _renderDashboard();
}

export async function removeDashboardPanel(panelId) {
    if (!requireDashboardEditAccess()) return;
    if (!panelId) return;
    const ok = await showConfirm('Ștergi această secțiune și cardurile din ea?', { title: 'Șterge secțiunea', danger: true, confirmText: 'Șterge' });
    if (!ok) return;
    try {
        const params = _currentPageId ? `?page_id=${encodeURIComponent(_currentPageId)}` : '';
        const res = await apiCall(`/api/dashboard/panels/${encodeURIComponent(panelId)}${params}`, { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(_dashApiError(err.detail, 'dashboard.section_delete_error'));
        }
        await _refreshAvailableEntities();
        _renderDashboard();
        showToast(t('dashboard.section_deleted'), 'success');
    } catch (e) {
        showToast(e.message || t('dashboard.section_delete_error'), 'error');
    }
}

function _panelModalElements() {
    return {
        modal: document.getElementById('dashboard-panel-modal'),
        modalTitle: document.getElementById('dashboard-panel-modal-title'),
        title: document.getElementById('dashboard-panel-title-input'),
        size: document.getElementById('dashboard-panel-size-input'),
        sizeOptions: Array.from(document.querySelectorAll('[data-dashboard-panel-size-option]')),
        icon: document.getElementById('dashboard-panel-icon-input'),
        showPagination: document.getElementById('dashboard-panel-show-pagination-input'),
        pagesList: document.getElementById('dashboard-panel-pages-list'),
        pagesEmpty: document.getElementById('dashboard-panel-pages-empty'),
        addPage: document.getElementById('dashboard-panel-page-add'),
    };
}

function _setDashboardPanelSize(value) {
    const els = _panelModalElements();
    const normalized = ['sm', 'md', 'wide'].includes(value) ? value : 'sm';
    if (els.size) els.size.value = normalized;
    _syncDashboardCustomSelect(els.size);
    els.sizeOptions.forEach(option => {
        const isActive = option.getAttribute('data-dashboard-panel-size-option') === normalized;
        option.dataset.active = isActive ? 'true' : 'false';
        option.setAttribute('aria-checked', isActive ? 'true' : 'false');
        option.tabIndex = isActive ? 0 : -1;
    });
}

function _openDashboardPanelModal(mode, panel = {}) {
    const els = _panelModalElements();
    if (!els.modal) return;
    _enhanceDashboardCustomSelects(els.modal);
    _dashboardPanelModalMode = mode === 'edit' ? 'edit' : 'add';
    _dashboardPanelModalPanelId = mode === 'edit' ? String(panel.id || '') : null;
    _dashboardPanelModalPages = Array.isArray(panel.pages)
        ? panel.pages.map(page => ({
            id: String(page.id || '').trim(),
            title: String(page.title || '').trim(),
            icon: String(page.icon || '').trim(),
        }))
        : [];

    if (els.modalTitle) els.modalTitle.textContent = _dashboardPanelModalMode === 'edit' ? t('dashboard.edit_section') : t('dashboard.create_section');
    if (els.title) els.title.value = _dashboardPanelModalMode === 'edit' ? String(panel.title || '') : '';
    _setDashboardPanelSize(['sm', 'md', 'wide'].includes(panel.size) ? panel.size : 'sm');
    if (els.icon) els.icon.value = String(panel.icon || '');
    if (els.showPagination) els.showPagination.checked = panel.show_pagination !== false;
    _populateDashboardPanelBackground(panel);
    _populateDashboardPanelVisibility(panel);

    _renderDashboardPanelPagesEditor();
    closeDashboardMenu();
    syncModalViewportMetrics();
    els.modal.classList.remove('hidden');
    els.modal.classList.add('flex');
    window.setTimeout(() => els.title?.focus?.(), 0);
}

function _renderDashboardPanelPagesEditor() {
    const { pagesList, pagesEmpty } = _panelModalElements();
    if (pagesEmpty) pagesEmpty.classList.toggle('hidden', _dashboardPanelModalPages.length > 0);
    if (!pagesList) return;
    if (!_dashboardPanelModalPages.length) {
        pagesList.innerHTML = '';
        return;
    }
    pagesList.innerHTML = _dashboardPanelModalPages.map((page, index) => `
        <div class="grid grid-cols-[1fr_1fr_auto] gap-2 rounded-xl border border-white/10 bg-slate-950/35 p-2" data-panel-page-row="${index}">
            <input type="text" value="${_escape(page.title || '')}" placeholder="Titlu pagină"
                class="min-w-0 rounded-lg bg-slate-950/60 border border-white/10 px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-accent/50"
                data-panel-page-title="${index}">
            <input type="text" value="${_escape(page.icon || '')}" placeholder="Icon"
                class="min-w-0 rounded-lg bg-slate-950/60 border border-white/10 px-2.5 py-2 text-xs text-slate-100 outline-none focus:border-accent/50"
                data-panel-page-icon="${index}" data-icon-picker>
            <button type="button" class="w-9 h-9 rounded-lg bg-white/5 hover:bg-red-500/10 text-slate-400 hover:text-red-300"
                aria-label="Șterge pagina" data-panel-page-remove="${index}"><i class="fas fa-trash"></i></button>
        </div>
    `).join('');
    pagesList.querySelectorAll('[data-panel-page-title]').forEach(input => {
        input.addEventListener('input', () => {
            const index = Number(input.getAttribute('data-panel-page-title'));
            if (_dashboardPanelModalPages[index]) _dashboardPanelModalPages[index].title = input.value;
        });
    });
    pagesList.querySelectorAll('[data-panel-page-icon]').forEach(input => {
        input.addEventListener('input', () => {
            const index = Number(input.getAttribute('data-panel-page-icon'));
            if (_dashboardPanelModalPages[index]) _dashboardPanelModalPages[index].icon = input.value;
        });
    });
    pagesList.querySelectorAll('[data-panel-page-remove]').forEach(button => {
        button.addEventListener('click', () => {
            const index = Number(button.getAttribute('data-panel-page-remove'));
            _dashboardPanelModalPages.splice(index, 1);
            _renderDashboardPanelPagesEditor();
        });
    });
}

function _readDashboardPanelModalBody() {
    const els = _panelModalElements();
    const title = String(els.title?.value || '').trim();
    const sizeValue = String(els.size?.value || 'md');
    return {
        title,
        size: ['sm', 'md', 'wide'].includes(sizeValue) ? sizeValue : 'md',
        icon: String(els.icon?.value || '').trim(),
        show_pagination: els.showPagination?.checked !== false,
        pages: _dashboardPanelModalPages
            .map((page, index) => ({
                id: String(page.id || '').trim() || `page_${index + 1}`,
                title: String(page.title || '').trim() || `Pagina ${index + 1}`,
                icon: String(page.icon || '').trim(),
            }))
            .slice(0, 10),
        background: _readDashboardPanelBackground(),
        visibility: _readDashboardPanelVisibility(),
    };
}

// ── Section background editor ──────────────────────────────────────────────
export function toggleDashboardPanelBackground() {
    const enabled = document.getElementById('dashboard-panel-bg-enabled');
    const body = document.getElementById('dashboard-panel-bg-body');
    if (body) body.classList.toggle('hidden', !enabled?.checked);
}

function _populateDashboardPanelBackground(panel) {
    const enabled = document.getElementById('dashboard-panel-bg-enabled');
    const body = document.getElementById('dashboard-panel-bg-body');
    const color = document.getElementById('dashboard-panel-bg-color');
    const opacity = document.getElementById('dashboard-panel-bg-opacity');
    const opacityVal = document.getElementById('dashboard-panel-bg-opacity-value');
    const bg = panel?.background || null;
    const on = !!(bg && bg.color);
    if (enabled) enabled.checked = on;
    if (body) body.classList.toggle('hidden', !on);
    if (color) color.value = (bg && bg.color) || '#1e293b';
    const pct = on && typeof bg.opacity === 'number' ? Math.round(bg.opacity * 100) : 60;
    if (opacity) opacity.value = String(pct);
    if (opacityVal) opacityVal.textContent = `${pct}%`;
}

function _readDashboardPanelBackground() {
    const enabled = document.getElementById('dashboard-panel-bg-enabled');
    if (!enabled?.checked) return null;
    const color = String(document.getElementById('dashboard-panel-bg-color')?.value || '#1e293b');
    const pct = parseInt(document.getElementById('dashboard-panel-bg-opacity')?.value || '60', 10);
    return { color, opacity: Math.min(Math.max(pct, 0), 100) / 100 };
}

// ── Section conditional visibility editor (entity / user / screen) ─────────
export function toggleDashboardPanelVisibility() {
    const enabled = document.getElementById('dashboard-panel-visibility-enabled');
    const body = document.getElementById('dashboard-panel-visibility-body');
    if (body) body.classList.toggle('hidden', !enabled?.checked);
    if (enabled?.checked) {
        const wrap = document.getElementById('dashboard-panel-visibility-conditions');
        if (wrap && !wrap.children.length) addDashboardPanelVisibilityCondition();
    }
}

const _SCREEN_PRESETS = [
    { label: 'Mobil (≤1023px)', value: '(max-width: 1023px)' },
    { label: 'Desktop (≥1024px)', value: '(min-width: 1024px)' },
];

let _panelVisCondSeq = 0;
export function addDashboardPanelVisibilityCondition(cond = null) {
    const wrap = document.getElementById('dashboard-panel-visibility-conditions');
    if (!wrap) return;
    const idx = ++_panelVisCondSeq;
    const type = String((cond && (cond.condition || cond.type)) || 'entity').toLowerCase();
    const row = document.createElement('div');
    row.className = 'rounded-xl border border-white/10 bg-white/[0.02] p-2 space-y-2';
    row.dataset.panelCond = String(idx);
    row.innerHTML = `
        <div class="flex items-center gap-2">
            <select data-pvis-field="type" class="rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
                <option value="entity">Entitate</option>
                <option value="user">Utilizator</option>
                <option value="screen">Ecran / dispozitiv</option>
            </select>
            <button type="button" data-pvis-remove class="ml-auto text-slate-500 hover:text-red-400 text-xs px-1" aria-label="Șterge condiție"><i class="fas fa-xmark"></i></button>
        </div>
        <div data-pvis-fields></div>`;
    const typeSel = row.querySelector('[data-pvis-field="type"]');
    typeSel.value = ['entity', 'user', 'screen'].includes(type) ? type : 'entity';
    const renderFields = () => {
        row.querySelector('[data-pvis-fields]').innerHTML = _panelVisibilityFieldsHtml(typeSel.value, idx, cond);
        _enhanceDashboardCustomSelects(row);
    };
    typeSel.addEventListener('change', () => { renderFields(); });
    row.querySelector('[data-pvis-remove]').addEventListener('click', () => row.remove());
    wrap.appendChild(row);
    renderFields();
    _enhanceDashboardCustomSelects(row);
}

function _panelVisibilityFieldsHtml(type, idx, cond) {
    if (type === 'user') {
        const users = Array.isArray(cond?.users) ? cond.users.join(', ') : '';
        const op = cond?.operator === 'is_not' ? 'is_not' : 'is';
        return `
            <div class="flex items-center gap-2">
                <select data-pvis-field="op" class="rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
                    <option value="is"${op === 'is' ? ' selected' : ''}>este</option>
                    <option value="is_not"${op === 'is_not' ? ' selected' : ''}>nu este</option>
                </select>
                <input type="text" data-pvis-field="users" value="${_escape(users)}" placeholder="utilizatori (separați prin virgulă)"
                    class="flex-1 min-w-0 rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
            </div>`;
    }
    if (type === 'screen') {
        const media = String(cond?.media || cond?.value || '').trim();
        const listId = `pvis-screen-${idx}`;
        return `
            <input type="text" list="${listId}" data-pvis-field="media" value="${_escape(media)}" placeholder="(max-width: 1023px)"
                class="w-full rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
            <datalist id="${listId}">${_SCREEN_PRESETS.map(p => `<option value="${_escape(p.value)}">${_escape(p.label)}</option>`).join('')}</datalist>`;
    }
    const items = Array.isArray(_dashboardCache.available_entities) ? _dashboardCache.available_entities : [];
    const listId = `pvis-ent-${idx}`;
    const opts = items.slice(0, 200).map(it => `<option value="${_escape(it.entity_id)}">${_escape(it.name || it.entity_id)}</option>`).join('');
    const ent = _escape(cond?.entity_id || '');
    const op = String(cond?.operator || cond?.op || 'is');
    const val = _escape(cond?.value != null ? String(cond.value) : '');
    const opSel = (v, label) => `<option value="${v}"${op === v ? ' selected' : ''}>${label}</option>`;
    return `
        <div class="flex items-center gap-2">
            <input type="text" list="${listId}" data-pvis-field="entity" value="${ent}" placeholder="entity_id"
                class="flex-1 min-w-0 rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
            <datalist id="${listId}">${opts}</datalist>
            <select data-pvis-field="op" class="rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
                ${opSel('is', '=')}${opSel('is_not', '≠')}${opSel('>', '&gt;')}${opSel('>=', '≥')}${opSel('<', '&lt;')}${opSel('<=', '≤')}
            </select>
            <input type="text" data-pvis-field="value" value="${val}" placeholder="valoare"
                class="w-24 rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
        </div>`;
}

function _populateDashboardPanelVisibility(panel) {
    const enabled = document.getElementById('dashboard-panel-visibility-enabled');
    const body = document.getElementById('dashboard-panel-visibility-body');
    const logic = document.getElementById('dashboard-panel-visibility-logic');
    const wrap = document.getElementById('dashboard-panel-visibility-conditions');
    if (!enabled || !wrap) return;
    const cfg = panel?.visibility || null;
    const conditions = Array.isArray(cfg?.conditions) ? cfg.conditions : [];
    const on = !!(cfg?.enabled && conditions.length);
    enabled.checked = on;
    if (body) body.classList.toggle('hidden', !on);
    if (logic) logic.value = cfg?.logic === 'or' ? 'or' : 'and';
    wrap.innerHTML = '';
    if (!on) return;
    for (const cond of conditions) addDashboardPanelVisibilityCondition(cond);
}

function _readDashboardPanelVisibility() {
    const enabled = document.getElementById('dashboard-panel-visibility-enabled');
    if (!enabled?.checked) return { enabled: false, logic: 'and', conditions: [] };
    const logic = document.getElementById('dashboard-panel-visibility-logic')?.value === 'or' ? 'or' : 'and';
    const wrap = document.getElementById('dashboard-panel-visibility-conditions');
    const conditions = [];
    if (wrap) {
        for (const row of wrap.querySelectorAll('[data-panel-cond]')) {
            const type = row.querySelector('[data-pvis-field="type"]')?.value || 'entity';
            if (type === 'user') {
                const users = String(row.querySelector('[data-pvis-field="users"]')?.value || '')
                    .split(',').map(s => s.trim()).filter(Boolean);
                const op = row.querySelector('[data-pvis-field="op"]')?.value === 'is_not' ? 'is_not' : 'is';
                if (users.length) conditions.push({ condition: 'user', users, operator: op });
            } else if (type === 'screen') {
                const media = String(row.querySelector('[data-pvis-field="media"]')?.value || '').trim();
                if (media) conditions.push({ condition: 'screen', media });
            } else {
                const ent = String(row.querySelector('[data-pvis-field="entity"]')?.value || '').trim();
                const op = row.querySelector('[data-pvis-field="op"]')?.value || 'is';
                const value = String(row.querySelector('[data-pvis-field="value"]')?.value || '');
                if (ent) conditions.push({ condition: 'entity', entity_id: ent, operator: op, value });
            }
        }
    }
    return { enabled: conditions.length > 0, logic, conditions };
}

export function openDashboardPanelCreator() {
    if (!requireDashboardEditAccess()) return;
    _openDashboardPanelModal('add', { title: '', size: 'sm', icon: '', show_pagination: true, pages: [] });
}

export function openDashboardPanelEditor(panelId) {
    if (!requireDashboardEditAccess()) return;
    const panel = (_dashboardCache.panels || []).find(p => String(p.id) === String(panelId));
    if (!panel) return;
    _openDashboardPanelModal('edit', panel);
}

export function closeDashboardPanelModal() {
    const modal = document.getElementById('dashboard-panel-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    _dashboardPanelModalMode = 'add';
    _dashboardPanelModalPanelId = null;
    _dashboardPanelModalPages = [];
}

export async function saveDashboardPanel() {
    if (!requireDashboardEditAccess()) return;
    const body = _readDashboardPanelModalBody();
    try {
        const params = _currentPageId ? `?page_id=${encodeURIComponent(_currentPageId)}` : '';
        const isEdit = _dashboardPanelModalMode === 'edit' && _dashboardPanelModalPanelId;
        const path = isEdit
            ? `/api/dashboard/panels/${encodeURIComponent(_dashboardPanelModalPanelId)}${params}`
            : `/api/dashboard/panels${params}`;
        const res = await apiCall(path, {
            method: isEdit ? 'PATCH' : 'POST',
            body,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(_dashApiError(err.detail, isEdit ? 'dashboard.section_update_error' : 'dashboard.section_save_error'));
        }
        closeDashboardPanelModal();
        await _refreshAvailableEntities();
        _renderDashboard();
        showToast(isEdit ? t('dashboard.section_updated') : t('dashboard.section_added'), 'success');
    } catch (e) {
        showToast(e.message || t('dashboard.section_save_error'), 'error');
    }
}

async function _patchDashboardPanel(panelId, body) {
    try {
        const params = _currentPageId ? `?page_id=${encodeURIComponent(_currentPageId)}` : '';
        const res = await apiCall(`/api/dashboard/panels/${encodeURIComponent(panelId)}${params}`, {
            method: 'PATCH',
            body,
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(_dashApiError(err.detail, 'dashboard.section_update_error'));
        }
        await _refreshAvailableEntities();
        _renderDashboard();
    } catch (e) {
        showToast(e.message || t('dashboard.section_update_error'), 'error');
    }
}

// ===== Phase 2: rich card dispatcher =====

const _trendCache = new Map(); // entity_id -> { value, ts }

// ===== Phase 5: sparkline charts =====
const _sparklineCache = new Map(); // entity_id -> { ts, points }
const _SPARKLINE_TTL_MS = 60_000;
const _SPARKLINE_HOURS = 24;
const _sparklineFetching = new Set();

function _renderSparklineSVG(points) {
    if (!Array.isArray(points) || points.length < 2) return '';
    const width = 100;
    const height = 28;
    const padY = 2;
    const xs = points.map(p => p.ts);
    const ys = points.map(p => p.value);
    const minX = xs[0];
    const maxX = xs[xs.length - 1];
    const spanX = Math.max(1, maxX - minX);
    let minY = Math.min(...ys);
    let maxY = Math.max(...ys);
    if (minY === maxY) { minY -= 1; maxY += 1; }
    const spanY = maxY - minY;

    const coords = points.map(p => {
        const x = ((p.ts - minX) / spanX) * width;
        const y = height - padY - ((p.value - minY) / spanY) * (height - padY * 2);
        return [x, y];
    });

    const linePath = coords.map((c, i) => (i === 0 ? `M${c[0].toFixed(2)},${c[1].toFixed(2)}` : `L${c[0].toFixed(2)},${c[1].toFixed(2)}`)).join(' ');
    const areaPath = `${linePath} L${width.toFixed(2)},${height.toFixed(2)} L0,${height.toFixed(2)} Z`;

    return `
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
                <linearGradient id="sparkfill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stop-color="var(--accent, #60a5fa)" stop-opacity="0.35"/>
                    <stop offset="100%" stop-color="var(--accent, #60a5fa)" stop-opacity="0"/>
                </linearGradient>
            </defs>
            <path d="${areaPath}" fill="url(#sparkfill)" stroke="none"/>
            <path d="${linePath}" fill="none" stroke="var(--accent, #60a5fa)" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>`;
}

async function _fetchSparklineHistory(entityId) {
    if (_sparklineFetching.has(entityId)) return null;
    _sparklineFetching.add(entityId);
    try {
        const res = await apiCall(`/api/dashboard/history?entity_id=${encodeURIComponent(entityId)}&hours=${_SPARKLINE_HOURS}`);
        if (!res || !res.ok) return null;
        const data = await res.json();
        const points = Array.isArray(data?.points) ? data.points : [];
        _sparklineCache.set(entityId, { ts: Date.now(), points });
        return points;
    } catch (_) {
        return null;
    } finally {
        _sparklineFetching.delete(entityId);
    }
}

function _enhanceSparklines() {
    const grid = document.getElementById('dashboard-grid');
    if (!grid) return;
    _enhanceSparklinesIn(grid);
}

/**
 * Enhance every `[data-sparkline-entity]` slot inside `root`. Used by both
 * the legacy full-grid path (`_enhanceSparklines()`) and Hyveview cards
 * that mount their own sparkline after a state diff.
 */
function _enhanceSparklinesIn(root) {
    if (!root) return;
    const slots = root.querySelectorAll('[data-sparkline-entity]');
    slots.forEach(slot => {
        const entityId = slot.getAttribute('data-sparkline-entity');
        if (!entityId) return;
        const cached = _sparklineCache.get(entityId);
        if (cached && (Date.now() - cached.ts) < _SPARKLINE_TTL_MS) {
            const svg = _renderSparklineSVG(cached.points);
            if (svg) slot.innerHTML = svg;
            return;
        }
        // Show last cached SVG (if any) immediately to avoid layout flicker.
        if (cached) {
            const svg = _renderSparklineSVG(cached.points);
            if (svg) slot.innerHTML = svg;
        }
        _fetchSparklineHistory(entityId).then(points => {
            if (!points) return;
            // Slot may have been re-rendered; query freshly within the same root.
            const fresh = root.querySelector(`[data-sparkline-entity="${CSS.escape(entityId)}"]`);
            if (!fresh) return;
            const svg = _renderSparklineSVG(points);
            if (svg) fresh.innerHTML = svg;
        });
    });
}

// Publish helpers to Hyveview card classes (avoids circular imports).
HVSetHost({
    iconClass: _iconClass,
    widgetIcon: widgetIconSpec,
    entityIcon: _entityIcon,
    entityIconForState: _entityIconForState,
    escape: _escape,
    enhanceSparklinesIn: _enhanceSparklinesIn,
    trendCache: _trendCache,
    stateOn: _stateOn,
    controlVisuallyPending: _dashboardControlVisuallyPending,
    weatherIcon: _weatherIcon,
    weatherVariant: _weatherVariant,
    weatherIsNight: _weatherIsNight,
    tVacuumStatus,
    t,
});

function _widgetDragAttrs(widget) {
    const span = _widgetSpan(widget);
    const sizeStyle = _widgetSizeStyle(widget);
    const dragHandler = _dashboardEditMode ? ' data-dash-pointer="widgetDrag" data-widget-id="' + _escape(widget.id) + '"' : '';
    return _dashboardEditMode
    ? `data-dashboard-widget-id="${_escape(widget.id)}" data-dashboard-cols="${span.col}" data-dashboard-rows="${span.row}" draggable="false" ${sizeStyle}${dragHandler}`
    : `data-dashboard-widget-id="${_escape(widget.id)}" data-dashboard-cols="${span.col}" data-dashboard-rows="${span.row}" draggable="false" ${sizeStyle}`;
}

function _widgetEditControls(widget) {
    if (!_dashboardEditMode) return '';
    return `
        <div class="hyve-dashboard-card__edit">
            <button type="button" data-dash-action="editWidget" data-dash-stop-propagation="true" data-widget-id="${_escape(widget.id)}" aria-label="${_escape(t('dashboard.aria.edit'))}"><i class="fas fa-pen text-[10px]"></i></button>
            <button type="button" class="is-danger" data-dash-action="removeWidget" data-dash-stop-propagation="true" data-widget-id="${_escape(widget.id)}" aria-label="${_escape(t('dashboard.aria.delete_widget'))}"><i class="fas fa-trash text-[10px]"></i></button>
        </div>`;
}

/**
 * Resolve the {col_span, row_span, col_start, row_start} for a widget.
 * Section-based layout: col_span is 1-4 within a 4-column section grid.
 */
function _widgetSpan(widget) {
    const renderer = _widgetRenderer(widget);
    let col = parseInt(widget.col_span, 10);
    let row = parseInt(widget.row_span, 10);

    if (!Number.isFinite(col) || col < 1) {
        if (renderer === 'weather_rich') col = 4;
        else if (renderer === 'fusion_solar') col = 2;
        else if (renderer === 'climate' || renderer === 'gauge') col = 2;
        else if (renderer === 'camera' || renderer === 'picture') col = 2;
        else if (renderer === 'label') col = 4;
        else col = 1;
    }

    if (!Number.isFinite(row) || row < 1) {
        if (renderer === 'weather_rich') row = 2;
        else if (renderer === 'fusion_solar') row = _dashboardDefaultRowsForType('fusion_solar');
        else if (renderer === 'climate' || renderer === 'gauge') row = 2;
        else if (renderer === 'camera' || renderer === 'picture') row = 3;
        else row = 1;
    }
    col = Math.min(Math.max(col, 1), SECTION_COLS);
    row = Math.min(Math.max(row, 1), 12);

    let colStart = parseInt(widget.col_start, 10);
    let rowStart = parseInt(widget.row_start, 10);
    if (!Number.isFinite(colStart) || colStart < 1) colStart = null;
    else colStart = Math.min(Math.max(colStart, 1), SECTION_COLS);
    if (!Number.isFinite(rowStart) || rowStart < 1) rowStart = null;
    if (colStart !== null && (colStart + col - 1) > SECTION_COLS) {
        colStart = Math.max(1, SECTION_COLS - col + 1);
    }
    return { col, row, colStart, rowStart };
}

/**
 * Inline `style="grid-column: <pos>; grid-row: <pos>"` for a widget card.
 * When col_start/row_start are set, uses explicit grid positions; otherwise
 * falls back to spans (CSS auto-flow handles placement).
 */
function _widgetArrayIndex(widget) {
    for (const panel of (_dashboardCache?.panels || [])) {
        const idx = (panel.widgets || []).indexOf(widget);
        if (idx >= 0) return idx;
    }
    return 9999;
}

function _widgetSizeStyle(widget) {
    const { col, row, colStart, rowStart } = _widgetSpan(widget);
    const colRule = colStart ? `${colStart} / span ${col}` : `span ${col}`;
    const rowRule = rowStart ? `${rowStart} / span ${row}` : `span ${row}`;
    const arrayOrder = _widgetArrayIndex(widget);
    // Mobile single-column flow order. Desktop positions by grid-column/grid-row,
    // but on phones every card is forced full-width and ordered only by CSS `order`
    // (var --hyve-mobile-order). Derive that order from the logical grid position
    // (row-major, then column) so a drop that changes col_start/row_start also
    // reorders the card on mobile. Cards without an explicit position fall back to
    // their array index so untouched layouts keep their current order.
    const mobileOrder = (rowStart && colStart)
        ? (rowStart * (SECTION_COLS + 1) + colStart)
        : (1000 + arrayOrder);
    return `style="--hc:${col}; --hr:${row}; grid-column: ${colRule}; grid-row: ${rowRule}; order: ${arrayOrder}; --hyve-mobile-order: ${mobileOrder};"`;
}

/** Legacy alias kept so existing call sites compile; now returns inline style. */
function _widgetSizeClass(widget) {
    // Backward-compat marker class is no longer needed (we use inline style),
    // but keep the function so renderers don't break. Returns empty class list.
    return '';
}

/** Section width (in grid columns) derived from its size: sm=1, md=2, wide=4. */
function _dashboardPanelColSpan(panel) {
    const size = String(panel?.size || 'md');
    if (size === 'sm') return 1;
    if (size === 'wide') return SECTION_COLS;
    return 2;
}

function _renderWidgetCard(widget) {
    const renderer = _widgetRenderer(widget);
    switch (renderer) {
        case 'label':       return _renderLabelCard(widget);
        case 'light':       return _renderLightCard(widget);
        case 'sensor':      return _renderSensorCard(widget);
        case 'climate':     return renderClimateCard(widget);
        case 'gauge':       return _renderGaugeCard(widget);
        case 'lock':        return _renderLockCard(widget);
        case 'vacuum':      return _renderVacuumCard(widget);
        case 'weather_rich':return _renderWeatherRichCard(widget);
        case 'fusion_solar':return _renderFusionSolarCard(widget);
        case 'weather':     return _renderWeatherSimpleCard(widget);
        case 'camera':      return _renderCameraCard(widget);
        case 'picture':     return _renderPictureCard(widget);
        case 'info':        return _renderTileCard(widget, { interactive: false });
        case 'tile':        return _renderTileCard(widget, { interactive: true });
        case 'scene':
        case 'switch':
        case 'button':
        default:            return _renderTileCard(widget, { interactive: true });
    }
}

function _renderWidgetCardForPreview(widget) {
    const wasEditing = _dashboardEditMode;
    _dashboardEditMode = false;
    try {
        return _renderWidgetCard(widget);
    } finally {
        _dashboardEditMode = wasEditing;
    }
}

// --- Label (unchanged from Phase 1) ---
// --- Label (Hyveview-migrated: body is `<hv-card-label>`; outer article
// keeps drag/edit/size class so the legacy layout system stays in charge). ---
function _renderLabelCard(widget) {
    const dragAttrs = _widgetDragAttrs(widget);
    const editControls = _widgetEditControls(widget);
    const labelClasses = widget.show_background
        ? 'hyve-dashboard-label hyve-dashboard-label--accent'
        : 'hyve-dashboard-label hyve-dashboard-label--bare';
    return `
        <article ${dragAttrs}
            class="${_widgetSizeClass(widget)} ${labelClasses} ${_dashboardEditMode ? 'cursor-grab active:cursor-grabbing' : ''}"
            data-clickable="false"
            data-edit="${_dashboardEditMode ? 'true' : 'false'}">
            ${HVBridge.renderCardElement(widget)}
            ${editControls}
        </article>`;
}

// --- Tile (universal HA-style, also fallback for button/switch/info/scene) ---
// Migrated to <hv-card-tile> (static/hyveview/cards/tile.js). The outer
// article keeps drag/edit/click plumbing and the data-* attrs that CSS
// keys off of; the inner DOM (icon, title, state line, optional toggle)
// is owned by the custom element and patched in place by setState().
function _renderTileCard(widget, opts = {}) {
    const interactive = opts.interactive !== false;
    const renderer = _widgetRenderer(widget);
    const state = String(widget.current_state || 'unknown');
    const on = _stateOn(state);
    const controllable = interactive && widget.controllable !== false
        && (renderer === 'tile' || renderer === 'button' || renderer === 'switch' || renderer === 'scene');
    const dragAttrs = _widgetDragAttrs(widget);
    const editControls = _widgetEditControls(widget);
    const clickable = !_dashboardEditMode && controllable && widget.available !== false;
    const cardActionAttrs = clickable
        ? `role="button" tabindex="0" data-dash-action="cardActivate" data-dash-action-key="cardActivate" data-widget-id="${_escape(widget.id)}"`
        : '';
    return `
        <article ${dragAttrs} ${cardActionAttrs}
            class="hyve-dashboard-card ${_widgetSizeClass(widget)}"
            data-on="${on ? 'true' : 'false'}"
            data-pending="${_dashboardControlVisuallyPending(widget.id) ? 'true' : 'false'}"
            data-entity-id="${_escape(widget.entity_id || '')}"
            data-clickable="${clickable ? 'true' : 'false'}"
            data-edit="${_dashboardEditMode ? 'true' : 'false'}"
            data-unavailable="${widget.available === false ? 'true' : 'false'}">
            ${HVBridge.renderCardElement(widget)}
            ${editControls}
        </article>`;
}

function _cameraCardMode(widget) {
    const config = widget?.config && typeof widget.config === 'object' ? widget.config : {};
    const mode = String(config.camera_mode || widget?.camera_mode || '').trim().toLowerCase();
    return mode === 'live' ? 'live' : 'snapshots';
}

function _cameraWidgetEntities(widget) {
    const cfg = widget?.config && typeof widget.config === 'object' ? widget.config : {};
    const raw = Array.isArray(cfg.entities) ? cfg.entities : [];
    const fromConfig = raw.map((e) => {
        if (typeof e === 'string') return { entity_id: e, title: '', subtitle: '' };
        return {
            entity_id: String(e?.entity_id || '').trim(),
            title: String(e?.title || '').trim(),
            subtitle: String(e?.subtitle || '').trim(),
        };
    }).filter((e) => e.entity_id);
    if (fromConfig.length) return fromConfig;
    const eid = String(widget?.entity_id || '').trim();
    if (!eid) return [];
    return [{
        entity_id: eid,
        title: widgetTitle(widget, { entityId: eid }),
        subtitle: '',
    }];
}

function _renderCameraCard(widget) {
    const dragAttrs = _widgetDragAttrs(widget);
    const editControls = _widgetEditControls(widget);
    const entities = _cameraWidgetEntities(widget);
    const primary = entities[0] || {};
    const entityId = String(primary.entity_id || widget.entity_id || '');
    const title = widget.title || primary.title || widget.entity_name || entityId;
    const mode = _cameraCardMode(widget);
    const cfg = widget?.config && typeof widget.config === 'object' ? widget.config : {};
    const interval = Math.max(2, Number(cfg.refresh_interval || cfg.interval || 10));
    const defaultAudio = !!cfg.default_audio;
    const defaultMic = !!cfg.default_microphone;
    const preload = !!cfg.preload;
    const preloadScope = cfg.preload_scope === 'all' ? 'all' : 'adjacent';
    const safeTitle = _escape(title);
    const entitiesPayload = entities.map((e) => {
        const live = (_dashboardCache?.available_entities || []).find((x) => x.entity_id === e.entity_id);
        const attrs = live?.attributes || {};
        return {
            entity_id: e.entity_id,
            title: e.title || e.entity_id,
            webm: cameraPreferWebmPlayer(attrs),
            go2rtc: cameraSupportsGo2rtc(attrs),
        };
    });
    const entitiesAttr = _escape(encodeURIComponent(JSON.stringify(entitiesPayload)));
    const mediaMarkup = entities.length
        ? `<hv-camera-carousel
                class="hyve-dashboard-card__camera-player"
                entities="${entitiesAttr}"
                mode="${_escape(mode === 'live' ? 'live' : 'snapshot')}"
                interval="${interval}"
                default-audio="${defaultAudio ? 'true' : 'false'}"
                default-mic="${defaultMic ? 'true' : 'false'}"
                preload="${preload ? 'true' : 'false'}"
                preload-scope="${_escape(preloadScope)}"
                index="0"></hv-camera-carousel>`
        : `<div class="hyve-dashboard-card__camera-placeholder"><i class="fas fa-video-slash"></i></div>`;
    return `
        <article ${dragAttrs}
            class="hyve-dashboard-card hyve-dashboard-card--camera ${_widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${_dashboardEditMode ? 'true' : 'false'}"
            data-entity-id="${_escape(entityId)}"
            data-camera-mode="${_escape(mode)}"
            data-camera-player="${mode === 'live' ? 'live' : 'snapshot'}"
            data-camera-refresh="${interval}">
            <div class="hyve-dashboard-card__camera-frame">
                ${mediaMarkup}
            </div>
            ${editControls}
        </article>`;
}

function _renderPictureCard(widget) {
    const dragAttrs = _widgetDragAttrs(widget);
    const editControls = _widgetEditControls(widget);
    const title = widget.title || 'Picture';
    const safeTitle = _escape(title);
    const wid = _escape(widget.id || '');
    return `
        <article ${dragAttrs}
            class="hyve-dashboard-card hyve-dashboard-card--camera ${_widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${_dashboardEditMode ? 'true' : 'false'}"
            data-entity-id="${_escape(widget.entity_id || '')}">
            <hv-card-picture class="hv-card-mount" data-hv-widget-id="${wid}" style="display:contents"></hv-card-picture>
            ${editControls}
        </article>`;
}

if (typeof window !== 'undefined' && window.__hyveCameraTimer) {
    // Legacy global camera poll timer; clear on hot-reload if still present.
    clearInterval(window.__hyveCameraTimer);
    window.__hyveCameraTimer = null;
}

// --- Light (tile + brightness slider) ---
// Migrated to <hv-card-light> (static/hyveview/cards/light.js). Outer article
// still owns drag/edit/click; the inner brightness slider + state text live
// inside the custom element and update in place via setState().
function _renderLightCard(widget) {
    const dragAttrs = _widgetDragAttrs(widget);
    const editControls = _widgetEditControls(widget);
    const clickable = !_dashboardEditMode && widget.controllable !== false && widget.available !== false;
    const cardActionAttrs = clickable
        ? `role="button" tabindex="0" data-dash-action="cardActivate" data-dash-action-key="cardActivate" data-widget-id="${_escape(widget.id)}"`
        : '';
    // Pass edit mode through the widget so the card can decide whether to
    // render the brightness slider.
    widget._edit_mode = !!_dashboardEditMode;
    return `
        <article ${dragAttrs} ${cardActionAttrs}
            class="hyve-dashboard-card hyve-dashboard-card--light ${_widgetSizeClass(widget)}"
            data-clickable="${clickable ? 'true' : 'false'}"
            data-edit="${_dashboardEditMode ? 'true' : 'false'}">
            ${HVBridge.renderCardElement(widget)}
            ${editControls}
        </article>`;
}

// --- Sensor (big value + unit + trend) ---
// Migrated to <hv-card-sensor> (static/hyveview/cards/sensor.js). The outer
// article stays here so legacy edit/drag/size/click plumbing is unchanged;
// the inner DOM (icon, label, value, unit, trend, sparkline slot) is owned
// by the custom element and is updated in-place by setState() — no full
// grid re-render is needed when the sensor value changes.
function _renderSensorCard(widget) {
    const dragAttrs = _widgetDragAttrs(widget);
    return `
        <article ${dragAttrs}
            class="hyve-dashboard-card hyve-dashboard-card--sensor ${_widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${_dashboardEditMode ? 'true' : 'false'}"
            data-unavailable="${widget.available === false ? 'true' : 'false'}">
            ${HVBridge.renderCardElement(widget)}
            ${_widgetEditControls(widget)}
        </article>`;
}


// --- Gauge (SVG arc 180°) ---
// Migrated to <hv-card-gauge>. Inner SVG + value updated in place by setState.
function _renderGaugeCard(widget) {
    const dragAttrs = _widgetDragAttrs(widget);
    return `
        <article ${dragAttrs}
            class="hyve-dashboard-card hyve-dashboard-card--gauge ${_widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${_dashboardEditMode ? 'true' : 'false'}"
            data-unavailable="${widget.available === false ? 'true' : 'false'}">
            ${HVBridge.renderCardElement(widget)}
            ${_widgetEditControls(widget)}
        </article>`;
}

// --- Lock (dual button) ---
// Migrated to <hv-card-lock>. Buttons + state updated in place by setState.
function _renderLockCard(widget) {
    const dragAttrs = _widgetDragAttrs(widget);
    widget._edit_mode = !!_dashboardEditMode;
    return `
        <article ${dragAttrs}
            class="hyve-dashboard-card hyve-dashboard-card--lock ${_widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${_dashboardEditMode ? 'true' : 'false'}">
            ${HVBridge.renderCardElement(widget)}
            ${_widgetEditControls(widget)}
        </article>`;
}

// --- Vacuum (robot cleaner) ---
// Body is <hv-card-vacuum>; outer article keeps drag/edit/size plumbing.
function _renderVacuumCard(widget) {
    const dragAttrs = _widgetDragAttrs(widget);
    widget._edit_mode = !!_dashboardEditMode;
    return `
        <article ${dragAttrs}
            class="hyve-dashboard-card hyve-dashboard-card--vacuum ${_widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${_dashboardEditMode ? 'true' : 'false'}">
            ${HVBridge.renderCardElement(widget)}
            ${_widgetEditControls(widget)}
        </article>`;
}

// --- Weather (simple) ---
// Migrated to <hv-card-weather-simple>. Icon + temp updated in place.
function _renderWeatherSimpleCard(widget) {
    const dragAttrs = _widgetDragAttrs(widget);
    return `
        <article ${dragAttrs}
            class="hyve-dashboard-card ${_widgetSizeClass(widget)}"
            data-on="true"
            data-clickable="false"
            data-edit="${_dashboardEditMode ? 'true' : 'false'}"
            data-unavailable="${widget.available === false ? 'true' : 'false'}">
            ${HVBridge.renderCardElement(widget)}
            ${_widgetEditControls(widget)}
        </article>`;
}

function _weatherBackdropMarkup() {
    return `
            <div class="hyve-dashboard-card__weather-bg" aria-hidden="true">
                <span class="hyve-dashboard-card__weather-rain hyve-dashboard-card__weather-rain--far"></span>
                <span class="hyve-dashboard-card__weather-rain hyve-dashboard-card__weather-rain--near"></span>
                <span class="hyve-dashboard-card__weather-rain hyve-dashboard-card__weather-rain--mist"></span>
            </div>`;
}

// --- Weather (rich, with 5-day forecast) ---
function _renderWeatherRichCard(widget) {
    const dragAttrs = _widgetDragAttrs(widget);
    // Stash span on the widget so the custom element can pick the right layout
    // tier (compact / full + forecast). Layout is decided once in setConfig().
    widget._span = _widgetSpan(widget);
    const span = widget._span;
    const compactClass = span.row <= 1 ? ' hyve-dashboard-card--weather-rich-compact' : '';
    return `
        <article ${dragAttrs}
            class="hyve-dashboard-card hyve-dashboard-card--weather-rich${compactClass} ${_widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${_dashboardEditMode ? 'true' : 'false'}">
            ${HVBridge.renderCardElement(widget)}
            ${_widgetEditControls(widget)}
        </article>`;
}

function _renderFusionSolarCard(widget) {
    const dragAttrs = _widgetDragAttrs(widget);
    widget._span = _widgetSpan(widget);
    const compactClass = widget._span.row <= 1 ? ' hyve-dashboard-card--fusion-solar-compact' : '';
    return `
        <article ${dragAttrs}
            class="hyve-dashboard-card hyve-dashboard-card--fusion-solar${compactClass} ${_widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${_dashboardEditMode ? 'true' : 'false'}">
            ${HVBridge.renderCardElement(widget)}
            ${_widgetEditControls(widget)}
        </article>`;
}

// Classify a condition string into a small theme variant.
function _weatherVariant(cond) {
    const c = String(cond || '').toLowerCase();
    if (c.includes('storm') || c.includes('thunder') || c.includes('furtună') || c.includes('furtuna')) return 'storm';
    if (c.includes('snow')  || c.includes('zăpad')   || c.includes('zapad')) return 'snow';
    if (c.includes('rain')  || c.includes('ploaie')  || c.includes('shower') || c.includes('drizzle') || c.includes('burniță') || c.includes('burnita')) return 'rain';
    if (c.includes('fog')   || c.includes('mist')    || c.includes('ceață') || c.includes('ceata')) return 'fog';
    if (c.includes('partly')|| c.includes('parțial') || c.includes('partial')) return 'partly';
    if (c.includes('cloud') || c.includes('înnorat') || c.includes('innorat') || c.includes('overcast')) return 'cloud';
    if (c.includes('clear') || c.includes('senin')   || c.includes('sunny')) return 'clear';
    return 'clear';
}

function _weatherIsNight(attrs) {
    // Prefer explicit hint from provider, else derive from local hour.
    if (attrs && (attrs.is_night === true || attrs.is_day === false)) return true;
    if (attrs && (attrs.is_night === false || attrs.is_day === true)) return false;
    const h = new Date().getHours();
    return h < 6 || h >= 20;
}

function _weatherIcon(cond, isNight = false) {
    const c = String(cond || '').toLowerCase();
    if (c.includes('clear') || c.includes('senin') || c.includes('sunny')) return isNight ? 'fas fa-moon'      : 'fas fa-sun';
    if (c.includes('partly')|| c.includes('parțial') || c.includes('partial')) return isNight ? 'fas fa-cloud-moon' : 'fas fa-cloud-sun';
    if (c.includes('cloud') || c.includes('înnorat') || c.includes('innorat')) return 'fas fa-cloud';
    if (c.includes('rain')  || c.includes('ploaie') || c.includes('shower'))   return 'fas fa-cloud-showers-heavy';
    if (c.includes('snow')  || c.includes('zăpad')  || c.includes('zapad'))    return 'fas fa-snowflake';
    if (c.includes('storm') || c.includes('thunder')|| c.includes('furtună') || c.includes('furtuna')) return 'fas fa-bolt';
    if (c.includes('fog')   || c.includes('mist')   || c.includes('ceață') || c.includes('ceata'))    return 'fas fa-smog';
    return isNight ? 'fas fa-cloud-moon' : 'fas fa-cloud-sun';
}

// ===== Add picker (single entry point for all "Adaugă …" actions) =====

let _dashboardCardCatalogCache = null;

async function _loadDashboardCardCatalog(force = false) {
    if (_dashboardCardCatalogCache && !force) return _dashboardCardCatalogCache;
    try {
        const res = await apiCall('/api/dashboard/catalog');
        if (!res.ok) throw new Error('Catalog indisponibil');
        const data = await res.json().catch(() => ({}));
        _dashboardCardCatalogCache = Array.isArray(data.cards) ? data.cards : [];
    } catch (_) {
        _dashboardCardCatalogCache = [];
    }
    return _dashboardCardCatalogCache;
}

function _cardIcon(card) {
    if (card.icon) return card.icon;
    const map = {
        button: 'fas fa-toggle-on',
        switch: 'fas fa-toggle-on',
        info: 'fas fa-circle-info',
        weather: 'fas fa-cloud-sun',
        weather_rich: 'fas fa-cloud-sun-rain',
        label: 'fas fa-heading',
        scene: 'fas fa-wand-magic-sparkles',
        tile: 'fas fa-square',
        light: 'fas fa-lightbulb',
        sensor: 'fas fa-gauge-simple-high',
        climate: 'fas fa-temperature-half',
        gauge: 'fas fa-gauge-high',
        lock: 'fas fa-lock',
        vacuum: 'fas fa-robot',
        fusion_solar: 'fas fa-solar-panel',
        picture: 'fas fa-images',
    };
    return map[card.renderer] || map[card.id] || 'fas fa-square-plus';
}

export async function openDashboardAddPicker() {
    if (!requireDashboardEditAccess()) return;
    // R5.2: route the "Add card" action through the schema-driven editor.
    // The new editor renders its own card picker (built from the registry),
    // so we no longer open the legacy `dashboard-add-picker-modal`.
    closeDashboardMenu();
    await _ensureHyveviewEntitySeed();
    const result = await hvOpenEditor({ mode: 'add' });
    if (!result) return;
    await _saveDashboardWidgetFromEditor(result, { editingId: null, original: null });
}

export function closeDashboardAddPicker() {
    // Legacy modal — kept as a no-op so old onclicks don't throw. The new
    // schema editor closes itself when the user picks/cancels.
    const modal = document.getElementById('dashboard-add-picker-modal');
    if (modal) { modal.classList.add('hidden'); modal.classList.remove('flex'); }
}

export async function pickDashboardAddType(kind, id) {
    closeDashboardAddPicker();
    if (kind === 'panel') {
        openDashboardPanelCreator();
        return;
    }
    // Forward to the schema editor; it shows its own picker regardless of
    // the tile the user clicked (legacy two-step picker is gone).
    return openDashboardAddPicker();
}

// ===== Multi-page navigation (Phase 1) =====

function _persistDashboardPagesNav(pages) {
    if (!Array.isArray(pages) || !pages.length) return;
    try {
        const compact = pages.map(page => ({
            id: String(page.id || ''),
            title: String(page.title || ''),
            icon: String(page.icon || 'fa-table-cells-large'),
        })).filter(p => p.id);
        if (compact.length) localStorage.setItem(DASHBOARD_PAGES_NAV_KEY, JSON.stringify(compact));
    } catch (_) {}
}

function _readDashboardPagesNav() {
    try {
        const raw = localStorage.getItem(DASHBOARD_PAGES_NAV_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

/** Hydrate sidebar nav from localStorage before the dashboard API responds. */
export function initDashboardSidebarNav() {
    const existing = Array.isArray(_dashboardCache.pages) ? _dashboardCache.pages : [];
    if (!existing.length) {
        const cached = _readDashboardViewCache();
        const fromView = Array.isArray(cached?.pages) ? cached.pages : [];
        const fromNav = _readDashboardPagesNav();
        const pages = fromView.length ? fromView : fromNav;
        if (pages.length) {
            _dashboardCache.pages = pages;
            if (!_currentPageId) {
                const pid = cached?.page_id || cached?.current_page_id;
                if (pid) _currentPageId = String(pid);
                else {
                    try {
                        const stored = String(localStorage.getItem(DASHBOARD_LAST_PAGE_KEY) || '');
                        if (stored) _currentPageId = stored;
                    } catch (_) {}
                }
            }
        }
    }
    _renderDashboardPagesList();
}

function _renderDashboardPagesList() {
    const list = document.getElementById('dashboard-pages-list');
    const actions = document.getElementById('dashboard-root-page-actions');
    const rootSlot = document.getElementById('dashboard-root-page-slot');
    const rootBtn = document.getElementById('nav-dashboard');
    const pages = Array.isArray(_dashboardCache.pages) ? _dashboardCache.pages : [];
    const activeId = _currentPageId || _dashboardCache.current_page_id || _dashboardCache.page_id || (pages[0] && pages[0].id) || null;
    const onDashTab = (() => {
        const view = document.getElementById('view-dashboard');
        return !!view && !view.classList.contains('hidden');
    })();

    if (!list) return;

    if (pages.length > 0) {
        // Flat sidebar: every dashboard page is a top-level nav entry.
        // Hide the legacy generic "Dashboard" root button — the pages stand on their own.
        if (rootSlot) rootSlot.classList.add('hidden');
        if (rootBtn) rootBtn.classList.remove('bg-white/10', 'text-accent', 'border-accent/10');
        list.classList.remove('hidden');
        list.innerHTML = pages.map(page => {
            const id = String(page.id || '');
            const title = _escape(page.title || 'Pagină');
            const iconClass = _escape(_iconClass(page.icon || 'fa-table-cells-large'));
            const isActive = onDashTab && id === activeId;
            const activeCls = isActive ? ' bg-white/10 text-accent border-accent/10' : '';
            return `
                <button type="button"
                    id="nav-dashboard-page-${id}"
                    class="nav-btn dashboard-page-nav-btn w-full flex items-center gap-2.5 sm:gap-3 p-2.5 sm:p-3 rounded-lg sm:rounded-xl text-slate-500 hover:text-slate-300 hover:bg-white/[0.03] active:bg-white/[0.06] transition-all group min-h-[40px]${activeCls}"
                    data-page-id="${id}"
                    data-dash-action="openPageNav" data-page-id="${id.replace(/'/g, "\\'")}"
                    title="${title}">
                    <i class="${iconClass} w-5 sm:w-5 flex-shrink-0 text-sm group-hover:text-accent transition-colors"></i>
                    <span class="font-medium text-sm truncate">${title}</span>
                </button>`;
        }).join('');
        _persistDashboardPagesNav(pages);
    } else {
        // No pages cached — fall back to the original Dashboard root entry.
        if (rootSlot) rootSlot.classList.remove('hidden');
        list.classList.add('hidden');
        list.innerHTML = '';
    }

    if (actions) {
        actions.classList.add('hidden');
        actions.innerHTML = '';
    }
}

function _resolveCurrentDashboardPageId() {
    const pages = Array.isArray(_dashboardCache.pages) ? _dashboardCache.pages : [];
    const hasPage = (pageId) => !!pageId && (!pages.length || pages.some(page => String(page?.id || '') === String(pageId)));

    const hashPage = _readHashPageId();
    if (hasPage(hashPage)) {
        _currentPageId = String(hashPage);
        return _currentPageId;
    }

    const activeBtn = Array.from(document.querySelectorAll('.dashboard-page-nav-btn')).find(btn =>
        btn.classList.contains('bg-white/10')
        || btn.classList.contains('text-accent')
        || btn.classList.contains('border-accent/10')
    );
    const activeDomPage = activeBtn?.dataset?.pageId || '';
    if (hasPage(activeDomPage)) {
        _currentPageId = String(activeDomPage);
        return _currentPageId;
    }

    let storedPage = '';
    try { storedPage = String(localStorage.getItem(DASHBOARD_LAST_PAGE_KEY) || ''); } catch (_) {}
    if (hasPage(storedPage)) {
        _currentPageId = String(storedPage);
        return _currentPageId;
    }

    const cachedPage = _currentPageId || _dashboardCache.current_page_id || _dashboardCache.page_id || (pages[0] && pages[0].id) || '';
    if (hasPage(cachedPage)) {
        _currentPageId = String(cachedPage);
        return _currentPageId;
    }

    return '';
}

export async function openDashboardPageNav(pageId) {
    const view = document.getElementById('view-dashboard');
    const onDash = !!view && !view.classList.contains('hidden');
    // Point the URL hash at the target page *before* any tab switch. switchTab()
    // kicks off loadDashboard({force:true}), which reads the hash on entry; if we
    // don't set it first it races selectDashboardPage() and snaps the hash back
    // to the previously-active page (the "click new page → lands on Acasă" bug).
    if (pageId) { try { _setHashForPage(String(pageId)); } catch (_) {} }
    // Only switch tabs (and trigger a full dashboard reload) when we're actually
    // coming from another tab. When already on the dashboard, going through
    // switchTab would needlessly race a forced reload against the page select.
    if (!onDash && typeof window.switchTab === 'function') {
        // Keep the explicit page hash we just wrote above; otherwise switchTab
        // may rewrite it to the previously remembered dashboard page.
        window.switchTab('dashboard', { syncHash: false });
    }
    if (pageId) await selectDashboardPage(pageId);
    // Mobile/tablet: collapse the side menu after picking a dashboard page
    // (the main tabs already do this via switchTab, but staying on the
    // dashboard tab skips switchTab so we close it here too).
    if (window.innerWidth < 1024 && typeof window.closeSidebar === 'function'
        && (typeof window.isSidebarOpen !== 'function' || window.isSidebarOpen())) {
        window.closeSidebar();
    }
}

function _setHashForPage(pageId) {
    if (!pageId) return;
    const desired = `/dashboard/${encodeURIComponent(String(pageId))}`;
    const current = (window.location.hash || '').replace(/^#/, '');
    if (current === desired || current === desired.slice(1)) return;
    // Use location.hash so the URL visibly changes in all environments
    // (including WebView wrappers where replaceState can be inconsistent).
    window.location.hash = desired;
}

function _readHashPageId() {
    const hash = (window.location.hash || '').replace(/^#/, '');
    const match = hash.match(/^\/?dashboard\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
}

function _bindHashRouter() {
    if (_hashRouterBound) return;
    _hashRouterBound = true;
    window.addEventListener('hashchange', () => {
        const grid = document.getElementById('dashboard-grid');
        if (!grid) return;
        const onDashTab = (() => {
            const view = document.getElementById('view-dashboard');
            return !!view && !view.classList.contains('hidden');
        })();
        if (!onDashTab) return;
        const pageFromHash = _readHashPageId();
        if (pageFromHash && pageFromHash !== _currentPageId) {
            selectDashboardPage(pageFromHash);
        }
    });
}

function _mergeCreatedPageIntoCache(createdPage, newId) {
    if (!newId) return;
    _currentPageId = String(newId);
    try { localStorage.setItem(DASHBOARD_LAST_PAGE_KEY, _currentPageId); } catch (_) {}
    _setHashForPage(_currentPageId);
    if (!createdPage || typeof createdPage !== 'object') return;
    if (createdPage.title) {
        _dashboardCache.title = String(createdPage.title);
        try { localStorage.setItem('hyve.lastDashboardTitle', _dashboardCache.title); } catch (_) {}
    }
    if (createdPage.icon != null) _dashboardCache.icon = String(createdPage.icon || '');
    if (createdPage.columns != null) _dashboardCache.columns = Number(createdPage.columns) || 0;
    const pages = Array.isArray(_dashboardCache.pages) ? [..._dashboardCache.pages] : [];
    const idx = pages.findIndex(p => p && String(p.id) === String(newId));
    const merged = { ...(idx >= 0 ? pages[idx] : {}), ...createdPage, id: String(newId) };
    if (idx >= 0) pages[idx] = merged;
    else pages.push(merged);
    _dashboardCache.pages = pages;
}

let _dashboardPageNavToken = 0;

export async function selectDashboardPage(pageId) {
    if (!pageId) return;
    const myToken = ++_dashboardPageNavToken;
    _currentPageId = String(pageId);
    try { localStorage.setItem(DASHBOARD_LAST_PAGE_KEY, _currentPageId); } catch (_) {}
    _setHashForPage(_currentPageId);
    // Eagerly update the header + page title from the cached page list.
    try {
        const pages = Array.isArray(_dashboardCache.pages) ? _dashboardCache.pages : [];
        const target = pages.find(p => p && String(p.id) === String(pageId));
        const eagerTitle = (target && target.title) || '';
        if (eagerTitle) {
            const headerTitleEl = document.getElementById('current-view-title');
            if (headerTitleEl) headerTitleEl.textContent = eagerTitle;
            const pageTitleEl = document.getElementById('dashboard-page-title');
            if (pageTitleEl) pageTitleEl.textContent = eagerTitle;
            try { localStorage.setItem('hyve.lastDashboardTitle', eagerTitle); } catch (_) {}
        }
    } catch (_) {}

    const grid = document.getElementById('dashboard-grid');
    // Briefly dim the grid so the swap reads as a smooth crossfade instead of a
    // hard content pop.
    if (grid) {
        grid.style.transition = 'opacity 0.14s ease';
        grid.style.opacity = '0.4';
    }

    // Instant render: if we already have a snapshot for this page, paint it now
    // so switching feels immediate. The network refresh below silently
    // reconciles and only re-renders if the content actually changed.
    let renderedFromSnapshot = false;
    let snapFp = null;
    try {
        const snap = _getDashboardPageSnapshot(_currentPageId);
        if (snap) {
            _dashboardCache = {
                ...snap,
                available_entities: Array.isArray(_dashboardCache.available_entities)
                    ? _dashboardCache.available_entities
                    : [],
            };
            if (_dashboardCache.page_id) _currentPageId = _dashboardCache.page_id;
            snapFp = _dashboardSnapshotFingerprint(snap);
            _renderDashboard();
            renderedFromSnapshot = true;
            if (grid) requestAnimationFrame(() => { grid.style.opacity = '1'; });
        }
    } catch (_) {}

    if (!renderedFromSnapshot && grid && !grid.firstElementChild) {
        grid.innerHTML = `<div class="col-span-full p-6 text-sm" style="color:var(--text-tertiary,#94a3b8);">${_escape(t('dashboard.loading_page'))}</div>`;
    }
    _setDashboardRefreshIndicator(true);

    const watchdog = setTimeout(() => {
        if (myToken !== _dashboardPageNavToken) return;
        const g = document.getElementById('dashboard-grid');
        if (!g) return;
        if (g.textContent.includes(t('dashboard.loading_page'))) {
            g.innerHTML = `<div class="col-span-full p-6 text-sm rounded-2xl border border-amber-500/20 bg-amber-500/10 text-amber-200">
                <div class="font-semibold mb-1">${_escape(t('dashboard.page_load_timeout'))}</div>
                <button type="button" data-dash-action="selectPage" data-page-id="${String(pageId).replace(/'/g, "\\'")}" class="mt-2 px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-xs font-semibold">${_escape(t('common.try_again'))}</button>
            </div>`;
        }
    }, 12000);

    try {
        await _withDashboardTimeout(
            _refreshAvailableEntities({ includeEntities: false }),
            8000,
            t('dashboard.refresh_timeout')
        );
        if (myToken !== _dashboardPageNavToken) { if (watchdog) clearTimeout(watchdog); return; }
        // Only repaint if we didn't already render this exact content from the
        // snapshot — avoids a redundant flash on every switch.
        const freshFp = _dashboardSnapshotFingerprint(_dashboardCache);
        if (!renderedFromSnapshot || freshFp !== snapFp) _renderDashboard();
        if (grid) requestAnimationFrame(() => { grid.style.opacity = '1'; });
    } catch (e) {
        if (myToken !== _dashboardPageNavToken) { if (watchdog) clearTimeout(watchdog); return; }
        // Superseded refreshes are non-fatal; just stop here without UI noise.
        if (e && e.name === 'DashboardRefreshAbortError') {
            if (watchdog) clearTimeout(watchdog);
            return;
        }
        console.error('[dashboard] selectDashboardPage refresh failed:', e);
        const gridNow = document.getElementById('dashboard-grid');
        const gridHasContent = !!(gridNow && gridNow.firstElementChild && !gridNow.textContent.includes(t('dashboard.loading_page')));
        if (gridHasContent) {
            // Keep existing widgets visible; just surface a toast.
            showToast(t('dashboard.refresh_failed', { message: e.message || t('common.unknown_error') }), 'error');
        } else if (gridNow) {
            gridNow.innerHTML = `<div class="col-span-full p-6 text-sm rounded-2xl border border-red-500/20 bg-red-500/10 text-red-300">
                <div class="font-semibold mb-1">${_escape(t('dashboard.load_failed_page'))}</div>
                <div class="text-xs opacity-80 mb-2">${_escape(e.message || t('dashboard.unknown_error'))}</div>
                <button type="button" data-dash-action="selectPage" data-page-id="${String(pageId).replace(/'/g, "\\'")}" class="px-3 py-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-xs font-semibold">${_escape(t('common.try_again'))}</button>
            </div>`;
        }
    } finally {
        if (watchdog) clearTimeout(watchdog);
        if (myToken === _dashboardPageNavToken) _setDashboardRefreshIndicator(false);
        const gridEl = document.getElementById('dashboard-grid');
        if (gridEl) gridEl.style.opacity = '1';
    }
}

export async function createDashboardPage() {
    if (!requireDashboardEditAccess()) return;
    // fill in title, icon, columns, layout, etc. before the page is created.
    openDashboardPageModal({ create: true });
}

async function _readDashboardSectionFallback() {
    try {
        const res = await apiCall('/api/config');
        if (res.ok) {
            const cfg = await res.json();
            const section = cfg?.dashboard || {};
            const result = {
                widgets: Array.isArray(section.widgets) ? section.widgets : [],
                panels: Array.isArray(section.panels) ? section.panels : [],
                pages: Array.isArray(section.pages) ? section.pages : [],
                preferences: { ...DEFAULT_PREFS, ...(section.preferences || {}) },
                title: String(section.title || DEFAULT_META.title),
                subtitle: String(section.subtitle || DEFAULT_META.subtitle),
                icon: String(section.icon || ''),
                columns: Number(section.columns || 0) || 0,
            };
            try { localStorage.setItem(DASHBOARD_LOCAL_KEY, JSON.stringify(result)); } catch (_) {}
            return result;
        }
    } catch (_) {}

    try {
        const localRaw = localStorage.getItem(DASHBOARD_LOCAL_KEY);
        if (localRaw) {
            const parsed = JSON.parse(localRaw);
            return {
                widgets: Array.isArray(parsed.widgets) ? parsed.widgets : [],
                panels: Array.isArray(parsed.panels) ? parsed.panels : [],
                pages: Array.isArray(parsed.pages) ? parsed.pages : [],
                preferences: { ...DEFAULT_PREFS, ...(parsed.preferences || {}) },
                title: String(parsed.title || DEFAULT_META.title),
                subtitle: String(parsed.subtitle || DEFAULT_META.subtitle),
                icon: String(parsed.icon || ''),
                columns: Number(parsed.columns || 0) || 0,
            };
        }
    } catch (_) {}

    return {
        widgets: [],
        panels: [],
        pages: [],
        preferences: { ...DEFAULT_PREFS },
        title: DEFAULT_META.title,
        subtitle: DEFAULT_META.subtitle,
        icon: '',
        columns: 0,
    };
}

async function _writeDashboardSectionFallback(section) {
    const payload = {
        widgets: Array.isArray(section.widgets) ? section.widgets : [],
        panels: Array.isArray(section.panels) ? section.panels : [],
        pages: Array.isArray(section.pages) ? section.pages : [],
        preferences: { ...DEFAULT_PREFS, ...(section.preferences || {}) },
        title: String(section.title || DEFAULT_META.title),
        subtitle: String(section.subtitle || DEFAULT_META.subtitle),
        icon: String(section.icon || ''),
        columns: Number(section.columns || 0) || 0,
    };

    const res = await apiCall('/api/config', {
        method: 'PATCH',
        body: { dashboard: payload },
    });
    if (!res.ok && res.status !== 403) {
        const err = await res.json().catch(() => ({}));
        throw new Error(_dashApiError(err.detail, 'dashboard.save_failed'));
    }

    try { localStorage.setItem(DASHBOARD_LOCAL_KEY, JSON.stringify(payload)); } catch (_) {}
}

async function _refreshAvailableEntities(options = {}) {
    const includeEntities = options.includeEntities !== false;
    const externalSignal = options.signal || null;
    let fallbackSection = {
        widgets: _dashboardCache.widgets || [],
        panels: _dashboardCache.panels || [],
        pages: _dashboardCache.pages || [],
        preferences: _dashboardCache.preferences || DEFAULT_PREFS,
        title: _dashboardCache.title || DEFAULT_META.title,
        subtitle: _dashboardCache.subtitle || DEFAULT_META.subtitle,
        icon: _dashboardCache.icon || '',
        columns: _dashboardCache.columns || 0,
    };
    if (includeEntities) {
        try {
            fallbackSection = await _readDashboardSectionFallback();
        } catch (_) {}
    }

    try {
        const params = new URLSearchParams();
        if (_currentPageId) params.set('page_id', _currentPageId);
        if (!includeEntities) params.set('include_entities', 'false');
        if (!includeEntities) params.set('_layout_refresh', String(Date.now()));
        const query = params.toString();
        const url = query ? `/api/dashboard/widgets?${query}` : '/api/dashboard/widgets';
        if (!includeEntities) {
            const payload = await _fetchDashboardLayoutJson(url, 20000, externalSignal);
            const normalized = _normalizeCache(payload);
            normalized.available_entities = Array.isArray(_dashboardCache.available_entities)
                ? _dashboardCache.available_entities
                : [];
            _dashboardCache = normalized;
            _saveDashboardViewCache(_dashboardCache);
            // Sync the active page id with whatever the server confirmed.
            if (_dashboardCache.page_id) _currentPageId = _dashboardCache.page_id;
            // Snapshot this page for instant render on next visit.
            _stashDashboardPageSnapshot(_dashboardCache.page_id || _currentPageId, _dashboardCache);
            return _dashboardCache.available_entities;
        }

        const res = await apiCall(url);
        if (res.ok) {
            const payload = await res.json();
            const normalized = _normalizeCache(payload);
            if (!Array.isArray(payload.available_entities)) {
                normalized.available_entities = Array.isArray(_dashboardCache.available_entities)
                    ? _dashboardCache.available_entities
                    : [];
            }
            _dashboardCache = normalized;
            _saveDashboardViewCache(_dashboardCache);
            // Sync the active page id with whatever the server confirmed.
            if (_dashboardCache.page_id) _currentPageId = _dashboardCache.page_id;
            // Snapshot this page for instant render on next visit.
            _stashDashboardPageSnapshot(_dashboardCache.page_id || _currentPageId, _dashboardCache);
            return _dashboardCache.available_entities;
        }
    } catch (err) {
        if (!includeEntities) throw err;
    }

    const [statesRes, manageRes] = await Promise.all([
        apiCall('/api/integrations/all-entities').catch(() => null),
        Promise.resolve(null),
    ]);

    // Smart-home backend is just one integration — if it's unreachable we still
    // render an empty entity picker rather than blocking the whole dashboard.
    const states = statesRes && statesRes.ok ? await statesRes.json() : [];
    const managed = manageRes && manageRes.ok ? await manageRes.json() : [];
    const managedMap = new Map((Array.isArray(managed) ? managed : []).map(item => [item.entity_id, item]));

    const items = (Array.isArray(states) ? states : [])
        .filter(raw => {
            const entityId = String(raw?.entity_id || '');
            const domain = entityId.includes('.') ? entityId.split('.', 1)[0] : '';
            return _isControllableDomain(domain) || _isInfoDomain(domain);
        })
        .map(raw => {
            const entityId = String(raw.entity_id || '');
            const attrs = raw.attributes || {};
            const managedItem = managedMap.get(entityId) || {};
            const name = managedItem.name || attrs.friendly_name || entityId;
            const domain = entityId.split('.', 1)[0] || 'switch';
            const source = managedItem.source
                || (/zigbee|z2m/i.test(`${entityId} ${name}`) ? 'zigbee2mqtt' : 'unknown');
            return {
                entity_id: entityId,
                name,
                state: String(raw.state || 'unknown'),
                domain,
                source,
                aliases: Array.isArray(managedItem.aliases) ? managedItem.aliases : [],
                unit: attrs.unit_of_measurement || '',
                controllable: _isControllableDomain(domain),
            };
        })
        .sort((a, b) => `${a.source}:${a.name}`.localeCompare(`${b.source}:${b.name}`, 'ro'));

    _dashboardCache = _normalizeCache({
        widgets: fallbackSection.widgets,
        panels: fallbackSection.panels,
        pages: fallbackSection.pages,
        preferences: fallbackSection.preferences,
        available_entities: items,
        title: fallbackSection.title,
        subtitle: fallbackSection.subtitle,
        icon: fallbackSection.icon,
        columns: fallbackSection.columns,
    });
    return items;
}

function _renderEntityOptions(input, type = 'button', selectedValue = '') {
    if (!input) return;
    const items = Array.isArray(_dashboardCache.available_entities) ? _dashboardCache.available_entities : [];
    const searchQuery = _getEntitySearchValue(input);
    const list = document.getElementById(input.id === 'dashboard-edit-entity-select' ? 'dashboard-edit-entity-options' : 'dashboard-entity-options');

    if (type === 'label') {
        input.disabled = true;
        input.value = '';
        input.dataset.currentValue = '';
        input.placeholder = t('dashboard.entity_not_required_label') || 'Entity is not required for labels.';
        if (list) list.innerHTML = '';
        return;
    }

    const filtered = items
        .filter(item => _entityAllowedForCard(item, type))
        .filter(item => _entityMatchesSearch(item, searchQuery));

    if (list) {
        list.innerHTML = filtered.map(item => {
            const label = _entityOptionLabel(item);
            return `<option value="${_escape(label)}"></option>`;
        }).join('');
    }

    input.disabled = false;
    input.placeholder = searchQuery
        ? (filtered.length
            ? (t('dashboard.entity_choose_from_results') || 'Choose the entity you want...')
            : (t('dashboard.entity_search_no_results') || 'No entities found for this search.'))
        : (t('dashboard.entity_choose_or_search') || 'Choose or search an entity...');

    if (selectedValue) {
        const selected = items.find(item => item.entity_id === selectedValue);
        if (selected) {
            input.value = _entityOptionLabel(selected);
            input.dataset.currentValue = selected.entity_id;
        }
    }
}

export function updateDashboardTypeUI() {
    const type = document.getElementById('dashboard-widget-type')?.value || 'button';
    const renderer = _dashboardEditorRenderer(type);
    const entityGroup = document.getElementById('dashboard-entity-group');
    const titleSubtitleGroup = document.getElementById('dashboard-title-subtitle-group')
        || document.getElementById('dashboard-widget-title')?.closest?.('.grid');
    const subtitleLabel = document.getElementById('dashboard-widget-subtitle-label');
    const subtitleInput = document.getElementById('dashboard-widget-subtitle');
    const bgWrap = document.getElementById('dashboard-label-background-wrap');
    const switchWrap = document.getElementById('dashboard-button-switch-wrap');
    const climateEntitiesGroup = document.getElementById('dashboard-climate-entities-group');
    const cameraModeWrap = document.getElementById('dashboard-camera-mode-wrap');
    if (entityGroup) entityGroup.classList.toggle('hidden', type === 'label');
    if (titleSubtitleGroup) titleSubtitleGroup.classList.toggle('hidden', type === 'climate');
    if (climateEntitiesGroup) climateEntitiesGroup.classList.toggle('hidden', type !== 'climate');
    if (cameraModeWrap) cameraModeWrap.classList.toggle('hidden', renderer !== 'camera');
    if (bgWrap) bgWrap.classList.toggle('hidden', type !== 'label');
    if (switchWrap) switchWrap.classList.toggle('hidden', type !== 'button');
    if (subtitleLabel) {
        subtitleLabel.textContent = type === 'label'
            ? (t('dashboard.optional_text') || 'Optional text')
            : (t('dashboard.subtitle_or_text') || 'Subtitle / text');
    }
    if (subtitleInput) {
        subtitleInput.placeholder = type === 'label'
            ? (t('dashboard.subtitle_placeholder_label') || 'You can leave this empty for title only')
            : (t('dashboard.subtitle_placeholder_default') || 'e.g. Ground floor or short text');
    }
    const rowSpan = document.getElementById('dashboard-widget-row-span');
    const defaultRows = _dashboardDefaultRowsForType(type);
    if (!_dashboardCurrentEditorId && rowSpan && defaultRows > (parseInt(rowSpan.value || '1', 10) || 1)) {
        rowSpan.value = String(defaultRows);
        _syncDashboardSizeSlidersFromSelects();
        _syncDashboardCustomSelect(rowSpan);
    }
    _renderEntityOptions(document.getElementById('dashboard-entity-select'), type);
    renderDashboardClimateEntityChips();
    _enhanceDashboardCustomSelects(document.getElementById('dashboard-add-modal'));
    _renderDashboardAddPreview();
}

export function updateDashboardEditTypeUI() {
    const type = document.getElementById('dashboard-edit-widget-type')?.value || 'button';
    const entityGroup = document.getElementById('dashboard-edit-entity-group');
    const bgWrap = document.getElementById('dashboard-edit-label-background-wrap');
    const switchWrap = document.getElementById('dashboard-edit-button-switch-wrap');
    if (entityGroup) entityGroup.classList.toggle('hidden', type === 'label');
    if (bgWrap) bgWrap.classList.toggle('hidden', type !== 'label');
    if (switchWrap) switchWrap.classList.toggle('hidden', type !== 'button');
    const current = document.getElementById('dashboard-edit-entity-select')?.dataset?.currentValue || '';
    _renderEntityOptions(document.getElementById('dashboard-edit-entity-select'), type, current);
}

export function updateDashboardEntityOptions() {
    const select = document.getElementById('dashboard-entity-select');
    const type = document.getElementById('dashboard-widget-type')?.value || 'button';
    _renderEntityOptions(select, type);
}

export function filterDashboardEntityOptions(mode = 'add') {
    _entityPickerMode = mode;
    _renderEntityPickerMenu(mode);
}

export function openDashboardEntityPicker(mode = 'add') {
    _entityPickerMode = mode;
    _entityPickerActiveIndex = -1;
    const menu = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-picker-menu' : 'dashboard-entity-picker-menu');
    if (menu) menu.classList.remove('hidden');
    _renderEntityPickerMenu(mode);
    // Bind a single outside-click closer.
    if (!window.__dashboardEntityPickerOutsideBound) {
        window.__dashboardEntityPickerOutsideBound = true;
        document.addEventListener('click', (ev) => {
            ['add', 'edit'].forEach(m => {
                const wrap = document.getElementById(m === 'edit' ? 'dashboard-edit-entity-picker' : 'dashboard-entity-picker');
                const menuEl = document.getElementById(m === 'edit' ? 'dashboard-edit-entity-picker-menu' : 'dashboard-entity-picker-menu');
                if (!wrap || !menuEl) return;
                if (!wrap.contains(ev.target)) menuEl.classList.add('hidden');
            });
        });
    }
}

export function closeDashboardEntityPicker(mode = 'add') {
    const menu = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-picker-menu' : 'dashboard-entity-picker-menu');
    if (menu) menu.classList.add('hidden');
}

export function handleDashboardEntityPickerKeydown(mode, ev) {
    const items = _currentEntityPickerItems(mode);
    const menu = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-picker-menu' : 'dashboard-entity-picker-menu');
    if (!menu) return;
    if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (menu.classList.contains('hidden')) openDashboardEntityPicker(mode);
        _entityPickerActiveIndex = Math.min(items.length - 1, _entityPickerActiveIndex + 1);
        _renderEntityPickerMenu(mode);
    } else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        _entityPickerActiveIndex = Math.max(0, _entityPickerActiveIndex - 1);
        _renderEntityPickerMenu(mode);
    } else if (ev.key === 'Enter') {
        const pick = items[_entityPickerActiveIndex] || items[0];
        if (pick) {
            ev.preventDefault();
            pickDashboardEntityOption(mode, pick.entity_id);
        }
    } else if (ev.key === 'Escape') {
        closeDashboardEntityPicker(mode);
    }
}

export function pickDashboardEntityOption(mode, entityId) {
    const input = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-select' : 'dashboard-entity-select');
    if (!input) return;
    const items = Array.isArray(_dashboardCache.available_entities) ? _dashboardCache.available_entities : [];
    const found = items.find(it => it.entity_id === entityId);
    if (found) {
        input.value = _entityOptionLabel(found);
        input.dataset.currentValue = found.entity_id;
    } else {
        input.value = entityId;
        input.dataset.currentValue = entityId;
    }
    closeDashboardEntityPicker(mode);
    if (mode !== 'edit') {
        const type = document.getElementById('dashboard-widget-type')?.value || 'button';
        if (type === 'climate') addDashboardClimateEntityId(entityId);
    }
    if (mode !== 'edit') _renderDashboardAddPreview();
}


function _currentEntityPickerItems(mode) {
    const input = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-select' : 'dashboard-entity-select');
    const type = document.getElementById(mode === 'edit' ? 'dashboard-edit-widget-type' : 'dashboard-widget-type')?.value || 'button';
    const items = Array.isArray(_dashboardCache.available_entities) ? _dashboardCache.available_entities : [];
    const query = _getEntitySearchValue(input);
    // HA-style picker: show ALL entities and let the user pick. We sort
    // controllable entities first so they're easy to find, but never hide
    // anything (mosquitto fallback marks devices as controllable=false even
    // when the bridge is up — filtering them out makes the picker look empty).
    return items
        .filter(item => _entityAllowedForCard(item, type))
        .filter(item => _entityMatchesSearch(item, query))
        .slice()
        .sort((a, b) => {
            const ac = a.controllable === false ? 1 : 0;
            const bc = b.controllable === false ? 1 : 0;
            if (ac !== bc) return ac - bc;
            return String(a.name || a.entity_id).localeCompare(String(b.name || b.entity_id));
        })
        .slice(0, 80);
}

function _renderEntityPickerMenu(mode = 'add') {
    const menu = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-picker-menu' : 'dashboard-entity-picker-menu');
    if (!menu) return;
    const items = _currentEntityPickerItems(mode);
    if (!items.length) {
        menu.innerHTML = `<div class="dashboard-entity-picker__empty">${_escape(t('dashboard.climate.entities_empty'))}</div>`;
        menu.classList.remove('hidden');
        return;
    }
    menu.innerHTML = items.map((it, idx) => {
        const isActive = idx === _entityPickerActiveIndex;
        const safeId = _escape(it.entity_id);
        const safeMode = _escape(mode);
        const icon = _escape(_entityIcon(it.domain));
        return `<button type="button"
            data-active="${isActive ? 'true' : 'false'}"
            class="dashboard-entity-picker__item"
            data-dash-prevent-default="true"
            data-dash-action="pickEntity"
            data-mode="${safeMode}"
            data-entity-id="${safeId}">
            <i class="${icon} dashboard-entity-picker__icon"></i>
            <span class="dashboard-entity-picker__name">${_escape(it.name || it.entity_id)}</span>
            <span class="dashboard-entity-picker__id">${safeId}</span>
        </button>`;
    }).join('');
    menu.classList.remove('hidden');
}

let _loadDashboardInFlight = null;
let _loadDashboardStartedAt = 0;
let _loadDashboardAbortController = null;

function _transientDashboardGridMatches(text) {
    const haystack = String(text || '');
    const patterns = [
        t('dashboard.loading_dashboard'),
        t('dashboard.loading_page'),
        t('dashboard.page_load_timeout'),
        t('dashboard.refresh_timeout'),
        t('dashboard.load_failed_short'),
        t('dashboard.load_error'),
    ];
    return patterns.some((p) => p && haystack.includes(p));
}

function _dashboardGridHasRealContent(grid = document.getElementById('dashboard-grid')) {
    if (!grid || !grid.firstElementChild) return false;
    return !_transientDashboardGridMatches(grid.textContent || '');
}

export function dashboardHasRenderedContent() {
    return _dashboardGridHasRealContent();
}

export function loadDashboard(options = {}) {
    const force = !!options.force;
    const soft = !!options.soft;
    const now = Date.now();
    // If the previous load got wedged somewhere below fetch/paint, don't let
    // tab navigation keep returning the same stale promise forever.
    if (_loadDashboardInFlight && !force && (now - _loadDashboardStartedAt) < 12000) return _loadDashboardInFlight;
    if (_loadDashboardInFlight && (force || (now - _loadDashboardStartedAt) >= 12000)) {
        // Abort the still-pending fetch (if any) so it doesn't keep holding
        // the backend `_AVAIL_BUILD_LOCK` and starve the new attempt.
        try { _loadDashboardAbortController?.abort?.(); } catch (_) {}
        _loadDashboardAbortController = null;
        _loadDashboardInFlight = null;
        _loadDashboardStartedAt = 0;
        _setDashboardRefreshIndicator(false);
    }
    _loadDashboardStartedAt = now;
    _loadDashboardAbortController = new AbortController();
    _loadDashboardInFlight = _loadDashboardImpl(_loadDashboardAbortController.signal, { soft }).finally(() => {
        _loadDashboardInFlight = null;
        _loadDashboardStartedAt = 0;
        _loadDashboardAbortController = null;
    });
    return _loadDashboardInFlight;
}

async function _loadDashboardImpl(signal = null, { soft = false } = {}) {
    const grid = document.getElementById('dashboard-grid');
    if (!grid) return;
    _setDashboardRefreshIndicator(false);
    // Reveal admin-only dashboard header controls when the user can edit layout.
    applyDashboardEditAccess();
    if (!canEditDashboard() && _dashboardEditMode) {
        resetDashboardEditingState();
    }
    _bindHashRouter();
    // If the URL hash points to a specific page, prefer it over the cached one.
    const hashPage = _readHashPageId();
    if (hashPage) {
        _currentPageId = hashPage;
    } else if (!_currentPageId) {
        try {
            const storedPage = String(localStorage.getItem(DASHBOARD_LAST_PAGE_KEY) || '');
            if (storedPage) _currentPageId = storedPage;
        } catch (_) {}
    }
    // If the grid currently only holds a transient placeholder/error from a
    // previous attempt (e.g. a timeout banner shown while the user was on
    // another tab), wipe it so the cached snapshot can render instantly and
    // the user doesn't keep staring at a stale error message.
    const transientText = String(grid.textContent || '');
    if (grid.firstElementChild && _transientDashboardGridMatches(transientText)) {
        grid.innerHTML = '';
    }
    const layoutFpBefore = _dashboardSnapshotFingerprint(_dashboardCache);
    const renderedFromCache = _renderCachedDashboardIfEmpty();
    const hadRealContent = renderedFromCache || _dashboardGridHasRealContent(grid);
    // If we re-rendered cached cards, any previously paused camera streams
    // are still in the DOM but paused — resume them now that the dashboard
    // is visible again.
    if (renderedFromCache) {
        try { resumeDashboardCameras(); } catch (_) {}
    }
    // Only show the inline placeholder when the grid is currently empty —
    // otherwise we flash an unnecessary "loading" message over already-rendered cards.
    if (!renderedFromCache && !grid.firstElementChild) {
        grid.innerHTML = `<div class="col-span-full p-6 text-sm" style="color:var(--text-tertiary,#94a3b8);">${_escape(t('dashboard.loading_dashboard'))}</div>`;
    }
    try {
        getCameraStreamToken().catch(() => {});
        await _refreshAvailableEntities({ includeEntities: false, signal });
        // After first fetch the server tells us the active page; reflect it in the URL.
        if (_currentPageId) _setHashForPage(_currentPageId);
        const layoutFpAfter = _dashboardSnapshotFingerprint(_dashboardCache);
        const layoutChanged = layoutFpBefore !== layoutFpAfter;
        if (!hadRealContent || layoutChanged || !soft) {
            _renderDashboard();
        } else {
            try { _configureHyveviewMounted(grid); } catch (_) {}
        }
        try { resumeDashboardCameras(); } catch (_) {}
        updateDashboardEntityOptions();
        // Phase 4: open live WS so cards update without polling.
        _connectDashboardLive();
        // After the initial page is rendered, quietly prefetch the other
        // pages so subsequent navigation is instant.
        _schedulePagePrefetch();
    } catch (e) {
        // If a newer load aborted us, stay silent.
        if (e && (e.name === 'AbortError' || e.name === 'DashboardRefreshAbortError')) return;
        _setEntitySelectState(t('dashboard.load_entities_failed'), true);
        // If the grid is already showing real cached content, do NOT replace
        // it with a red banner just because a background refresh timed out.
        // The user keeps seeing their dashboard, and the live WS will keep
        // values fresh. Only surface the error if the grid is empty / had
        // nothing to show in the first place.
        const gridHasRealContent = !!grid.firstElementChild
            && !(grid.children.length === 1
                && _transientDashboardGridMatches(grid.textContent || ''));
        if (!gridHasRealContent) {
            grid.innerHTML = `<div class="col-span-full rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-300">${_escape(e.message || t('dashboard.load_error'))}</div>`;
        } else {
            try { console.warn('[dashboard] refresh failed, keeping cached cards:', e?.message || e); } catch (_) {}
        }
    }
}


/**
 * Switch all add/edit-only labels in the dashboard add modal. Updates both
 * textContent AND data-i18n so a later translation pass does not restore the
 * add-mode strings. Also tags the modal with data-mode so CSS hooks can react.
 */
function _applyDashboardModalMode(mode /* 'add' | 'edit' */) {
    const modal = document.getElementById('dashboard-add-modal');
    if (!modal) return;
    const isEdit = mode === 'edit';
    modal.dataset.mode = isEdit ? 'edit' : 'add';

    const apply = (selector, i18nKey, fallback) => {
        const el = modal.querySelector(selector);
        if (!el) return;
        el.setAttribute('data-i18n', i18nKey);
        const translated = t(i18nKey);
        // Some t() implementations return the key itself when no translation
        // exists; treat that as a miss and use the human fallback.
        el.textContent = (translated && translated !== i18nKey) ? translated : fallback;
    };

    if (isEdit) {
        apply('h3', 'dashboard.edit_card', 'Edit card');
        apply('h3 + p', 'dashboard.edit_card_hint', 'Modifică setările cardului și salvează.');
        apply('button[data-dash-action="saveAddWidget"]', 'common.save', 'Salvează');
    } else {
        apply('h3', 'dashboard.add_card', 'Adaugă card');
        apply('h3 + p', 'dashboard.add_card_hint', 'Alege tipul de card și vezi preview înainte de salvare.');
        apply('button[data-dash-action="saveAddWidget"]', 'common.add', 'Adaugă');
    }
}

export async function openDashboardAddModal(kind = 'button') {
    if (!requireDashboardEditAccess()) return;
    const modal = document.getElementById('dashboard-add-modal');
    if (!modal) return;
    // Default to add-mode; openDashboardWidgetEditor flips it after we return.
    _applyDashboardModalMode('add');
    closeDashboardMenu();
    syncModalViewportMetrics();
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    // Populate the type <select> from the catalog (it's empty in HTML).
    const type = document.getElementById('dashboard-widget-type');
    try {
        const cards = await _loadDashboardCardCatalog();
        if (type && cards.length) {
            type.innerHTML = cards.map(c =>
                `<option value="${_escape(c.id)}">${_escape(c.label)}</option>`
            ).join('');
        }
    } catch (_) { /* keep existing options */ }

    const title = document.getElementById('dashboard-widget-title');
    const subtitle = document.getElementById('dashboard-widget-subtitle');
    const icon = document.getElementById('dashboard-widget-icon');
    const size = document.getElementById('dashboard-widget-size');
    const colSpan = document.getElementById('dashboard-widget-col-span');
    const rowSpan = document.getElementById('dashboard-widget-row-span');
    const showBackground = document.getElementById('dashboard-widget-label-bg');
    const cameraMode = document.getElementById('dashboard-widget-camera-mode');
    if (title) title.value = '';
    if (subtitle) subtitle.value = '';
    if (icon) icon.value = '';
    if (type) type.value = kind || 'button';
    if (size) size.value = 'md';
    if (colSpan) colSpan.value = String(DASHBOARD_COL_POINTS_MAX);
    if (rowSpan) rowSpan.value = String(_dashboardDefaultRowsForType(kind || 'button'));
    if (showBackground) showBackground.checked = false;
    if (cameraMode) cameraMode.value = 'snapshots';
    const switchStyle = document.getElementById('dashboard-widget-switch-style');
    if (switchStyle) switchStyle.checked = false;
    const picker = document.getElementById('dashboard-entity-select');
    if (picker) {
        picker.value = '';
        picker.dataset.currentValue = '';
    }
    clearDashboardClimateEntitySelection();
    _enhanceDashboardCustomSelects(modal);

    _setEntitySelectState(t('dashboard.loading_entities') || 'Loading entities...', true);
    try {
        await _refreshAvailableEntities();
        updateDashboardTypeUI();
    } catch (e) {
        _setEntitySelectState(t('dashboard.loading_entities_error') || 'Could not load entities.', true);
        showToast(e.message || (t('dashboard.loading_entities_error_toast') || 'Error loading entities'), 'error');
    }

    // Wire live preview listeners on first open and reset to "visual" tab.
    _wireDashboardAddPreviewListeners();
    setDashboardAddEditorMode('visual');
    const visEnabled = document.getElementById('dashboard-visibility-enabled');
    if (visEnabled) visEnabled.checked = false;
    const visBody = document.getElementById('dashboard-visibility-body');
    if (visBody) visBody.classList.add('hidden');
    const visConds = document.getElementById('dashboard-visibility-conditions');
    if (visConds) visConds.innerHTML = '';
    _renderDashboardAddPreview();
}

export function closeDashboardAddModal() {
    const modal = document.getElementById('dashboard-add-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    clearDashboardClimateEntitySelection();
    // Reset edit-mode hijack so the next open is a fresh add.
    if (_dashboardCurrentEditorId) {
        _dashboardCurrentEditorId = null;
        const headerTitle = document.querySelector('#dashboard-add-modal h3');
        if (headerTitle) headerTitle.textContent = t('dashboard.add_card') || 'Add card';
        const saveBtn = document.querySelector('#dashboard-add-modal button[data-dash-action="saveAddWidget"]');
        if (saveBtn) saveBtn.textContent = t('common.add') || 'Add';
    }
}

export function toggleDashboardEditMode() {
    if (!requireDashboardEditAccess()) return;
    _resolveCurrentDashboardPageId();
    _dashboardEditMode = !_dashboardEditMode;
    if (_dashboardEditMode) {
        document.documentElement.setAttribute('data-dashboard-editing', 'true');
    } else {
        document.documentElement.removeAttribute('data-dashboard-editing');
    }
    closeDashboardMenu();
    _renderDashboard();
    showToast(_dashboardEditMode
        ? (t('dashboard.edit_mode_on') || 'Edit mode enabled')
        : (t('dashboard.edit_mode_off') || 'Edit mode disabled'), 'success');
}

export async function setDashboardFilter(mode) {
    if (!requireDashboardEditAccess()) return;
    _dashboardCache.preferences = { ...DEFAULT_PREFS, ...(_dashboardCache.preferences || {}), filter_mode: mode || 'all' };
    _renderDashboard();
    await saveDashboardPreferences(true);
}

export async function toggleDashboardLayout() {
    if (!requireDashboardEditAccess()) return;
    const next = (_dashboardCache.preferences?.layout_mode === 'compact') ? 'comfortable' : 'compact';
    _dashboardCache.preferences = { ...DEFAULT_PREFS, ...(_dashboardCache.preferences || {}), layout_mode: next };
    _renderDashboard();
    await saveDashboardPreferences(true);
}

export async function saveDashboardPreferences(silent = false) {
    if (!requireDashboardEditAccess()) return;
    const hideCb = document.getElementById('dashboard-hide-unavailable');
    const prefs = {
        ...DEFAULT_PREFS,
        ...(_dashboardCache.preferences || {}),
        show_unavailable: !(hideCb?.checked),
    };

    try {
        const res = await apiCall('/api/dashboard/preferences', {
            method: 'PATCH',
            body: {
                ...prefs,
                title: _dashboardCache.title || DEFAULT_META.title,
                subtitle: _dashboardCache.subtitle || DEFAULT_META.subtitle,
            }
        });
        if (res.ok) {
            const data = await res.json().catch(() => ({}));
            _dashboardCache.preferences = { ...DEFAULT_PREFS, ...(data.preferences || prefs) };
            _renderDashboard();
            if (!silent) showToast(t('dashboard.preferences_saved'), 'success');
            return;
        }
        if (res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(_dashApiError(err.detail, 'dashboard.save_preferences_failed'));
        }
    } catch (e) {
        if (!String(e?.message || '').includes(t('dashboard.save_widget_failed'))) {
            // continue to fallback
        }
    }

    const section = await _readDashboardSectionFallback();
    section.preferences = prefs;
    await _writeDashboardSectionFallback(section);
    _dashboardCache.preferences = section.preferences;
    _renderDashboard();
    if (!silent) showToast(t('dashboard.preferences_saved'), 'success');
}

function _slug(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'section';
}

// ──────────────────────────────────────────────────────────────────────
// R5.2: schema-driven editor bridge (add/edit/delete dashboard widgets).
// ──────────────────────────────────────────────────────────────────────

async function _ensureHyveviewEntitySeed() {
    // The new editor reads from `core/store.js` (WebSocket-fed). Until the
    // dashboard switches its own data source to that store, seed it from the
    // REST-backed dashboard cache so entity pickers are populated immediately.
    if (!Array.isArray(_dashboardCache.available_entities) || !_dashboardCache.available_entities.length) {
        try { await _refreshAvailableEntities(); } catch { /* non-fatal */ }
    }
    const seed = (_dashboardCache.available_entities || []).map(e => ({
        entity_id: e.entity_id,
        friendly_name: e.name || e.friendly_name || e.entity_id,
        source: e.source || '',
        attributes: e.attributes || {},
        state: e.state ?? null,
        unit: e.unit || '',
    }));
    try {
        const mod = await import('/static/hyveview/core/store.js');
        if (mod && typeof mod.seedEntities === 'function') mod.seedEntities(seed);
    } catch { /* offline ok */ }
}

function _widgetToEditorCard(widget) {
    const type = widget.type || 'button';
    const rawCol = Number(widget.col_span);
    const col = Math.min(Math.max(Number.isFinite(rawCol) ? rawCol : SECTION_COLS, 1), SECTION_COLS);
    const row = Math.min(Math.max(Number(widget.row_span) || 2, 1), 12);

    const cfg = {
        title: widget.title || '',
        icon: widget.icon || widget?.config?.icon || '',
        color: widget.color || '',
        switch_style: !!widget.switch_style,
        show_background: !!widget.show_background,
        entity_name: widget.entity_name || '',
    };
    if (type !== 'label') cfg.entity_id = widget.entity_id || '';
    if (type === 'camera') {
        cfg.entity = widget.entity_id || '';
        const raw = widget?.config?.camera_mode || 'snapshot';
        cfg.mode = raw === 'live' ? 'live' : 'snapshot';
        cfg.interval = Number(widget?.config?.interval) || DEFAULT_CAMERA_INTERVAL;
        cfg.default_audio = !!widget?.config?.default_audio;
        cfg.default_microphone = !!widget?.config?.default_microphone;
        cfg.preload = !!widget?.config?.preload;
        cfg.preload_scope = widget?.config?.preload_scope === 'all' ? 'all' : 'adjacent';
        const ents = widget?.config?.entities || [];
        cfg.entities = (Array.isArray(ents) ? ents : []).map((e) => typeof e === 'string'
            ? { entity_id: e, title: '', subtitle: '' }
            : { entity_id: e.entity_id || '', title: e.title || '', subtitle: e.subtitle || '' }
        ).filter((e) => e.entity_id);
        if (!cfg.entities.length && widget.entity_id) {
            cfg.entities = [{ entity_id: widget.entity_id, title: widget.title || '', subtitle: '' }];
        }
    }
    if (type === 'picture') {
        cfg.sources = Array.isArray(widget?.config?.sources) ? widget.config.sources : [];
        if (!cfg.sources.length && widget.entity_id && widget.entity_id.startsWith('image.')) {
            cfg.sources = [{ type: 'entity', value: widget.entity_id }];
        }
        cfg.interval = Number(widget?.config?.interval) || 15;
    }
    if (type === 'climate') {
        const ents = widget?.config?.entities || widget?.config?.entity_ids || [];
        cfg.entities = ents.map(e => typeof e === 'string'
            ? { entity_id: e, title: '', subtitle: '' }
            : { entity_id: e.entity_id, title: e.title || '', subtitle: e.subtitle || '' });
    }
    if (type === 'fusion_solar') {
        const cfgIn = widget?.config && typeof widget.config === 'object' ? widget.config : {};
        const powerEnts = Array.isArray(cfgIn.power_entities) ? cfgIn.power_entities : [];
        cfg.power_entities = powerEnts.length
            ? powerEnts.map((e) => typeof e === 'string'
                ? { entity_id: e, title: '', subtitle: '' }
                : { entity_id: e.entity_id || '', title: e.title || '', subtitle: e.subtitle || '' })
            : (widget.entity_id ? [{ entity_id: widget.entity_id, title: '', subtitle: '' }] : []);
        cfg.entity_load = cfgIn.entity_load || '';
        cfg.entity_grid = cfgIn.entity_grid || '';
        cfg.entity_grid_export = cfgIn.entity_grid_export || '';
        cfg.entity_grid_import = cfgIn.entity_grid_import || '';
        cfg.entity_daily = cfgIn.entity_daily || '';
        cfg.entity_monthly = cfgIn.entity_monthly || '';
        cfg.entity_yearly = cfgIn.entity_yearly || '';
        cfg.entity_feed_in = cfgIn.entity_feed_in || '';
        cfg.entity_consumption = cfgIn.entity_consumption || '';
        cfg.capacity_kw = cfgIn.capacity_kw ?? '';
    }

    return {
        id: widget.id,
        type,
        entity: widget.entity_id || null,
        layout: { col, row },
        config: cfg,
        visibility: widget.visibility || null,
    };
}

function _editorResultToWidgetBody(result, { existingWidget = null } = {}) {
    const type = result.type || 'button';
    const cfg = result.config || {};
    const col = Math.min(Math.max(Number(result.layout?.col) || SECTION_COLS, 1), SECTION_COLS);
    const row = Math.min(Math.max(Number(result.layout?.row) || 2, 1), 12);

    let entityId;
    if (type === 'label') {
        const baseTitle = cfg.title || cfg.entity_name || 'section';
        entityId = existingWidget?.entity_id || `label.${_slug(baseTitle)}`;
    } else if (type === 'climate') {
        const entities = Array.isArray(cfg.entities) ? cfg.entities : [];
        const first = entities[0];
        entityId = (typeof first === 'string' ? first : first?.entity_id) || '';
    } else if (type === 'camera') {
        const entities = Array.isArray(cfg.entities) ? cfg.entities : [];
        const first = entities[0];
        entityId = (typeof first === 'string' ? first : first?.entity_id) || (cfg.entity || cfg.entity_id || '').trim();
    } else if (type === 'picture') {
        const sources = Array.isArray(cfg.sources) ? cfg.sources : [];
        const firstEnt = sources.find(s => s.type === 'entity');
        entityId = firstEnt ? firstEnt.value : (existingWidget?.entity_id || `picture.gallery_${Date.now()}`);
    } else if (type === 'fusion_solar') {
        const powerRecords = (Array.isArray(cfg.power_entities) ? cfg.power_entities : [])
            .map((e) => typeof e === 'string'
                ? { entity_id: e, title: '', subtitle: '' }
                : { entity_id: e.entity_id || '', title: e.title || '', subtitle: e.subtitle || '' })
            .filter((e) => e.entity_id);
        entityId = powerRecords[0]?.entity_id || (cfg.entity_id || cfg.entity || '').trim();
    } else {
        entityId = (cfg.entity_id || cfg.entity || '').trim();
    }

    // Look up source from the entity cache (label is always manual).
    let source = existingWidget?.source || '';
    if (!source) {
        if (type === 'label') source = 'manual';
        else {
            const ent = (_dashboardCache.available_entities || []).find(e => e.entity_id === entityId);
            source = ent?.source || 'zigbee2mqtt';
        }
    }

    const body = {
        type,
        entity_id: entityId,
        entity_name: (cfg.entity_name || cfg.title || entityId || '').toString().trim(),
        title: (cfg.title || '').toString().trim(),
        icon: (cfg.icon || '').toString().trim(),
        source,
        size: existingWidget?.size || 'md',
        favorite: !!existingWidget?.favorite,
        show_background: type === 'label' ? !!cfg.show_background : false,
        switch_style: (type === 'button' || type === 'switch') ? !!cfg.switch_style : false,
        col_span: col,
        row_span: row,
    };
    if (cfg.color) body.color = cfg.color;
    if (type === 'climate') {
        const records = (Array.isArray(cfg.entities) ? cfg.entities : []).map(e =>
            typeof e === 'string'
                ? { entity_id: e }
                : { entity_id: e.entity_id, title: e.title || '', subtitle: e.subtitle || '' }
        ).filter(r => r.entity_id);
        body.config = { entities: records, entity_ids: records.map(r => r.entity_id) };
    }
    if (type === 'camera') {
        const cameraMode = (cfg.mode || cfg.camera_mode || 'snapshot') === 'live' ? 'live' : 'snapshots';
        const interval = Number(cfg.interval) || DEFAULT_CAMERA_INTERVAL;
        const records = (Array.isArray(cfg.entities) ? cfg.entities : []).map((e) =>
            typeof e === 'string'
                ? { entity_id: e, title: '', subtitle: '' }
                : { entity_id: e.entity_id, title: e.title || '', subtitle: e.subtitle || '' }
        ).filter((r) => r.entity_id);
        if (!records.length && entityId) {
            records.push({ entity_id: entityId, title: cfg.title || '', subtitle: '' });
        }
        body.config = {
            ...(body.config || {}),
            camera_mode: cameraMode,
            interval,
            entities: records,
            entity_ids: records.map((r) => r.entity_id),
            default_audio: !!cfg.default_audio,
            default_microphone: !!cfg.default_microphone,
            preload: !!cfg.preload,
            preload_scope: cfg.preload_scope === 'all' ? 'all' : 'adjacent',
        };
        if (records[0]?.title && !Object.prototype.hasOwnProperty.call(cfg, 'title')) body.title = records[0].title;
    }
    if (type === 'picture') {
        const sources = Array.isArray(cfg.sources) ? cfg.sources.filter(s => s && s.value) : [];
        const interval = Number(cfg.interval) || 15;
        body.config = { ...(body.config || {}), sources, interval };
        const firstEntity = sources.find(s => s.type === 'entity');
        if (firstEntity) body.entity_id = firstEntity.value;
        else if (!body.entity_id) body.entity_id = `picture.gallery_${Date.now()}`;
    }
    if (type === 'fusion_solar') {
        const powerRecords = (Array.isArray(cfg.power_entities) ? cfg.power_entities : [])
            .map((e) => typeof e === 'string'
                ? { entity_id: e, title: '', subtitle: '' }
                : { entity_id: e.entity_id || '', title: e.title || '', subtitle: e.subtitle || '' })
            .filter((e) => e.entity_id);
        const powerId = powerRecords[0]?.entity_id || body.entity_id || '';
        const slotKeys = [
            'entity_load', 'entity_grid', 'entity_grid_export', 'entity_grid_import',
            'entity_daily', 'entity_monthly', 'entity_yearly', 'entity_feed_in', 'entity_consumption',
        ];
        const slotCfg = {};
        slotKeys.forEach((k) => {
            const v = String(cfg[k] || '').trim();
            if (v) slotCfg[k] = v;
        });
        body.config = {
            ...(body.config || {}),
            power_entities: powerRecords,
            ...slotCfg,
            capacity_kw: cfg.capacity_kw === '' || cfg.capacity_kw == null ? undefined : Number(cfg.capacity_kw),
        };
        body.config.entity_ids = fusionSolarWidgetEntityIds({ entity_id: powerId, config: body.config });
        if (!body.source || body.source === 'zigbee2mqtt') {
            const ent = (_dashboardCache.available_entities || []).find(e => e.entity_id === powerId);
            if (ent?.source) body.source = ent.source;
        }
    }
    if (result.visibility) body.visibility = result.visibility;
    return body;
}

async function _saveDashboardWidgetFromEditor(result, { editingId = null, original = null } = {}) {
    const body = _editorResultToWidgetBody(result, { existingWidget: original });
    // Minimum validation: non-label cards must have an entity_id.
    const _entitylessTypes = ['label', 'picture'];
    if (!_entitylessTypes.includes(body.type) && !body.entity_id) {
        showToast(t('dashboard.entity_required') || 'Pick an entity', 'warning');
        return;
    }
    const activePageId = _currentPageId || _dashboardCache.current_page_id || _dashboardCache.page_id || '';
    const pageQS = activePageId ? `?page_id=${encodeURIComponent(activePageId)}` : '';

    if (editingId) {
        try {
            const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(editingId)}${pageQS}`, {
                method: 'PATCH', body,
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(_dashApiError(err.detail, 'dashboard.card_update_error'));
            }
            await loadDashboard();
            showToast(t('dashboard.card_updated') || 'Card actualizat', 'success');
        } catch (e) {
            showToast(e.message || t('dashboard.card_update_error'), 'error');
        }
        return;
    }

    try {
        const res = await apiCall(`/api/dashboard/widgets${pageQS}`, { method: 'POST', body });
        if (res.ok) {
            await loadDashboard();
            showToast(t('dashboard.card_added') || 'Card adăugat', 'success');
            return;
        }
        if (res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(_dashApiError(err.detail, 'dashboard.save_widget_failed'));
        }
    } catch (e) {
        if (String(e?.message || '').includes(t('dashboard.save_widget_failed'))) {
            showToast(e.message, 'error');
            return;
        }
    }

    // Fallback to local-storage section when the API isn't available.
    try {
        const section = await _readDashboardSectionFallback();
        section.widgets.push({
            id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            ...body,
        });
        await _writeDashboardSectionFallback(section);
        await loadDashboard();
        showToast(t('dashboard.card_added') || 'Card added', 'success');
    } catch (e) {
        showToast(e.message || (t('dashboard.save_error') || 'Save error'), 'error');
    }
}

async function _deleteDashboardWidgetSilent(widgetId) {
    try {
        const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(widgetId)}`, { method: 'DELETE' });
        if (res.ok) {
            await loadDashboard();
            showToast(t('dashboard.widget_deleted') || 'Widget deleted', 'success');
            return;
        }
        if (res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(_dashApiError(err.detail, 'dashboard.delete_widget_failed'));
        }
    } catch (e) {
        if (String(e?.message || '').includes(t('dashboard.delete_widget_failed'))) {
            showToast(e.message, 'error');
            return;
        }
    }
    try {
        const section = await _readDashboardSectionFallback();
        section.widgets = (section.widgets || []).filter(it => it.id !== widgetId);
        await _writeDashboardSectionFallback(section);
        await loadDashboard();
        showToast(t('dashboard.widget_deleted') || 'Widget deleted', 'success');
    } catch (e) {
        showToast(e.message || (t('dashboard.widget_delete_error') || 'Could not delete widget'), 'error');
    }
}

export async function addDashboardSwitch() {
    if (!requireDashboardEditAccess()) return;
    const entityInput = document.getElementById('dashboard-entity-select');
    const title = document.getElementById('dashboard-widget-title');
    const subtitle = document.getElementById('dashboard-widget-subtitle');
    const type = document.getElementById('dashboard-widget-type');
    const size = document.getElementById('dashboard-widget-size');
    const widgetType = type?.value || 'button';
    const widgetRenderer = _dashboardEditorRenderer(widgetType);

    let selected = _resolveEntityMatch(entityInput, widgetType);
    let climateEntityIds = [];
    let climateEntityRecords = [];
    if (widgetType === 'climate') {
        climateEntityRecords = climateEntityRecordsForSave();
        climateEntityIds = climateEntityRecords.map(item => item.entity_id);
        if (!selected && climateEntityIds.length) {
            const firstId = climateEntityIds[0];
            selected = _dashboardAvailableEntity(firstId) || { entity_id: firstId, name: firstId, source: 'integration' };
        }
    }

    if (widgetType !== 'label' && !selected) {
        showToast(t('dashboard.pick_entity'), 'warning');
        return;
    }

    if (widgetType === 'climate' && !climateEntityIds.length) {
        showToast(t('dashboard.pick_climate_multi'), 'warning');
        return;
    }

    const switchStyle = document.getElementById('dashboard-widget-switch-style');
    const showBackground = document.getElementById('dashboard-widget-label-bg');
    const iconInput = document.getElementById('dashboard-widget-icon');
    const colSpanEl = document.getElementById('dashboard-widget-col-span');
    const rowSpanEl = document.getElementById('dashboard-widget-row-span');
    const cameraMode = document.getElementById('dashboard-widget-camera-mode');
    const manualEntityId = `label.${_slug(title?.value || subtitle?.value || 'section')}`;
    const resolvedEntityId = widgetType === 'label' ? manualEntityId : selected.entity_id;
    const body = {
        type: widgetType,
        entity_id: resolvedEntityId,
        entity_name: widgetType === 'label'
            ? (subtitle?.value || '').trim()
            : (widgetType === 'climate'
                ? (selected?.name || resolvedEntityId).trim()
                : (subtitle?.value || selected?.name || resolvedEntityId).trim()),
        title: widgetType === 'climate' ? '' : (title?.value || '').trim(),
        icon: (iconInput?.value || '').trim(),
        source: widgetType === 'label' ? 'manual' : (selected?.source || 'zigbee2mqtt'),
        size: size?.value || 'md',
        favorite: false,
        show_background: widgetType === 'label' ? !!showBackground?.checked : false,
        switch_style: widgetType === 'button' ? !!switchStyle?.checked : false,
    };
    if (widgetType === 'climate') {
        body.entity_id = climateEntityIds[0];
        body.config = { ...(body.config || {}), entities: climateEntityRecords, entity_ids: climateEntityIds };
    }
    if (widgetRenderer === 'camera') {
        const selectedMode = String(cameraMode?.value || 'snapshots').trim() === 'live' ? 'live' : 'snapshots';
        body.config = { ...(body.config || {}), camera_mode: selectedMode };
    }

    const colSpanVal = parseInt(colSpanEl?.value || '0', 10);
    const rowSpanVal = parseInt(rowSpanEl?.value || '0', 10);
    if (Number.isFinite(colSpanVal) && colSpanVal >= 1) body.col_span = Math.min(colSpanVal, SECTION_COLS);
    if (Number.isFinite(rowSpanVal) && rowSpanVal >= 1) body.row_span = Math.min(rowSpanVal, 12);

    // Optional visibility rules from the „Vizibilitate” tab.
    const visibility = _readDashboardVisibilityConfig();
    if (visibility) body.visibility = visibility;

    // Scope add/edit to the active dashboard page so the widget lands on the
    // page the user is currently viewing instead of the default home page.
    const activePageId = _currentPageId || _dashboardCache.current_page_id || _dashboardCache.page_id || '';
    const pageQS = activePageId ? `?page_id=${encodeURIComponent(activePageId)}` : '';

    // EDIT MODE: when openDashboardWidgetEditor() set _dashboardCurrentEditorId,
    // PATCH the existing widget instead of POSTing a new one.
    if (_dashboardCurrentEditorId) {
        const editId = _dashboardCurrentEditorId;
        try {
            const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(editId)}${pageQS}`, {
                method: 'PATCH',
                body,
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(_dashApiError(err.detail, 'dashboard.card_update_error'));
            }
            closeDashboardWidgetEditor();
            await loadDashboard();
            showToast(t('dashboard.card_updated'), 'success');
        } catch (e) {
            showToast(e.message || t('dashboard.card_update_error'), 'error');
        }
        return;
    }

    try {
        const res = await apiCall(`/api/dashboard/widgets${pageQS}`, { method: 'POST', body });
        if (res.ok) {
            closeDashboardAddModal();
            await loadDashboard();
            showToast(body.type === 'label' ? t('dashboard.label_added') : (body.type === 'info' ? t('dashboard.widget_added') : (body.type === 'button' ? t('dashboard.button_added') : t('dashboard.switch_added'))), 'success');
            return;
        }

        if (res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(_dashApiError(err.detail, 'dashboard.save_widget_failed'));
        }
    } catch (e) {
        if (String(e?.message || '').includes(t('dashboard.save_widget_failed'))) {
            showToast(e.message, 'error');
            return;
        }
    }

    try {
        const section = await _readDashboardSectionFallback();
        section.widgets.push({
            id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            ...body,
        });
        await _writeDashboardSectionFallback(section);
        closeDashboardAddModal();
        await loadDashboard();
        showToast(t('dashboard.card_added') || 'Card added', 'success');
    } catch (e) {
        showToast(e.message || (t('dashboard.save_error') || 'Save error'), 'error');
    }
}

export async function removeDashboardWidget(widgetId) {
    if (!requireDashboardEditAccess()) return;
    if (!(await showConfirm(t('dashboard.delete_widget_confirm') || 'Delete this dashboard widget?'))) return;
    try {
        const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(widgetId)}`, { method: 'DELETE' });
        if (res.ok) {
            await loadDashboard();
            showToast(t('dashboard.widget_deleted') || 'Widget deleted', 'success');
            return;
        }
        if (res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || (t('dashboard.widget_delete_error') || 'Could not delete widget'));
        }
    } catch (e) {
        if (String(e?.message || '').includes(t('dashboard.delete_widget_failed'))) {
            showToast(e.message, 'error');
            return;
        }
    }

    try {
        const section = await _readDashboardSectionFallback();
        section.widgets = (section.widgets || []).filter(item => item.id !== widgetId);
        await _writeDashboardSectionFallback(section);
        await loadDashboard();
        showToast(t('dashboard.widget_deleted') || 'Widget deleted', 'success');
    } catch (e) {
        showToast(e.message || (t('dashboard.widget_delete_error') || 'Could not delete widget'), 'error');
    }
}

// Locate a widget across the dashboard cache (top-level + panels).
// Returns { container, index, panel?, panelIndex? } or null.
function _locateDashboardWidget(widgetId) {
    const panels = Array.isArray(_dashboardCache.panels) ? _dashboardCache.panels : [];
    for (let pi = 0; pi < panels.length; pi++) {
        const panel = panels[pi];
        const list = Array.isArray(panel?.widgets) ? panel.widgets : null;
        if (!list) continue;
        const idx = list.findIndex(w => w && w.id === widgetId);
        if (idx >= 0) return { container: list, index: idx, panel, panelIndex: pi };
    }
    const top = Array.isArray(_dashboardCache.widgets) ? _dashboardCache.widgets : null;
    if (top) {
        const idx = top.findIndex(w => w && w.id === widgetId);
        if (idx >= 0) return { container: top, index: idx };
    }
    const pages = Array.isArray(_dashboardCache.pages) ? _dashboardCache.pages : [];
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const page = pages[pageIndex];
        const pageWidgets = Array.isArray(page?.widgets) ? page.widgets : null;
        if (pageWidgets) {
            const idx = pageWidgets.findIndex(w => w && w.id === widgetId);
            if (idx >= 0) return { container: pageWidgets, index: idx, page, pageIndex };
        }
        const pagePanels = Array.isArray(page?.panels) ? page.panels : [];
        for (let panelIndex = 0; panelIndex < pagePanels.length; panelIndex++) {
            const panel = pagePanels[panelIndex];
            const list = Array.isArray(panel?.widgets) ? panel.widgets : null;
            if (!list) continue;
            const idx = list.findIndex(w => w && w.id === widgetId);
            if (idx >= 0) return { container: list, index: idx, page, pageIndex, panel, panelIndex };
        }
    }
    return null;
}

/** Look up a widget object across panels + top-level by id. */
function _findWidget(widgetId) {
    const loc = _locateDashboardWidget(widgetId);
    return loc ? loc.container[loc.index] : null;
}

// Pending reorder state to be persisted after the gesture ends.
let _pendingDashboardReorder = null;

function _reorderDashboardWidgets(sourceId, targetId) {
    if (!sourceId || !targetId || sourceId === targetId) return false;
    const src = _locateDashboardWidget(sourceId);
    const dst = _locateDashboardWidget(targetId);
    if (!src || !dst) return false;

    const moved = src.container[src.index];
    if (!moved) return false;

    // Remove from source, then compute insertion index in destination.
    src.container.splice(src.index, 1);
    let insertAt = dst.container === src.container && src.index < dst.index
        ? dst.index - 1
        : dst.index;
    insertAt = Math.max(0, Math.min(insertAt, dst.container.length));
    dst.container.splice(insertAt, 0, moved);

    // If we crossed panels and the destination panel has multi-page tabs,
    // inherit the target widget's page_id.
    if (dst.panel && Array.isArray(dst.panel.pages) && dst.panel.pages.length) {
        const targetWidget = dst.container[insertAt + 1] || null; // the widget that was at targetId before
        const fallbackPage = (dst.panel.pages[0] && dst.panel.pages[0].id) || null;
        if (targetWidget && targetWidget.page_id) moved.page_id = targetWidget.page_id;
        else if (!moved.page_id) moved.page_id = fallbackPage;
    }

    // The widget AFTER moved (in destination) is the "before_widget_id" anchor.
    const afterIdx = insertAt + 1;
    const beforeWidgetId = afterIdx < dst.container.length
        ? (dst.container[afterIdx] && dst.container[afterIdx].id) || null
        : null;

    _pendingDashboardReorder = {
        sourceId,
        targetPanelId: dst.panel ? dst.panel.id : null,
        targetPageId: moved.page_id || null,
        beforeWidgetId,
    };

    _renderDashboard();
    return true;
}

async function _persistDashboardOrder() {
    const pending = _pendingDashboardReorder;
    _pendingDashboardReorder = null;
    if (!pending) return;

    // Multi-panel layout: use the relocate endpoint (handles cross-panel + ordering).
    if (pending.targetPanelId) {
        const body = { target_panel_id: pending.targetPanelId };
        if (pending.targetPageId) body.target_page_id = pending.targetPageId;
        if (pending.beforeWidgetId) body.before_widget_id = pending.beforeWidgetId;
        const url = _currentPageId
            ? `/api/dashboard/widgets/${encodeURIComponent(pending.sourceId)}/relocate?page_id=${encodeURIComponent(_currentPageId)}`
            : `/api/dashboard/widgets/${encodeURIComponent(pending.sourceId)}/relocate`;
        const res = await apiCall(url, { method: 'POST', body });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(_dashApiError(err.detail, 'dashboard.rearrange_widget_failed'));
        }
        return;
    }

    // Legacy single-list fallback (no panels).
    const section = await _readDashboardSectionFallback();
    const storedWidgets = Array.isArray(section.widgets) ? section.widgets : [];
    const orderedIds = (_dashboardCache.widgets || []).map(item => item.id);
    section.widgets = orderedIds.map(id => storedWidgets.find(item => item.id === id)).filter(Boolean);
    await _writeDashboardSectionFallback(section);
}


export function handleDashboardCardClick(event, widgetId) {
    dashDebug('card.click', { widgetId, target: event?.target?.tagName, type: event?.type });
    if (widgetId === '__preview__') {
        _toggleDashboardPreviewCard(event);
        return;
    }
    if (_dashboardEditMode) { dashDebug('card.skip', 'editMode'); return; }
    const nested = _dashboardNestedInteractiveTarget(event);
    if (nested) { dashDebug('card.skip', { reason: 'nested', el: nested.tagName, role: nested.getAttribute?.('role') }); return; }
    if (_dashboardControlPending(widgetId)) { dashDebug('card.skip', 'pending'); return; }
    toggleDashboardWidget(widgetId);
}

function _dashboardNestedInteractiveTarget(event) {
    const target = event?.target;
    if (!target?.closest) return null;
    const interactive = target.closest('button, a, input, select, textarea, label, [role="button"]');
    if (!interactive) return null;
    const current = event?.currentTarget;
    if (current && interactive === current) return null;
    return interactive;
}

function _toggleDashboardPreviewCard(event) {
    if (_dashboardNestedInteractiveTarget(event)) return;
    const card = event?.currentTarget || event?.target?.closest?.('.hyve-dashboard-card');
    if (!card) return;
    const nextOn = card.getAttribute('data-on') !== 'true';
    card.setAttribute('data-on', nextOn ? 'true' : 'false');
    card.setAttribute('data-preview-pressed', 'true');
    const toggle = card.querySelector('.app-toggle-switch');
    if (toggle) toggle.setAttribute('data-on', nextOn ? 'true' : 'false');
    window.setTimeout(() => card.removeAttribute('data-preview-pressed'), 180);
}

export function handleDashboardCardKeydown(event, widgetId) {
    if (event?.key !== 'Enter' && event?.key !== ' ') return;
    event.preventDefault();
    handleDashboardCardClick(event, widgetId);
}

export async function toggleDashboardWidget(widgetId, btn) {
    const widget = _findWidget(widgetId);
    if (!widget) {
        const topIds = (Array.isArray(_dashboardCache.widgets) ? _dashboardCache.widgets : []).map(w => w?.id).slice(0, 8);
        const panelInfo = (Array.isArray(_dashboardCache.panels) ? _dashboardCache.panels : []).map(p => ({ id: p?.id, n: (p?.widgets || []).length, ids: (p?.widgets || []).map(w => w?.id).slice(0, 4) }));
        const pageInfo = (Array.isArray(_dashboardCache.pages) ? _dashboardCache.pages : []).map(p => ({ id: p?.id, panels: Array.isArray(p?.panels) ? p.panels.length : 0, widgets: Array.isArray(p?.widgets) ? p.widgets.length : 0 }));
        dashDebug('toggle.skip', { widgetId, reason: 'widget-not-found', currentPage: _currentPageId, cachePage: _dashboardCache.page_id, topCount: topIds.length, topIds, panels: panelInfo, pages: pageInfo });
        return;
    }
    if (_dashboardControlPending(widgetId)) { dashDebug('toggle.skip', { widgetId, reason: 'pending' }); return; }
    dashDebug('toggle.start', { widgetId, entity: widget.entity_id, current: widget.current_state });

    const snapshot = _snapshotDashboardEntityState(widget.entity_id);
    const current = String(widget.current_state || '').toLowerCase();
    const nextState = _stateOn(current) ? 'off' : 'on';
    const action = _dashboardIntentAction(widget, nextState);
    _dashboardPendingControls.set(String(widgetId), {
        widgetId: String(widgetId),
        entityId: String(widget.entity_id || ''),
        nextState,
        action,
        startedAt: Date.now(),
    });
    _patchDashboardEntityState(widget.entity_id, nextState);
    if (!_tryFastPathForEntities([widget.entity_id])) _renderDashboard();
    setTimeout(() => {
        const pending = _dashboardPendingControls.get(String(widgetId));
        if (pending && pending.nextState === nextState) {
            if (!_tryFastPathForEntities([widget.entity_id])) _renderDashboard();
        }
    }, DASHBOARD_PENDING_VISUAL_MS + 40);

    if (btn) btn.disabled = true;
    try {
        const activePageId = _currentPageId || _dashboardCache.page_id || _dashboardCache.current_page_id || '';
        const pageQS = activePageId ? `?page_id=${encodeURIComponent(activePageId)}` : '';
        const url = `/api/dashboard/widgets/${encodeURIComponent(widgetId)}/toggle${pageQS}`;
        dashDebug('toggle.req', { url, next: nextState, action });
        const res = await apiCall(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ desired_state: nextState, action: action || 'toggle' }),
        });
        dashDebug('toggle.res', { status: res.status });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(_dashApiError(err.detail, 'dashboard.toggle_failed'));
        }
        _dashboardPendingControls.delete(String(widgetId));
        _dashboardOptimisticGuards.set(String(widget.entity_id || ''), {
            state: nextState,
            until: Date.now() + DASHBOARD_OPTIMISTIC_GUARD_MS,
        });
        if (!_tryFastPathForEntities([widget.entity_id])) _renderDashboard();
    } catch (e) {
        dashDebug('toggle.err', { widgetId, msg: String(e?.message || e) });
        _dashboardPendingControls.delete(String(widgetId));
        _dashboardOptimisticGuards.delete(String(widget.entity_id || ''));
        _restoreDashboardEntitySnapshot(snapshot);
        if (!_tryFastPathForEntities([widget.entity_id])) _renderDashboard();
        showToast(e.message || t('dashboard.toggle_failed'), 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}


function _snapshotDashboardEntityState(entityId) {
    const target = String(entityId || '');
    const snapshot = [];
    if (!target) return snapshot;
    const seen = new Set();
    const remember = (item) => {
        if (!item || item.entity_id !== target || seen.has(item)) return;
        seen.add(item);
        snapshot.push({ item, state: item.current_state, attributes: item.attributes, available: item.available });
    };
    const rememberWidget = (widget) => {
        remember(widget);
        if (Array.isArray(widget?.entities)) widget.entities.forEach(remember);
    };
    (_dashboardCache.widgets || []).forEach(rememberWidget);
    (_dashboardCache.panels || []).forEach(panel => (panel?.widgets || []).forEach(rememberWidget));
    (_dashboardCache.pages || []).forEach(page => {
        (page?.widgets || []).forEach(rememberWidget);
        (page?.panels || []).forEach(panel => (panel?.widgets || []).forEach(rememberWidget));
    });
    (_dashboardCache.available_entities || []).forEach(item => {
        if (item?.entity_id === target && !seen.has(item)) {
            seen.add(item);
            snapshot.push({ item, state: item.state, attributes: item.attributes, available: item.available, availableEntity: true });
        }
    });
    return snapshot;
}

function _restoreDashboardEntitySnapshot(snapshot) {
    (snapshot || []).forEach(entry => {
        if (!entry?.item) return;
        if (entry.availableEntity) {
            entry.item.state = entry.state;
        } else {
            entry.item.current_state = entry.state;
        }
        entry.item.attributes = entry.attributes;
        entry.item.available = entry.available;
    });
}

function _patchDashboardEntityState(entityId, state, attributesPatch = null) {
    const target = String(entityId || '');
    if (!target) return;
    const patchWidget = (widget) => {
        if (!widget) return;
        if (widget.entity_id === target) {
            widget.current_state = state;
            if (attributesPatch) widget.attributes = { ...(widget.attributes || {}), ...attributesPatch };
        }
        if (Array.isArray(widget.entities)) {
            widget.entities.forEach(item => {
                if (item?.entity_id !== target) return;
                item.current_state = state;
                if (attributesPatch) item.attributes = { ...(item.attributes || {}), ...attributesPatch };
            });
        }
    };
    (_dashboardCache.widgets || []).forEach(patchWidget);
    (_dashboardCache.panels || []).forEach(panel => (panel?.widgets || []).forEach(patchWidget));
    (_dashboardCache.pages || []).forEach(page => {
        (page?.widgets || []).forEach(patchWidget);
        (page?.panels || []).forEach(panel => (panel?.widgets || []).forEach(patchWidget));
    });
    (_dashboardCache.available_entities || []).forEach(item => {
        if (item?.entity_id !== target) return;
        item.state = state;
        if (attributesPatch) item.attributes = { ...(item.attributes || {}), ...attributesPatch };
    });
}

export function openDashboardPageModal(opts = {}) {
    if (!requireDashboardEditAccess()) return;
    closeDashboardMenu();
    syncModalViewportMetrics();
    const modal = document.getElementById('dashboard-page-modal');
    if (!modal) return;
    const createMode = !!(opts && opts.create);
    _pageEditorMode = createMode ? 'create' : 'edit';

    const titleInput = document.getElementById('dashboard-page-title-input');
    const iconInput = document.getElementById('dashboard-page-icon-input');
    const columnsInput = document.getElementById('dashboard-page-columns');
    const layoutInput = document.getElementById('dashboard-page-layout-mode');
    const hideInput = document.getElementById('dashboard-page-hide-unavailable');
    const titleEl = document.getElementById('dashboard-page-modal-title');
    const saveBtn = document.getElementById('dashboard-page-save-btn');
    const defaultInput = document.getElementById('dashboard-page-default-input');

    if (createMode) {
        if (titleEl) titleEl.textContent = t('dashboard.new_page') || 'New page';
        if (saveBtn) saveBtn.textContent = t('dashboard.create') || 'Create';
        if (titleInput) titleInput.value = '';
        if (iconInput) iconInput.value = 'fa-table-cells-large';
        if (columnsInput) columnsInput.value = '0';
        if (layoutInput) layoutInput.value = DEFAULT_PREFS.layout_mode;
        if (hideInput) hideInput.checked = false;
    } else {        if (titleEl) titleEl.textContent = t('dashboard.edit_page') || 'Edit page';
        if (saveBtn) saveBtn.textContent = t('common.save') || 'Save';
        if (titleInput) titleInput.value = _dashboardCache.title || DEFAULT_META.title;
        if (iconInput) iconInput.value = _dashboardCache.icon || 'fa-table-cells-large';
        if (columnsInput) columnsInput.value = String(_dashboardCache.columns || 0);
        if (layoutInput) layoutInput.value = _dashboardCache.preferences?.layout_mode || DEFAULT_PREFS.layout_mode;
        if (hideInput) hideInput.checked = !(_dashboardCache.preferences?.show_unavailable ?? DEFAULT_PREFS.show_unavailable);
    }

    // Show delete button only in edit mode and when there are >= 2 pages.
    const delBtn = document.getElementById('dashboard-page-delete-btn');
    if (delBtn) {
        const pages = Array.isArray(_dashboardCache.pages) ? _dashboardCache.pages : [];
        const canDelete = !createMode && pages.length >= 2 && !!_currentPageId;
        delBtn.classList.toggle('hidden', !canDelete);
    }

    // Per-user default dashboard toggle (HA default_panel). Only meaningful for
    // an existing page; hidden while creating a brand new one.
    if (defaultInput) {
        const row = defaultInput.closest('label');
        if (row) row.classList.toggle('hidden', createMode);
        const activeId = _currentPageId || _dashboardCache.current_page_id || _dashboardCache.page_id;
        defaultInput.checked = !createMode && !!_dashboardCache.default_page_id
            && String(_dashboardCache.default_page_id) === String(activeId);
    }

    _enhanceDashboardCustomSelects(modal);

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (titleInput) try { titleInput.focus(); } catch (_) {}
}

export function closeDashboardPageModal() {
    const modal = document.getElementById('dashboard-page-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

export async function saveDashboardHeader() {
    if (!requireDashboardEditAccess()) return;
    const titleInput = document.getElementById('dashboard-page-title-input') || document.getElementById('dashboard-title-input');
    const iconInput = document.getElementById('dashboard-page-icon-input');
    const columnsInput = document.getElementById('dashboard-page-columns');
    const layoutInput = document.getElementById('dashboard-page-layout-mode');
    const hideInput = document.getElementById('dashboard-page-hide-unavailable');

    const newTitle = (titleInput?.value || DEFAULT_META.title).trim() || DEFAULT_META.title;
    const newIcon = (iconInput?.value || _dashboardCache.icon || 'fa-table-cells-large').trim();
    const newColumns = Number(columnsInput?.value || 0) || 0;

    _dashboardCache.title = newTitle;
    _dashboardCache.icon = newIcon;
    _dashboardCache.columns = newColumns;
    _dashboardCache.preferences = {
        ...DEFAULT_PREFS,
        ...(_dashboardCache.preferences || {}),
        layout_mode: layoutInput?.value || _dashboardCache.preferences?.layout_mode || DEFAULT_PREFS.layout_mode,
        show_unavailable: !(hideInput?.checked),
    };

    const pageId = _currentPageId || _dashboardCache.current_page_id || _dashboardCache.page_id;

    // Create mode: POST a brand new page, then select it.
    if (_pageEditorMode === 'create') {
        const typedTitle = (titleInput?.value || '').trim();
        if (!typedTitle) {
            showToast(t('dashboard.title_required') || 'Pagina trebuie să aibă un titlu.', 'warning');
            try { titleInput?.focus(); } catch (_) {}
            return;
        }
        try {
            const res = await apiCall('/api/dashboard/pages', {
                method: 'POST',
                body: {
                    title: typedTitle,
                    icon: newIcon,
                    columns: newColumns,
                },
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(_dashApiError(err.detail, 'dashboard.page_create_error'));
            }
            const data = await res.json().catch(() => ({}));
            const newId = data?.page?.id || data?.current_page_id;
            _pageEditorMode = 'edit';
            closeDashboardPageModal();
            if (newId) {
                // loadDashboard() used to run while _currentPageId still pointed at
                // the previous page (often "Acasă"). Its in-flight fetch could
                // finish after selectDashboardPage() and overwrite the new title.
                try { _loadDashboardAbortController?.abort?.(); } catch (_) {}
                _loadDashboardInFlight = null;
                _mergeCreatedPageIntoCache(data?.page, newId);
                _syncPreferenceControls();
                _renderDashboardPagesList();
                await selectDashboardPage(newId);
            } else {
                await loadDashboard();
            }
            showToast(t('dashboard.page_created'), 'success');
        } catch (e) {
            showToast(e.message || t('dashboard.page_create_error'), 'error');
        }
        return;
    }

    try {
        // 1) Salvează metadatele paginii (titlu/subtitlu/icon/coloane) pe pagina curentă.
        let renamedToId = null;
        if (pageId) {
            const pageRes = await apiCall(`/api/dashboard/pages/${encodeURIComponent(pageId)}`, {
                method: 'PATCH',
                body: {
                    title: newTitle,
                    icon: newIcon,
                    columns: newColumns,
                },
            });
            if (!pageRes.ok && pageRes.status !== 404) {
                const err = await pageRes.json().catch(() => ({}));
                throw new Error(_dashApiError(err.detail, 'dashboard.save_page_failed'));
            }
            // The server may have renamed the page id to match the new title
            // slug (e.g. "Acasă" → "acasa"). Pick up the new id so URLs/refs
            // follow along without breaking navigation.
            const pageData = pageRes.ok ? await pageRes.json().catch(() => ({})) : {};
            const newId = pageData?.page?.id;
            if (newId && newId !== pageId) {
                renamedToId = newId;
            }
        }

        // 2) Salvează preferences (layout / show_unavailable).
        await apiCall('/api/dashboard/preferences', {
            method: 'PATCH',
            body: {
                ...DEFAULT_PREFS,
                ...(_dashboardCache.preferences || {}),
                title: newTitle,
                icon: newIcon,
            },
        }).catch(() => null);

        // 3) Per-user default dashboard page (HA default_panel).
        const defaultInput = document.getElementById('dashboard-page-default-input');
        if (defaultInput) {
            const wantDefault = !!defaultInput.checked;
            const effectiveId = renamedToId || pageId;
            const isDefault = String(_dashboardCache.default_page_id || '') === String(effectiveId);
            if (wantDefault !== isDefault) {
                await apiCall('/api/dashboard/preferences/default-page', {
                    method: 'PATCH',
                    body: { page_id: wantDefault ? effectiveId : null },
                }).catch(() => null);
            }
        }

        closeDashboardPageModal();
        if (renamedToId) {
            _currentPageId = renamedToId;
            await loadDashboard();
            await selectDashboardPage(renamedToId);
        } else {
            await loadDashboard();
        }
        showToast(t('dashboard.page_settings_saved') || 'Page settings saved', 'success');
    } catch (e) {
        showToast(e.message || (t('dashboard.page_save_error') || 'Could not save page'), 'error');
    }
}

export async function deleteDashboardPage() {
    if (!requireDashboardEditAccess()) return;
    const pageId = _currentPageId || _dashboardCache.current_page_id || _dashboardCache.page_id;
    if (!pageId) return;
    const pages = Array.isArray(_dashboardCache.pages) ? _dashboardCache.pages : [];
    if (pages.length <= 1) {
        showToast(t('dashboard.min_one_page') || 'At least one dashboard page must remain.', 'warning');
        return;
    }
    if (!(await showConfirm(t('dashboard.delete_page_confirm') || 'Delete the current page? Its cards and panels will be removed.'))) return;
    try {
        const res = await apiCall(`/api/dashboard/pages/${encodeURIComponent(pageId)}`, { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || (t('dashboard.page_delete_error') || 'Could not delete page'));
        }
        const data = await res.json().catch(() => ({}));
        const nextId = data.current_page_id || (pages.find(p => p.id !== pageId)?.id) || null;
        closeDashboardPageModal();
        if (nextId) {
            await selectDashboardPage(nextId);
        } else {
            await loadDashboard();
        }
        showToast(t('dashboard.page_deleted') || 'Page deleted', 'success');
    } catch (e) {
        showToast(e.message || (t('dashboard.page_delete_error') || 'Could not delete page'), 'error');
    }
}

function _buildWidgetYaml(widget = {}) {
    const yamlString = (value) => `"${String(value ?? '').replace(/"/g, '\\"')}"`;
    return [
        `type: ${widget.type || 'button'}`,
        `title: ${yamlString(widget.title || '')}`,
        `entity_id: ${yamlString(widget.entity_id || '')}`,
        `entity_name: ${yamlString(widget.entity_name || '')}`,
        `size: ${widget.size || 'md'}`,
        `source: ${yamlString(widget.source || 'zigbee2mqtt')}`,
        `icon: ${yamlString(widget.icon || '')}`,
        `favorite: ${widget.favorite ? 'true' : 'false'}`,
        `show_background: ${widget.show_background ? 'true' : 'false'}`,
        `switch_style: ${widget.switch_style ? 'true' : 'false'}`,
    ].join('\n');
}

function _parseWidgetYaml(raw, fallback = {}) {
    const patch = { ...fallback };
    String(raw || '').split(/\r?\n/).forEach(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
        if (!match) return;
        const [, key, valueRaw] = match;
        let value = valueRaw.trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key === 'favorite' || key === 'show_background' || key === 'switch_style') {
            patch[key] = value.toLowerCase() === 'true';
        } else {
            patch[key] = value;
        }
    });
    return patch;
}

function _normalizeLocalWidgetPatch(widget, patch) {
    const updated = { ...(widget || {}), ...(patch || {}) };
    updated.type = ['switch', 'info', 'button', 'label', 'climate', 'camera', 'picture', 'weather', 'weather_rich', 'gauge', 'fusion_solar'].includes(updated.type) ? updated.type : 'button';
    updated.size = ['sm', 'md', 'wide'].includes(updated.size) ? updated.size : 'md';
    const noDefaultTitleTypes = new Set(['weather', 'weather_rich', 'fusion_solar']);
    updated.title = Object.prototype.hasOwnProperty.call(updated, 'title')
        ? String(updated.title ?? '').trim()
        : (noDefaultTitleTypes.has(updated.type)
            ? ''
            : String(updated.entity_name || updated.entity_id || 'Card').trim());
    updated.entity_name = updated.type === 'label'
        ? String(updated.entity_name || '').trim()
        : String(updated.entity_name || updated.title || updated.entity_id || '').trim();
    updated.entity_id = String(updated.entity_id || `label.${_slug(updated.title || updated.entity_name || 'section')}`).trim();
    updated.source = String(updated.source || 'zigbee2mqtt').trim();
    updated.icon = String(updated.icon || '').trim();
    updated.favorite = Boolean(updated.favorite);
    updated.show_background = Boolean(updated.show_background);
    updated.switch_style = Boolean(updated.switch_style || updated.type === 'switch');
    return updated;
}

// R5.2: the legacy add modal was hijacked for both add and edit. The
// schema-driven editor now owns both flows; this function simply maps the
// widget into the editor card shape and dispatches the result.
export async function openDashboardWidgetEditor(widgetId) {
    if (!requireDashboardEditAccess()) return;
    const widget = _findWidget(widgetId);
    if (!widget) {
        showToast(t('dashboard.card_not_found') || 'Card not found', 'error');
        return;
    }
    await _ensureHyveviewEntitySeed();
    const card = _widgetToEditorCard(widget);
    const result = await hvOpenEditor({ mode: 'edit', card });
    if (!result) return;
    if (result.__deleted) {
        await _deleteDashboardWidgetSilent(widgetId);
        return;
    }
    await _saveDashboardWidgetFromEditor(result, { editingId: widgetId, original: widget });
}

export function closeDashboardWidgetEditor() {
    // Legacy closer — schema editor closes itself.
}

// ── Add-modal: live preview + visibility editor ──────────────────────
export function _renderDashboardAddPreview() {
    const target = document.getElementById('dashboard-add-preview-card');
    if (!target) return;
    const type = (document.getElementById('dashboard-widget-type')?.value || 'button').trim();
    const title = (document.getElementById('dashboard-widget-title')?.value || '').trim();
    const subtitle = (document.getElementById('dashboard-widget-subtitle')?.value || '').trim();
    const size = document.getElementById('dashboard-widget-size')?.value || 'md';
    const colSpanPv = parseInt(document.getElementById('dashboard-widget-col-span')?.value || '0', 10);
    const rowSpanPv = parseInt(document.getElementById('dashboard-widget-row-span')?.value || '0', 10);
    const showBackground = !!document.getElementById('dashboard-widget-label-bg')?.checked;
    const switchStyle = !!document.getElementById('dashboard-widget-switch-style')?.checked;
    const cameraMode = String(document.getElementById('dashboard-widget-camera-mode')?.value || 'snapshots') === 'live' ? 'live' : 'snapshots';
    const icon = (document.getElementById('dashboard-widget-icon')?.value || '').trim();
    const entityInput = document.getElementById('dashboard-entity-select');
    const climateEntityRecords = type === 'climate' ? climateEntityRecordsForSave() : [];
    const climateEntityIds = climateEntityRecords.map(item => item.entity_id);
    const eid = type === 'climate' ? (climateEntityIds[0] || entityInput?.dataset?.currentValue || '') : (entityInput?.dataset?.currentValue || '');

    let entityState = '—';
    let entityAttrs = {};
    let entityUnit = '';
    let domain = '';
    if (eid && Array.isArray(_dashboardCache.available_entities)) {
        const ent = _dashboardCache.available_entities.find(x => x.entity_id === eid);
        if (ent) {
            entityState = ent.state != null ? String(ent.state) : '—';
            entityAttrs = ent.attributes || {};
            entityUnit = ent.unit || '';
            domain = String(eid).split('.')[0] || '';
        }
    }

    const widget = {
        id: '__preview__',
        type: type === 'label' ? 'label' : type,
        renderer: '',
        title: title || (type === 'label' ? (t('dashboard.preview_title_default') || 'Title') : (eid || (t('dashboard.preview_default') || 'Preview'))),
        entity_name: subtitle,
        entity_id: type === 'label' ? `label.preview` : (eid || 'preview.placeholder'),
        size,
        icon,
        domain,
        unit: entityUnit,
        current_state: entityState,
        attributes: entityAttrs,
        available: true,
        controllable: true,
        show_background: showBackground,
        switch_style: switchStyle,
    };
    if (type === 'climate' && climateEntityIds.length) {
        widget.config = { entities: climateEntityRecords, entity_ids: climateEntityIds };
        widget.entities = climateEntityRecords.map(record => {
            const entityId = record.entity_id;
            const ent = _dashboardAvailableEntity(entityId) || {};
            return {
                entity_id: entityId,
                title: record.title,
                subtitle: record.subtitle,
                entity_name: ent.name || ent.entity_name || entityId,
                current_state: ent.state ?? ent.current_state ?? 'unknown',
                attributes: ent.attributes || {},
                unit: ent.unit || '',
                available: ent.available !== false,
                controllable: ent.controllable !== false,
            };
        });
    }
    if (type === 'camera') {
        widget.config = { ...(widget.config || {}), camera_mode: cameraMode };
    }
    if (Number.isFinite(colSpanPv) && colSpanPv >= 1) widget.col_span = Math.min(colSpanPv, SECTION_COLS);
    if (Number.isFinite(rowSpanPv) && rowSpanPv >= 1) widget.row_span = Math.min(rowSpanPv, 12);

    if (!eid && type !== 'label') {
        target.innerHTML = `<div class="text-center text-xs text-slate-500"><i class="fas fa-eye-slash mb-2 block text-lg text-slate-600"></i>${_escape(t('dashboard.select_entity_for_preview') || 'Choose an entity for preview')}</div>`;
        return;
    }

    try {
        const html = _renderWidgetCardForPreview(widget);
        // Wrap so the card can render with its grid expectations.
        target.innerHTML = `<div class="grid grid-cols-1 gap-3 w-full">${html}</div>`;
    } catch (e) {
        target.innerHTML = `<div class="text-xs text-red-400">${_escape(t('dashboard.preview_unavailable', { message: e?.message || t('common.error') }))}</div>`;
    }
}

let _dashboardAddModalWired = false;
function _wireDashboardAddPreviewListeners() {
    if (_dashboardAddModalWired) return;
    const modal = document.getElementById('dashboard-add-modal');
    if (!modal) return;
    _dashboardAddModalWired = true;
    const ids = [
        'dashboard-widget-type', 'dashboard-widget-title', 'dashboard-widget-subtitle',
        'dashboard-widget-size', 'dashboard-widget-col-span', 'dashboard-widget-row-span',
        'dashboard-widget-icon', 'dashboard-widget-color',
        'dashboard-widget-label-bg', 'dashboard-widget-switch-style', 'dashboard-widget-camera-mode', 'dashboard-entity-select',
    ];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        const evt = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'color') ? 'change' : 'input';
        el.addEventListener(evt, () => _renderDashboardAddPreview());
    }
}

export function setDashboardAddEditorMode(mode = 'visual') {
    const validModes = ['visual', 'visibility', 'size'];
    const active = validModes.includes(mode) ? mode : 'visual';

    const sections = {
        visual:     document.getElementById('dashboard-add-editor-visual'),
        visibility: document.getElementById('dashboard-add-editor-visibility-wrap'),
        size:       document.getElementById('dashboard-add-editor-size-wrap'),
    };
    const tabs = {
        visual:     document.getElementById('dashboard-add-editor-visual-tab'),
        visibility: document.getElementById('dashboard-add-editor-visibility-tab'),
        size:       document.getElementById('dashboard-add-editor-size-tab'),
    };

    for (const key of validModes) {
        if (sections[key]) sections[key].classList.toggle('hidden', key !== active);
        if (tabs[key]) {
            const isActive = key === active;
            tabs[key].classList.toggle('bg-white/10', isActive);
            tabs[key].classList.toggle('text-slate-300', isActive);
            tabs[key].classList.toggle('text-slate-400', !isActive);
        }
    }

    if (active === 'visibility') {
        // Ensure at least one condition row exists when first opened.
        const conds = document.getElementById('dashboard-visibility-conditions');
        if (conds && !conds.children.length) addDashboardVisibilityCondition('add');
    } else if (active === 'size') {
        // Sync sliders ↔ hidden selects, render mini-grid preview, wire listeners once.
        _syncDashboardSizeSlidersFromSelects();
        _wireDashboardSizeSliders();
        _renderDashboardSizeGridPreview();
    }
}

/**
 * Sync the size sliders (range inputs) and value labels from the hidden
 * `<select>`s that hold the canonical col_span / row_span values.
 */
function _syncDashboardSizeSlidersFromSelects() {
    const colSel = document.getElementById('dashboard-widget-col-span');
    const rowSel = document.getElementById('dashboard-widget-row-span');
    const colSlider = document.getElementById('dashboard-size-col-slider');
    const rowSlider = document.getElementById('dashboard-size-row-slider');
    const colVal = document.getElementById('dashboard-size-col-value');
    const rowVal = document.getElementById('dashboard-size-row-value');
    const col = Math.min(Math.max(parseInt(colSel?.value || String(DASHBOARD_COL_POINTS_MAX), 10) || DASHBOARD_COL_POINTS_MAX, DASHBOARD_COL_POINTS_MIN), DASHBOARD_COL_POINTS_MAX);
    const row = Math.min(Math.max(parseInt(rowSel?.value || '1', 10) || 1, 1), 8);
    if (colSlider) colSlider.value = String(col);
    if (rowSlider) rowSlider.value = String(row);
    if (colVal) colVal.textContent = String(col);
    if (rowVal) rowVal.textContent = String(row);
}

let _dashboardSizeSlidersWired = false;
function _wireDashboardSizeSliders() {
    if (_dashboardSizeSlidersWired) return;
    const colSlider = document.getElementById('dashboard-size-col-slider');
    const rowSlider = document.getElementById('dashboard-size-row-slider');
    const colSel = document.getElementById('dashboard-widget-col-span');
    const rowSel = document.getElementById('dashboard-widget-row-span');
    const colVal = document.getElementById('dashboard-size-col-value');
    const rowVal = document.getElementById('dashboard-size-row-value');
    if (!colSlider || !rowSlider) return;
    _dashboardSizeSlidersWired = true;

    const onCol = () => {
        const v = colSlider.value;
        if (colVal) colVal.textContent = v;
        if (colSel) { colSel.value = v; colSel.dispatchEvent(new Event('change')); }
        _renderDashboardSizeGridPreview();
        _renderDashboardAddPreview();
    };
    const onRow = () => {
        const v = rowSlider.value;
        if (rowVal) rowVal.textContent = v;
        if (rowSel) { rowSel.value = v; rowSel.dispatchEvent(new Event('change')); }
        _renderDashboardSizeGridPreview();
        _renderDashboardAddPreview();
    };
    colSlider.addEventListener('input', onCol);
    rowSlider.addEventListener('input', onRow);
}

/**
 * Render a 4×N visualization showing which cells the card will occupy.
 * Pure visual aid for the user — no semantic meaning beyond highlighting.
 */
function _renderDashboardSizeGridPreview() {
    const target = document.getElementById('dashboard-size-grid-preview');
    if (!target) return;
    const col = Math.min(Math.max(parseInt(document.getElementById('dashboard-size-col-slider')?.value || String(DASHBOARD_COL_POINTS_MAX), 10) || DASHBOARD_COL_POINTS_MAX, DASHBOARD_COL_POINTS_MIN), DASHBOARD_COL_POINTS_MAX);
    const row = Math.min(Math.max(parseInt(document.getElementById('dashboard-size-row-slider')?.value || '1', 10) || 1, 1), 8);
    // Show a 4 × min(row+1, 8) preview so tall cards still fit visually.
    const visibleRows = Math.max(4, Math.min(row + 1, 8));
    target.style.gridTemplateRows = `repeat(${visibleRows}, 22px)`;
    const cells = [];
    for (let r = 1; r <= visibleRows; r++) {
        for (let c = 1; c <= DASHBOARD_COL_POINTS_MAX; c++) {
            const active = (c <= col && r <= row) ? 'true' : 'false';
            cells.push(`<div class="dashboard-size-grid-preview__cell" data-active="${active}"></div>`);
        }
    }
    target.innerHTML = cells.join('');
}

export function toggleDashboardVisibilityEditor(scope = 'add') {
    const enabledEl = document.getElementById('dashboard-visibility-enabled');
    const body = document.getElementById('dashboard-visibility-body');
    if (!enabledEl || !body) return;
    body.classList.toggle('hidden', !enabledEl.checked);
    if (enabledEl.checked) {
        const conds = document.getElementById('dashboard-visibility-conditions');
        if (conds && !conds.children.length) addDashboardVisibilityCondition(scope);
    }
}

let _visibilityCondSeq = 0;
export function addDashboardVisibilityCondition(_scope = 'add') {
    const wrap = document.getElementById('dashboard-visibility-conditions');
    if (!wrap) return;
    const idx = ++_visibilityCondSeq;
    const items = Array.isArray(_dashboardCache.available_entities) ? _dashboardCache.available_entities : [];
    // Build a compact <datalist>-backed entity input so users can pick by name.
    const listId = `vis-cond-entities-${idx}`;
    const opts = items.slice(0, 200).map(it => `<option value="${_escape(it.entity_id)}">${_escape(it.name || it.entity_id)}</option>`).join('');
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-2';
    row.dataset.condIndex = String(idx);
    row.innerHTML = `
        <input type="text" list="${listId}" data-vis-field="entity" placeholder="entity_id"
               class="flex-1 min-w-0 rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50" />
        <datalist id="${listId}">${opts}</datalist>
        <select data-vis-field="op" class="rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50">
            <option value="eq">=</option>
            <option value="ne">≠</option>
            <option value="gt">&gt;</option>
            <option value="lt">&lt;</option>
            <option value="in">∈</option>
        </select>
        <input type="text" data-vis-field="value" placeholder="valoare"
               class="w-24 rounded-lg bg-slate-950/60 border border-white/10 px-2 py-1.5 text-xs text-slate-100 outline-none focus:border-accent/50" />
        <button type="button" class="text-slate-500 hover:text-red-400 text-xs px-1" aria-label="Șterge condiție">
            <i class="fas fa-xmark"></i>
        </button>`;
    row.querySelector('button').addEventListener('click', () => row.remove());
    wrap.appendChild(row);
    _enhanceDashboardCustomSelects(row);
}

export function _readDashboardVisibilityConfig() {
    const enabledEl = document.getElementById('dashboard-visibility-enabled');
    if (!enabledEl?.checked) return null;
    const logic = document.getElementById('dashboard-visibility-logic')?.value || 'and';
    const wrap = document.getElementById('dashboard-visibility-conditions');
    const conditions = [];
    if (wrap) {
        for (const row of wrap.querySelectorAll('[data-cond-index]')) {
            const ent = row.querySelector('[data-vis-field="entity"]')?.value?.trim();
            const op = row.querySelector('[data-vis-field="op"]')?.value || 'eq';
            const value = row.querySelector('[data-vis-field="value"]')?.value ?? '';
            if (ent) conditions.push({ entity_id: ent, op, value: String(value) });
        }
    }
    return { enabled: true, logic, conditions };
}

/**
 * Pre-fill the visibility tab from a widget object loaded for editing.
 * Reads `widget.visibility` (the normalized form persisted by the backend)
 * and rebuilds the rows + logic select. Safely no-ops when the widget has
 * no rules.
 */
function _populateDashboardVisibilityFromWidget(widget) {
    const enabledEl = document.getElementById('dashboard-visibility-enabled');
    const body = document.getElementById('dashboard-visibility-body');
    const logicEl = document.getElementById('dashboard-visibility-logic');
    const wrap = document.getElementById('dashboard-visibility-conditions');
    if (!enabledEl || !wrap) return;

    const cfg = widget?.visibility || null;
    const conditions = Array.isArray(cfg?.conditions) ? cfg.conditions : [];
    const enabled = !!(cfg?.enabled && conditions.length);

    enabledEl.checked = enabled;
    if (body) body.classList.toggle('hidden', !enabled);
    if (logicEl) logicEl.value = (cfg?.logic === 'or') ? 'or' : 'and';
    wrap.innerHTML = '';

    if (!enabled) return;
    for (const cond of conditions) {
        addDashboardVisibilityCondition('add');
        const row = wrap.lastElementChild;
        if (!row) continue;
        const entInput = row.querySelector('[data-vis-field="entity"]');
        const opSel = row.querySelector('[data-vis-field="op"]');
        const valInput = row.querySelector('[data-vis-field="value"]');
        if (entInput) entInput.value = cond.entity_id || '';
        if (opSel) opSel.value = cond.op || 'eq';
        if (valInput) valInput.value = cond.value != null ? String(cond.value) : '';
    }
    _enhanceDashboardCustomSelects(wrap);
}

export function setDashboardWidgetEditorMode(mode = 'visual') {
    _dashboardWidgetEditorMode = mode === 'yaml' ? 'yaml' : 'visual';
    const visual = document.getElementById('dashboard-widget-editor-visual');
    const yaml = document.getElementById('dashboard-widget-editor-yaml-wrap');
    const visualTab = document.getElementById('dashboard-widget-editor-visual-tab');
    const yamlTab = document.getElementById('dashboard-widget-editor-yaml-tab');

    if (visual) visual.classList.toggle('hidden', _dashboardWidgetEditorMode !== 'visual');
    if (yaml) yaml.classList.toggle('hidden', _dashboardWidgetEditorMode !== 'yaml');
    if (visualTab) {
        visualTab.classList.toggle('bg-accent', _dashboardWidgetEditorMode === 'visual');
        visualTab.classList.toggle('text-bg-main', _dashboardWidgetEditorMode === 'visual');
        visualTab.classList.toggle('bg-white/5', _dashboardWidgetEditorMode !== 'visual');
        visualTab.classList.toggle('text-slate-200', _dashboardWidgetEditorMode !== 'visual');
    }
    if (yamlTab) {
        yamlTab.classList.toggle('bg-accent', _dashboardWidgetEditorMode === 'yaml');
        yamlTab.classList.toggle('text-bg-main', _dashboardWidgetEditorMode === 'yaml');
        yamlTab.classList.toggle('bg-white/5', _dashboardWidgetEditorMode !== 'yaml');
        yamlTab.classList.toggle('text-slate-200', _dashboardWidgetEditorMode !== 'yaml');
    }
    if (_dashboardWidgetEditorMode === 'yaml') refreshCodeEditor('dashboard-widget-editor-yaml');
}

export async function saveDashboardWidgetEdit() {
    if (!requireDashboardEditAccess()) return;
    if (!_dashboardCurrentEditorId) return;

    let patch = {};
    if (_dashboardWidgetEditorMode === 'yaml') {
        patch = _parseWidgetYaml(getCodeEditorValue('dashboard-widget-editor-yaml') || '', {});
    } else {
        const type = document.getElementById('dashboard-edit-widget-type')?.value || 'button';
        const title = document.getElementById('dashboard-edit-widget-title')?.value || '';
        const subtitle = document.getElementById('dashboard-edit-widget-subtitle')?.value || '';
        const size = document.getElementById('dashboard-edit-widget-size')?.value || 'md';
        const showBackground = document.getElementById('dashboard-edit-widget-label-bg')?.checked;
        const switchStyle = document.getElementById('dashboard-edit-widget-switch-style')?.checked;
        const entityInput = document.getElementById('dashboard-edit-entity-select');
        const selected = _resolveEntityMatch(entityInput, type);

        if (type !== 'label' && !selected) {
            showToast(t('dashboard.pick_entity'), 'warning');
            return;
        }

        patch = {
            type,
            title: title.trim(),
            entity_name: type === 'label' ? subtitle.trim() : subtitle.trim(),
            size,
            entity_id: type === 'label' ? `label.${_slug(title || subtitle || 'section')}` : selected.entity_id,
            source: type === 'label' ? 'manual' : (selected?.source || 'zigbee2mqtt'),
            show_background: type === 'label' ? !!showBackground : false,
            switch_style: type === 'button' ? !!switchStyle : false,
        };
        const visibility = _readDashboardVisibilityConfig();
        if (visibility) patch.visibility = visibility;
    }

    try {
        const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(_dashboardCurrentEditorId)}`, {
            method: 'PATCH',
            body: patch,
        });
        if (!res.ok && res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(_dashApiError(err.detail, 'dashboard.card_update_error'));
        }

        const section = await _readDashboardSectionFallback();
        section.widgets = (section.widgets || []).map(item => item.id === _dashboardCurrentEditorId ? _normalizeLocalWidgetPatch(item, patch) : item);
        await _writeDashboardSectionFallback(section);
        closeDashboardWidgetEditor();
        await loadDashboard();
        showToast(t('dashboard.card_updated'), 'success');
    } catch (e) {
        showToast(e.message || t('dashboard.card_update_error'), 'error');
    }
}

document.addEventListener('click', (event) => {
    _closeDashboardClimateModeMenus();
    const menu = document.getElementById('dashboard-more-menu');
    const wrap = menu?.parentElement;
    if (!menu || menu.classList.contains('hidden')) return;
    if (wrap && !wrap.contains(event.target)) {
        closeDashboardMenu();
    }
});

window.addEventListener('resize', () => {
    _positionDashboardMenu();
});

let _dashboardYamlEditor = null;

function _ensureDashboardYamlEditor() {
    if (_dashboardYamlEditor) return _dashboardYamlEditor;
    _dashboardYamlEditor = createDashboardYamlEditor({
        apiCall,
        t,
        showToast,
        getActivePageId: () => _currentPageId || _dashboardCache.current_page_id || _dashboardCache.page_id || '',
        getActivePageName: () => {
            const pid = _currentPageId || _dashboardCache.current_page_id || _dashboardCache.page_id || '';
            const pages = Array.isArray(_dashboardCache.pages) ? _dashboardCache.pages : [];
            const found = pages.find(p => p && String(p.id) === String(pid));
            return (found && found.title) || _dashboardCache.title || pid || '';
        },
        reloadDashboard: () => loadDashboard(),
    });
    return _dashboardYamlEditor;
}

export async function openDashboardYamlEditor() {
    if (!requireDashboardEditAccess()) return;
    return _ensureDashboardYamlEditor().openDashboardYamlEditor();
}

export function closeDashboardYamlEditor() {
    return _ensureDashboardYamlEditor().closeDashboardYamlEditor();
}

export async function reloadDashboardYaml() {
    return _ensureDashboardYamlEditor().reloadDashboardYaml();
}

export async function saveDashboardYaml() {
    return _ensureDashboardYamlEditor().saveDashboardYaml();
}

function _addDashboardPanelModalPage() {
    const nextIndex = _dashboardPanelModalPages.length + 1;
    _dashboardPanelModalPages.push({
        id: `page_${Date.now().toString(36)}_${nextIndex}`,
        title: `Pagina ${nextIndex}`,
        icon: '',
    });
    _renderDashboardPanelPagesEditor();
}

initDashboardEventBindings({
    closeMenu: () => closeDashboardMenu(),
    toggleLayout: () => { toggleDashboardLayout(); },
    toggleMenu: () => toggleDashboardMenu(),
    toggleEditMode: () => { toggleDashboardEditMode(); },
    openAddPicker: () => { openDashboardAddPicker(); },
    createPage: () => { createDashboardPage(); },
    openPageModal: () => { openDashboardPageModal(); },
    openYamlEditor: () => { openDashboardYamlEditor(); },
    closePanelModal: () => closeDashboardPanelModal(),
    savePanel: () => { saveDashboardPanel(); },
    closePageModal: () => closeDashboardPageModal(),
    deletePage: () => { deleteDashboardPage(); },
    savePageHeader: () => { saveDashboardHeader(); },
    closeYamlEditor: () => closeDashboardYamlEditor(),
    reloadYaml: () => { reloadDashboardYaml(); },
    saveYaml: () => { saveDashboardYaml(); },
    savePreferences: () => { saveDashboardPreferences(); },
    setPanelSize: ({ el }) => {
        const size = el.getAttribute('data-dashboard-panel-size-option');
        if (size) _setDashboardPanelSize(size);
    },
    addPanelPage: () => _addDashboardPanelModalPage(),
    openPanelCreator: () => openDashboardPanelCreator(),
    openPanelEditor: ({ panelId }) => openDashboardPanelEditor(panelId),
    removePanel: ({ panelId }) => { removeDashboardPanel(panelId); },
    selectPanelPage: ({ panelId, pageId }) => selectDashboardPanelPage(panelId, pageId),
    editWidget: ({ widgetId }) => { openDashboardWidgetEditor(widgetId); },
    removeWidget: ({ widgetId }) => { removeDashboardWidget(widgetId); },
    cardActivate: ({ event, widgetId }) => {
        if (event.type === 'keydown') handleDashboardCardKeydown(event, widgetId);
        else handleDashboardCardClick(event, widgetId);
    },
    selectPage: ({ pageId }) => { selectDashboardPage(pageId); },
    openPageNav: ({ pageId }) => { openDashboardPageNav(pageId); },
    pickEntity: ({ mode, entityId }) => pickDashboardEntityOption(mode, entityId),
    saveAddWidget: () => { addDashboardSwitch(); },
    widgetDrag: ({ event, widgetId }) => startDashboardDrag(event, widgetId),
    panelDrag: ({ event, panelId }) => startDashboardPanelDrag(event, panelId),
    climateSwipeStart: ({ event, widgetId }) => startDashboardClimateSwipe(event, widgetId),
    climateAdjustTemp: ({ widgetId, entityId, delta }) => {
        adjustDashboardClimateTemperature(widgetId, delta, entityId);
    },
    climateToggleModeMenu: ({ event, widgetId, entityId }) => {
        toggleDashboardClimateModeMenu(widgetId, event, entityId);
    },
    climateSetMode: ({ widgetId, entityId, climateMode }) => {
        setDashboardClimateMode(widgetId, climateMode, entityId);
    },
    climateSelectSlide: ({ event, widgetId, slideIndex }) => {
        selectDashboardClimateSlide(widgetId, slideIndex, event);
    },
    climateRemoveEntity: ({ entityId }) => removeDashboardClimateEntity(entityId),
    climateEntityMeta: ({ entityId, field, event }) => {
        updateDashboardClimateEntityMeta(entityId, field, event.target.value);
    },
    lockAction: ({ widgetId, action }) => { onDashboardLockAction(widgetId, action); },
    vacuumAction: ({ widgetId, action }) => { onDashboardVacuumAction(widgetId, action); },
    brightnessInput: ({ event, widgetId }) => onDashboardBrightnessInput(event, widgetId),
    brightnessChange: ({ event, widgetId }) => onDashboardBrightnessChange(event, widgetId),
});

registerHyveviewDashboardCards(_dashboardWidgetEntityIds);

initDashboardPullToRefresh({
    loadDashboard,
    selectDashboardPage,
    setRefreshIndicator: _setDashboardRefreshIndicator,
    showToast,
    t,
    getCurrentPageId: () => _currentPageId || _dashboardCache.page_id || _dashboardCache.current_page_id,
});

initDashboardDragResize({
    getCache: () => _dashboardCache,
    getCurrentPageId: () => _currentPageId || _dashboardCache.page_id || _dashboardCache.current_page_id || '',
    getEditMode: () => _dashboardEditMode,
    findWidget: _findWidget,
    widgetSpan: _widgetSpan,
    panelColSpan: _dashboardPanelColSpan,
    isStandalonePanel: _isDashboardStandalonePanel,
    ensureStandalonePanelLocal: _ensureDashboardStandalonePanelLocal,
    renderDashboard: _renderDashboard,
    loadDashboard,
    readDashboardSectionFallback: _readDashboardSectionFallback,
    writeDashboardSectionFallback: _writeDashboardSectionFallback,
    apiCall,
    t,
    showToast,
});

initDashboardClimate({
    getCache: () => _dashboardCache,
    findWidget: _findWidget,
    renderDashboard: _renderDashboard,
    renderDashboardAddPreview: _renderDashboardAddPreview,
    getEditMode: () => _dashboardEditMode,
    widgetDragAttrs: _widgetDragAttrs,
    widgetEditControls: _widgetEditControls,
    widgetSizeClass: _widgetSizeClass,
    resolveEntityMatch: _resolveEntityMatch,
    apiCall,
    t,
    showToast,
    dashApiError: _dashApiError,
    escapeHtml: _escape,
    stateOn: _stateOn,
    widgetTitle,
    HVBridge,
    controlPending: _dashboardControlPending,
    setPendingControl: (widgetId, data) => _dashboardPendingControls.set(widgetId, data),
    deletePendingControl: (widgetId) => _dashboardPendingControls.delete(widgetId),
    snapshotEntityState: _snapshotDashboardEntityState,
    restoreEntitySnapshot: _restoreDashboardEntitySnapshot,
    patchEntityState: _patchDashboardEntityState,
    tryFastPathForEntities: _tryFastPathForEntities,
    getCurrentPageId: () => _currentPageId || _dashboardCache.page_id || _dashboardCache.current_page_id || '',
});

initDashboardWidgetActions({
    apiCall,
    t,
    showToast,
    findWidget: _findWidget,
    tryFastPathForEntities: _tryFastPathForEntities,
    renderDashboard: _renderDashboard,
});
