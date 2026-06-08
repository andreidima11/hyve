import { apiCall } from './api.js';
import { cameraPreferWebmPlayer, cameraSupportsGo2rtc } from './camera_live.js';
import { getCameraStreamToken } from './camera_auth.js';
import { showConfirm, showToast } from './utils.js';
import { t, translateApiDetail, tVacuumStatus } from './lang/index.js';
import './entity_renderers.js';
// Hyveview bare-path imports dedupe to a single module instance (see hyveview_setup.js).
import '/static/hyveview/elements/camera_stream.js';
import '/static/hyveview/elements/camera_carousel.js';
import { dashDebug, DASH_DEBUG_ENABLED } from './dashboard/debug.js';
import { switchTab, closeSidebar, isSidebarOpen } from './nav_bridge.js';
import { HVBridge, HVSetHost, hvOpenEditor, registerHyveviewDashboardCards } from './dashboard/hyveview_setup.js';
import { createDashboardYamlEditor } from './dashboard/yaml_editor.js';
import { initDashboardPullToRefresh } from './dashboard/pull_refresh.js';
import { createDashboardLiveWs } from './dashboard/live_ws.js';
import { createDashboardEntityPatcher } from './dashboard/entity_patch.js';
import { widgetTitle } from '/static/hyveview/host.js';
import { normalizeIconClass, widgetIconSpec } from './icon_utils.js';
import {
    DEFAULT_PREFS,
    DEFAULT_META,
    DASHBOARD_LOCAL_KEY,
    DASHBOARD_LAST_PAGE_KEY,
    DASHBOARD_STANDALONE_PANEL_ID,
    DASHBOARD_OPTIMISTIC_GUARD_MS,
    DASHBOARD_PENDING_VISUAL_MS,
    SECTION_COLS,
    DASHBOARD_COL_POINTS_MIN,
    DASHBOARD_COL_POINTS_MAX,
    DASHBOARD_GRID_COLS,
} from './dashboard/constants.js';
import { dashApiError as _dashApiError, escapeHtml as _escape, stateOn as _stateOn } from './dashboard/helpers.js';
import { findEntityById } from './entity_aliases.js';
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
import { applyDashboardEditAccess, canEditDashboard, requireDashboardEditAccess } from './dashboard/edit_access.js';
import { initDashboardEventBindings } from './dashboard/event_bindings.js';
import {
    initDashboardPagesNav,
    initDashboardSidebarNav,
    openDashboardPageNav,
    renderDashboardPagesList,
    bindHashRouter,
    readHashPageId,
    setHashForPage,
    resolveCurrentDashboardPageId,
} from './dashboard/pages_nav.js';
import { getCard } from './dashboard/card_registry.js';
import { registerDashboardCards, cameraWidgetEntities as _cameraEntitiesHelper } from './dashboard/cards/register.js';
import { weatherIcon, weatherIsNight, weatherVariant } from './dashboard/weather_host.js';
import { enhanceSparklines, enhanceSparklinesIn, trendCache } from './dashboard/sparklines.js';
import {
    addDashboardPanelModalPage,
    closeDashboardPanelModal,
    initDashboardPanelModal,
    openDashboardPanelCreator,
    openDashboardPanelEditor,
    saveDashboardPanel,
    setDashboardPanelSize,
} from './dashboard/panel_modal.js';
import {
    closeDashboardPageModal,
    createDashboardPage,
    deleteDashboardPage,
    initDashboardPageModal,
    openDashboardPageModal,
    saveDashboardHeader,
} from './dashboard/page_modal.js';
import {
    abortPendingLoad,
    dashboardHasRenderedContent,
    initDashboardLoader,
    loadDashboard,
    readDashboardSectionFallback,
    refreshAvailableEntities,
    setDashboardRefreshIndicator,
    withDashboardTimeout,
    writeDashboardSectionFallback,
} from './dashboard/dashboard_loader.js';
import {
    addDashboardVisibilityCondition,
    initDashboardWidgetAddEditor,
    renderDashboardAddPreview,
    toggleDashboardVisibilityEditor,
} from './dashboard/widget_add_editor.js';
import {
    addDashboardSwitch,
    closeDashboardAddModal,
    initDashboardWidgetAddModal,
    openDashboardAddModal,
    updateDashboardEditTypeUI,
    updateDashboardEntityOptions,
    updateDashboardTypeUI,
} from './dashboard/widget_add_modal.js';
import {
    closeDashboardWidgetEditor,
    initDashboardWidgetLegacyEdit,
    saveDashboardWidgetEdit,
    setDashboardWidgetEditorMode,
} from './dashboard/widget_legacy_edit.js';
import {
    ensureHyveviewEntitySeed,
    initDashboardWidgetEditorBridge,
    openDashboardWidgetEditor,
    saveDashboardWidgetFromEditor,
} from './dashboard/widget_editor_bridge.js';
import {
    dashboardSnapshotFingerprint,
    getDashboardPageSnapshot,
    isDashboardStandalonePanel,
    normalizeCache,
    readDashboardViewCache,
    saveDashboardViewCache,
    stashDashboardPageSnapshot,
} from './dashboard/dashboard_cache.js';
import {
    dashboardDefaultRowsForType,
    dashboardEditorRenderer,
    getDashboardCardMeta,
    loadDashboardCardCatalog,
} from './dashboard/card_catalog.js';
import {
    closeDashboardEntityPicker,
    entityAllowedForCard,
    filterDashboardEntityOptions,
    handleDashboardEntityPickerKeydown,
    initDashboardEntityPicker,
    openDashboardEntityPicker,
    pickDashboardEntityOption,
    renderEntityOptions,
    resolveEntityMatch,
    setEntitySelectState,
} from './dashboard/entity_picker.js';
export { loadDashboard, dashboardHasRenderedContent } from './dashboard/dashboard_loader.js';
export {
    addDashboardVisibilityCondition,
    setDashboardAddEditorMode,
    toggleDashboardVisibilityEditor,
} from './dashboard/widget_add_editor.js';
export {
    addDashboardSwitch,
    closeDashboardAddModal,
    openDashboardAddModal,
    updateDashboardEditTypeUI,
    updateDashboardEntityOptions,
    updateDashboardTypeUI,
} from './dashboard/widget_add_modal.js';
export {
    closeDashboardWidgetEditor,
    saveDashboardWidgetEdit,
    setDashboardWidgetEditorMode,
} from './dashboard/widget_legacy_edit.js';
export { openDashboardWidgetEditor } from './dashboard/widget_editor_bridge.js';
export {
    closeDashboardEntityPicker,
    filterDashboardEntityOptions,
    handleDashboardEntityPickerKeydown,
    openDashboardEntityPicker,
    pickDashboardEntityOption,
} from './dashboard/entity_picker.js';
export { initDashboardSidebarNav, openDashboardPageNav } from './dashboard/pages_nav.js';
export {
    closeDashboardPageModal,
    createDashboardPage,
    deleteDashboardPage,
    openDashboardPageModal,
    saveDashboardHeader,
} from './dashboard/page_modal.js';
export {
    addDashboardPanelVisibilityCondition,
    closeDashboardPanelModal,
    openDashboardPanelCreator,
    openDashboardPanelEditor,
    saveDashboardPanel,
    toggleDashboardPanelBackground,
    toggleDashboardPanelVisibility,
} from './dashboard/panel_modal.js';
import {
    enhanceDashboardCustomSelects,
    syncDashboardCustomSelect,
} from './dashboard/custom_selects.js';
import { initDashboardClimate, climateConfiguredIds,
    toggleDashboardClimateModeMenu, selectDashboardClimateSlide, shiftDashboardClimateSlide,
    startDashboardClimateSwipe, moveDashboardClimateSwipe, endDashboardClimateSwipe,
    adjustDashboardClimateTemperature, setDashboardClimateMode,
    setDashboardClimateEntitySelection, clearDashboardClimateEntitySelection,
    addDashboardClimateEntityId, climateEntityRecordsForSave,
    renderDashboardClimateEntityChips,
    updateDashboardClimateEntityMeta, addSelectedDashboardClimateEntity, removeDashboardClimateEntity,
    closeDashboardClimateModeMenus,
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

registerDashboardCards();

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
let _dashboardEditMode = false;
let _dashboardCurrentEditorId = null;
let _currentPageId = null;
let _dashboardPageNavToken = 0;
const _dashboardPendingControls = new Map();
const _dashboardOptimisticGuards = new Map();

function _normalizeCache(payload = {}) {
    return normalizeCache(payload);
}

function _renderCachedDashboardIfEmpty() {
    const grid = document.getElementById('dashboard-grid');
    if (!grid || grid.firstElementChild) return false;
    const cached = readDashboardViewCache();
    if (!cached) return false;
    _dashboardCache = {
        ...cached,
        available_entities: Array.isArray(_dashboardCache.available_entities) ? _dashboardCache.available_entities : [],
    };
    if (_dashboardCache.page_id) _currentPageId = _dashboardCache.page_id;
    _renderDashboard();
    return true;
}

let _dashboardPrefetchTimer = null;
function _schedulePagePrefetch() {
    // Prefetch disabled — see dashboard_loader.js / page snapshots.
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
    return getDashboardCardMeta(type);
}

function _entityAllowedForCard(item, type = 'button') {
    return entityAllowedForCard(item, type);
}

function _dashboardDefaultRowsForType(type) {
    return dashboardDefaultRowsForType(type);
}

function _dashboardEditorRenderer(type) {
    const editingWidget = _dashboardCurrentEditorId ? _findWidget(_dashboardCurrentEditorId) : null;
    const editingRenderer = editingWidget ? _widgetRenderer(editingWidget) : '';
    return dashboardEditorRenderer(type, { editingRenderer });
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
    return isDashboardStandalonePanel(panel);
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
    try { setDashboardRefreshIndicator(false); } catch (_) {}
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
    renderDashboardPagesList();

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
        enhanceSparklines();
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
    enhanceSparklines();
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
        await refreshAvailableEntities();
        _renderDashboard();
        showToast(t('dashboard.section_deleted'), 'success');
    } catch (e) {
        showToast(e.message || t('dashboard.section_delete_error'), 'error');
    }
}

