import { apiCall } from './api.js';
import { getCameraStreamToken } from './camera_auth.js';
import { showConfirm, showToast } from './utils.js';
import { t, translateApiDetail, tVacuumStatus } from './lang/index.js';
import './entity_renderers.js';
// Hyveview bare-path imports dedupe to a single module instance (see hyveview_setup.js).
import '/static/hyveview/elements/camera_stream.js';
import '/static/hyveview/elements/camera_carousel.js';
import { switchTab, closeSidebar, isSidebarOpen } from './nav_bridge.js';
import { HVBridge, HVSetHost, hvOpenEditor, registerHyveviewDashboardCards } from './dashboard/hyveview_setup.js';
import { createDashboardYamlEditor } from './dashboard/yaml_editor.js';
import { initDashboardPullToRefresh } from './dashboard/pull_refresh.js';
import { widgetTitle } from '/static/hyveview/host.js';
import { normalizeIconClass, widgetIconSpec } from './icon_utils.js';
import {
    DEFAULT_PREFS,
    DEFAULT_META,
    DASHBOARD_LOCAL_KEY,
    DASHBOARD_LAST_PAGE_KEY,
    DASHBOARD_STANDALONE_PANEL_ID,
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
import { registerDashboardCards } from './dashboard/cards/register.js';
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
import { initDashboardVisibility } from './dashboard/dashboard_visibility.js';
import {
    cameraWidgetEntities,
    dashboardPanelColSpan,
    initDashboardWidgetCards,
    renderWidgetCardForPreview,
    widgetDragAttrs,
    widgetEditControls,
    widgetSizeClass,
    widgetSpan,
} from './dashboard/widget_cards.js';
import {
    initDashboardRender,
    renderDashboard,
    selectDashboardPanelPage,
} from './dashboard/dashboard_render.js';
import {
    filteredWidgets,
    initDashboardPreferences,
    saveDashboardPreferences,
    setDashboardFilter,
    syncPreferenceControls,
    toggleDashboardEditMode,
    toggleDashboardLayout,
    updateStats,
} from './dashboard/dashboard_preferences.js';
import {
    handleDashboardCardClick,
    handleDashboardCardKeydown,
    initDashboardWidgetToggle,
    patchDashboardEntityState,
    restoreDashboardEntitySnapshot,
    snapshotDashboardEntityState,
    toggleDashboardWidget,
} from './dashboard/widget_toggle.js';
import {
    controlPending,
    controlVisuallyPending,
    deletePendingControl,
    setPendingControl,
} from './dashboard/control_state.js';
import {
    configureHyveviewMounted,
    connectDashboardLive,
    dashboardWidgetEntityIds,
    disconnectDashboardLive,
    initDashboardLiveBridge,
    resumeDashboardCameras,
    tryFastPathForEntities,
} from './dashboard/live_bridge.js';
import {
    closeDashboardMenu,
    initDashboardMenu,
    toggleDashboardMenu,
} from './dashboard/dashboard_menu.js';
import {
    dashboardWidgetById,
    findWidget,
    initDashboardWidgetStore,
} from './dashboard/widget_store.js';
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
export { disconnectDashboardLive } from './dashboard/live_bridge.js';
export { closeDashboardMenu, toggleDashboardMenu } from './dashboard/dashboard_menu.js';
export { findWidget } from './dashboard/widget_store.js';
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
export { selectDashboardPanelPage } from './dashboard/dashboard_render.js';
export {
    saveDashboardPreferences,
    setDashboardFilter,
    toggleDashboardEditMode,
    toggleDashboardLayout,
} from './dashboard/dashboard_preferences.js';
export {
    handleDashboardCardClick,
    handleDashboardCardKeydown,
    toggleDashboardWidget,
} from './dashboard/widget_toggle.js';
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
    renderDashboard();
    return true;
}

let _dashboardPrefetchTimer = null;
function _schedulePagePrefetch() {
    // Prefetch disabled — see dashboard_loader.js / page snapshots.
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
    const editingWidget = _dashboardCurrentEditorId ? findWidget(_dashboardCurrentEditorId) : null;
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
    if (grid && onDashboardTab) renderDashboard();
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
        renderDashboard();
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
    controlVisuallyPending: controlVisuallyPending,
    weatherIcon,
    weatherVariant,
    weatherIsNight,
    tVacuumStatus,
    t,
});


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
            renderDashboard();
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
        if (!renderedFromSnapshot || freshFp !== snapFp) renderDashboard();
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

initDashboardMenu({
    closeDashboardClimateModeMenus,
});

initDashboardWidgetStore({
    getCache: () => _dashboardCache,
    getCurrentPageId: () => _currentPageId,
    renderDashboard,
    readDashboardSectionFallback,
    writeDashboardSectionFallback,
});

