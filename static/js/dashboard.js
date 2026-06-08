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
import { widgetIconSpec } from './icon_utils.js';
import {
    DEFAULT_PREFS,
    DEFAULT_META,
    DASHBOARD_LOCAL_KEY,
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
    dashboardIntentAction,
    entityIcon,
    entityIconForState,
    iconClass,
    isControllableDomain,
    isInfoDomain,
    widgetRenderer,
} from './dashboard/widget_meta.js';
import {
    abortDashboardPageNavigation,
    initDashboardPageSelect,
    selectDashboardPage,
} from './dashboard/page_select.js';
import {
    ensureDashboardStandalonePanelLocal,
    initDashboardStandalonePanel,
    isDashboardStandalonePanel,
} from './dashboard/standalone_panel.js';
import {
    initDashboardWidgetDelete,
    removeDashboardWidget,
} from './dashboard/widget_delete.js';
import {
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
export { selectDashboardPage } from './dashboard/page_select.js';
export { removeDashboardWidget } from './dashboard/widget_delete.js';
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
    const editingRenderer = editingWidget ? widgetRenderer(editingWidget) : '';
    return dashboardEditorRenderer(type, { editingRenderer });
}

export function resetDashboardEditingState() {
    // Leaving the dashboard should cancel any visual loading state. A pending
    // request may still finish, but it must not keep the top bar stuck when
    // the user comes back from another tab.
    try { abortDashboardPageNavigation(); } catch (_) {}
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
    iconClass,
    widgetIcon: widgetIconSpec,
    entityIcon,
    entityIconForState,
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

function _dashboardAvailableEntity(entityId) {
    return findEntityById(_dashboardCache.available_entities, entityId);
}

function _activeDashboardPageId() {
    return _currentPageId || _dashboardCache.current_page_id || _dashboardCache.page_id || '';
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

initDashboardStandalonePanel({
    getCache: () => _dashboardCache,
});

initDashboardPageSelect({
    getCache: () => _dashboardCache,
    setCache: (cache) => { _dashboardCache = cache; },
    getCurrentPageId: () => _currentPageId,
    setCurrentPageId: (id) => { _currentPageId = id; },
    setHashForPage,
    renderDashboard,
    setDashboardRefreshIndicator,
    withDashboardTimeout,
    refreshAvailableEntities,
    showToast,
    t,
});

initDashboardWidgetDelete({
    requireDashboardEditAccess,
    showConfirm,
    showToast,
    t,
    loadDashboard,
    readDashboardSectionFallback,
    writeDashboardSectionFallback,
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
    dashboardIntentAction,
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
    widgetRenderer,
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
    widgetRenderer,
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
    isStandalonePanel: isDashboardStandalonePanel,
    filteredWidgets,
    escapeHtml: _escape,
    t,
    iconClass,
    enhanceSparklines,
    configureHyveviewMounted: configureHyveviewMounted,
    resumeDashboardCameras,
});

initDashboardLoader({
    getDashboardCache: () => _dashboardCache,
    setDashboardCache: (cache) => { _dashboardCache = cache; },
    getCurrentPageId: () => _currentPageId,
    setCurrentPageId: (id) => { _currentPageId = id; },
    isControllableDomain,
    isInfoDomain,
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
    iconClass,
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
    isStandalonePanel: isDashboardStandalonePanel,
    ensureStandalonePanelLocal: ensureDashboardStandalonePanelLocal,
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
    entityIcon,
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