// Publish helpers to Hyveview card classes (avoids circular imports).
HVSetHost({
    iconClass: _iconClass,
    widgetIcon: widgetIconSpec,
    entityIcon: _entityIcon,
    entityIconForState: _entityIconForState,
    escape: _escape,
    enhanceSparklinesIn,
    trendCache,
    stateOn: _stateOn,
    controlVisuallyPending: _dashboardControlVisuallyPending,
    weatherIcon,
    weatherVariant,
    weatherIsNight,
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

function _buildCardRenderCtx(renderer, extra = {}) {
    return {
        renderer,
        getEditMode: () => _dashboardEditMode,
        widgetDragAttrs: _widgetDragAttrs,
        widgetEditControls: _widgetEditControls,
        widgetSizeClass: _widgetSizeClass,
        widgetSpan: _widgetSpan,
        widgetRenderer: _widgetRenderer,
        escapeHtml: _escape,
        stateOn: _stateOn,
        controlVisuallyPending: _dashboardControlVisuallyPending,
        renderCardElement: (w) => HVBridge.renderCardElement(w),
        widgetTitle,
        getCache: () => _dashboardCache,
        cameraPreferWebmPlayer,
        cameraSupportsGo2rtc,
        ...extra,
    };
}

function _cameraWidgetEntities(widget) {
    return _cameraEntitiesHelper(widget, _buildCardRenderCtx(_widgetRenderer(widget)));
}

function _renderWidgetCard(widget) {
    const renderer = _widgetRenderer(widget);
    const registered = getCard(renderer) || getCard('button');
    return registered.render(widget, _buildCardRenderCtx(renderer));
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

// ===== Add picker (single entry point for all "Adaugă …" actions) =====

async function _loadDashboardCardCatalog(force = false) {
    return loadDashboardCardCatalog(apiCall, force);
}

export async function openDashboardAddPicker() {
    if (!requireDashboardEditAccess()) return;
    // R5.2: route the "Add card" action through the schema-driven editor.
    // The new editor renders its own card picker (built from the registry),
    // so we no longer open the legacy `dashboard-add-picker-modal`.
    closeDashboardMenu();
    await ensureHyveviewEntitySeed();
    const result = await hvOpenEditor({ mode: 'add' });
    if (!result) return;
    await saveDashboardWidgetFromEditor(result, { editingId: null, original: null });
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

export async function selectDashboardPage(pageId) {
    if (!pageId) return;
    const myToken = ++_dashboardPageNavToken;
    _currentPageId = String(pageId);
    try { localStorage.setItem(DASHBOARD_LAST_PAGE_KEY, _currentPageId); } catch (_) {}
    setHashForPage(_currentPageId);
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
        const snap = getDashboardPageSnapshot(_currentPageId);
        if (snap) {
            _dashboardCache = {
                ...snap,
                available_entities: Array.isArray(_dashboardCache.available_entities)
                    ? _dashboardCache.available_entities
                    : [],
            };
            if (_dashboardCache.page_id) _currentPageId = _dashboardCache.page_id;
            snapFp = dashboardSnapshotFingerprint(snap);
            _renderDashboard();
            renderedFromSnapshot = true;
            if (grid) requestAnimationFrame(() => { grid.style.opacity = '1'; });
        }
    } catch (_) {}

    if (!renderedFromSnapshot && grid && !grid.firstElementChild) {
        grid.innerHTML = `<div class="col-span-full p-6 text-sm" style="color:var(--text-tertiary,#94a3b8);">${_escape(t('dashboard.loading_page'))}</div>`;
    }
    setDashboardRefreshIndicator(true);

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
        await withDashboardTimeout(
            refreshAvailableEntities({ includeEntities: false }),
            8000,
            t('dashboard.refresh_timeout')
        );
        if (myToken !== _dashboardPageNavToken) { if (watchdog) clearTimeout(watchdog); return; }
        // Only repaint if we didn't already render this exact content from the
        // snapshot — avoids a redundant flash on every switch.
        const freshFp = dashboardSnapshotFingerprint(_dashboardCache);
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
        if (myToken === _dashboardPageNavToken) setDashboardRefreshIndicator(false);
        const gridEl = document.getElementById('dashboard-grid');
        if (gridEl) gridEl.style.opacity = '1';
    }
}

function _dashboardAvailableEntity(entityId) {
    return findEntityById(_dashboardCache.available_entities, entityId);
}

function _activeDashboardPageId() {
    return _currentPageId || _dashboardCache.current_page_id || _dashboardCache.page_id || '';
}

export function toggleDashboardEditMode() {
    if (!requireDashboardEditAccess()) return;
    resolveCurrentDashboardPageId();
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

    const section = await readDashboardSectionFallback();
    section.preferences = prefs;
    await writeDashboardSectionFallback(section);
    _dashboardCache.preferences = section.preferences;
    _renderDashboard();
    if (!silent) showToast(t('dashboard.preferences_saved'), 'success');
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
        const section = await readDashboardSectionFallback();
        section.widgets = (section.widgets || []).filter(item => item.id !== widgetId);
        await writeDashboardSectionFallback(section);
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
    const section = await readDashboardSectionFallback();
    const storedWidgets = Array.isArray(section.widgets) ? section.widgets : [];
    const orderedIds = (_dashboardCache.widgets || []).map(item => item.id);
    section.widgets = orderedIds.map(id => storedWidgets.find(item => item.id === id)).filter(Boolean);
    await writeDashboardSectionFallback(section);
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
    // Card activate surface is role=button — not a nested control (delegation uses document as currentTarget).
    if (interactive.getAttribute?.('data-dash-action') === 'cardActivate') return null;
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


document.addEventListener('click', (event) => {
    closeDashboardClimateModeMenus();
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

initDashboardLoader({
    getDashboardCache: () => _dashboardCache,
    setDashboardCache: (cache) => { _dashboardCache = cache; },
    getCurrentPageId: () => _currentPageId,
    setCurrentPageId: (id) => { _currentPageId = id; },
    isControllableDomain: _isControllableDomain,
    isInfoDomain: _isInfoDomain,
    renderCachedDashboardIfEmpty: _renderCachedDashboardIfEmpty,
    renderDashboard: _renderDashboard,
    applyDashboardEditAccess,
    canEditDashboard,
    getEditMode: () => _dashboardEditMode,
    resetDashboardEditingState,
    resumeDashboardCameras,
    connectDashboardLive: _connectDashboardLive,
    configureHyveviewMounted: _configureHyveviewMounted,
    updateDashboardEntityOptions,
    setEntitySelectState,
    escapeHtml: _escape,
    t,
});

initDashboardPagesNav({
    getCurrentPageId: () => _currentPageId,
    setCurrentPageId: (id) => { _currentPageId = id; },
    getDashboardCache: () => _dashboardCache,
    setDashboardPages: (pages) => { _dashboardCache.pages = pages; },
    readDashboardViewCache: readDashboardViewCache,
    escape: _escape,
    iconClass: _iconClass,
    selectDashboardPage,
    switchTab,
    closeSidebar,
    isSidebarOpen,
});

initDashboardPanelModal({
    requireDashboardEditAccess,
    getDashboardCache: () => _dashboardCache,
    getCurrentPageId: () => _currentPageId,
    refreshAvailableEntities,
    renderDashboard: _renderDashboard,
    closeDashboardMenu,
    t,
    showToast,
});

initDashboardPageModal({
    requireDashboardEditAccess,
    getDashboardCache: () => _dashboardCache,
    getCurrentPageId: () => _currentPageId,
    setCurrentPageId: (id) => { _currentPageId = id; },
    closeDashboardMenu,
    syncPreferenceControls: _syncPreferenceControls,
    renderDashboardPagesList,
    selectDashboardPage,
    loadDashboard,
    abortPendingLoad,
    t,
});

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
        if (size) setDashboardPanelSize(size);
    },
    addPanelPage: () => addDashboardPanelModalPage(),
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
    setRefreshIndicator: setDashboardRefreshIndicator,
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
    readDashboardSectionFallback: readDashboardSectionFallback,
    writeDashboardSectionFallback: writeDashboardSectionFallback,
    apiCall,
    t,
    showToast,
});

initDashboardWidgetAddEditor({
    getDashboardCache: () => _dashboardCache,
    getAvailableEntity: _dashboardAvailableEntity,
    renderWidgetCardForPreview: _renderWidgetCardForPreview,
    climateEntityRecordsForSave,
    t,
});

initDashboardWidgetAddModal({
    requireDashboardEditAccess,
    closeDashboardMenu,
    closeDashboardWidgetEditor,
    getCurrentPageId: _activeDashboardPageId,
    getCurrentEditorId: () => _dashboardCurrentEditorId,
    clearCurrentEditorId: () => { _dashboardCurrentEditorId = null; },
    getAvailableEntity: _dashboardAvailableEntity,
    dashboardEditorRenderer: _dashboardEditorRenderer,
    dashboardDefaultRowsForType: _dashboardDefaultRowsForType,
    loadDashboardCardCatalog: _loadDashboardCardCatalog,
    refreshAvailableEntities,
    loadDashboard,
    readDashboardSectionFallback,
    writeDashboardSectionFallback,
    clearDashboardClimateEntitySelection,
    climateEntityRecordsForSave,
    renderDashboardClimateEntityChips,
    t,
});

initDashboardWidgetLegacyEdit({
    requireDashboardEditAccess,
    getCurrentEditorId: () => _dashboardCurrentEditorId,
    readDashboardSectionFallback,
    writeDashboardSectionFallback,
    loadDashboard,
    t,
});

initDashboardWidgetEditorBridge({
    requireDashboardEditAccess,
    findWidget: _findWidget,
    getDashboardCache: () => _dashboardCache,
    getCurrentPageId: _activeDashboardPageId,
    refreshAvailableEntities,
    loadDashboard,
    readDashboardSectionFallback,
    writeDashboardSectionFallback,
    t,
});

initDashboardEntityPicker({
    getCache: () => _dashboardCache,
    escapeHtml: _escape,
    t,
    entityIcon: _entityIcon,
    addClimateEntityId: addDashboardClimateEntityId,
    renderDashboardAddPreview,
});

initDashboardClimate({
    getCache: () => _dashboardCache,
    findWidget: _findWidget,
    renderDashboard: _renderDashboard,
    renderDashboardAddPreview,
    getEditMode: () => _dashboardEditMode,
    widgetDragAttrs: _widgetDragAttrs,
    widgetEditControls: _widgetEditControls,
    widgetSizeClass: _widgetSizeClass,
    resolveEntityMatch,
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