initDashboardPreferences({
    getCache: () => _dashboardCache,
    getCurrentPageId: _activeDashboardPageId,
    getEditMode: () => _dashboardEditMode,
    setEditMode: (value) => { _dashboardEditMode = value; },
    requireDashboardEditAccess,
    resolveCurrentDashboardPageId,
    closeDashboardMenu,
    renderDashboard,
    readDashboardSectionFallback,
    writeDashboardSectionFallback,
    t,
});

initDashboardWidgetToggle({
    getCache: () => _dashboardCache,
    getEditMode: () => _dashboardEditMode,
    controlPending,
    findWidget,
    dashboardIntentAction: _dashboardIntentAction,
    tryFastPathForEntities,
    renderDashboard,
    getActivePageId: _activeDashboardPageId,
    t,
});

initDashboardLiveBridge({
    HVBridge,
    getCache: () => _dashboardCache,
    climateConfiguredIds,
    cameraWidgetEntities,
    widgetRenderer: _widgetRenderer,
    widgetById: dashboardWidgetById,
    renderDashboard,
});

initDashboardVisibility({
    getEditMode: () => _dashboardEditMode,
    renderDashboard,
});

initDashboardWidgetCards({
    getCache: () => _dashboardCache,
    getEditMode: () => _dashboardEditMode,
    withoutEditMode: (fn) => {
        const was = _dashboardEditMode;
        _dashboardEditMode = false;
        try { return fn(); } finally { _dashboardEditMode = was; }
    },
    widgetRenderer: _widgetRenderer,
    dashboardDefaultRowsForType: _dashboardDefaultRowsForType,
    escapeHtml: _escape,
    stateOn: _stateOn,
    controlVisuallyPending: controlVisuallyPending,
    HVBridge,
    t,
});

initDashboardRender({
    getCache: () => _dashboardCache,
    getEditMode: () => _dashboardEditMode,
    syncPreferenceControls,
    updateStats,
    renderDashboardPagesList,
    isStandalonePanel: _isDashboardStandalonePanel,
    filteredWidgets,
    escapeHtml: _escape,
    t,
    iconClass: _iconClass,
    enhanceSparklines,
    configureHyveviewMounted: configureHyveviewMounted,
    resumeDashboardCameras,
});

initDashboardLoader({
    getDashboardCache: () => _dashboardCache,
    setDashboardCache: (cache) => { _dashboardCache = cache; },
    getCurrentPageId: () => _currentPageId,
    setCurrentPageId: (id) => { _currentPageId = id; },
    isControllableDomain: _isControllableDomain,
    isInfoDomain: _isInfoDomain,
    renderCachedDashboardIfEmpty: _renderCachedDashboardIfEmpty,
    renderDashboard: renderDashboard,
    applyDashboardEditAccess,
    canEditDashboard,
    getEditMode: () => _dashboardEditMode,
    resetDashboardEditingState,
    resumeDashboardCameras,
    connectDashboardLive: connectDashboardLive,
    configureHyveviewMounted: configureHyveviewMounted,
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
    renderDashboard: renderDashboard,
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
    syncPreferenceControls,
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

registerHyveviewDashboardCards(dashboardWidgetEntityIds);

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
    findWidget,
    widgetSpan: widgetSpan,
    panelColSpan: dashboardPanelColSpan,
    isStandalonePanel: _isDashboardStandalonePanel,
    ensureStandalonePanelLocal: _ensureDashboardStandalonePanelLocal,
    renderDashboard: renderDashboard,
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
    renderWidgetCardForPreview: renderWidgetCardForPreview,
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
    findWidget,
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
    findWidget,
    renderDashboard: renderDashboard,
    renderDashboardAddPreview,
    getEditMode: () => _dashboardEditMode,
    widgetDragAttrs: widgetDragAttrs,
    widgetEditControls,
    widgetSizeClass,
    resolveEntityMatch,
    apiCall,
    t,
    showToast,
    dashApiError: _dashApiError,
    escapeHtml: _escape,
    stateOn: _stateOn,
    widgetTitle,
    HVBridge,
    controlPending,
    setPendingControl,
    deletePendingControl,
    snapshotEntityState: snapshotDashboardEntityState,
    restoreEntitySnapshot: restoreDashboardEntitySnapshot,
    patchEntityState: patchDashboardEntityState,
    tryFastPathForEntities: tryFastPathForEntities,
    getCurrentPageId: () => _currentPageId || _dashboardCache.page_id || _dashboardCache.current_page_id || '',
});

initDashboardWidgetActions({
    apiCall,
    t,
    showToast,
    findWidget,
    tryFastPathForEntities: tryFastPathForEntities,
    renderDashboard: renderDashboard,
});
