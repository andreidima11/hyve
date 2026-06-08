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
    initDashboardAddPicker,
    openDashboardAddPicker,
} from './dashboard/add_picker.js';
import {
    closeDashboardYamlEditor,
    initDashboardYamlBridge,
    openDashboardYamlEditor,
    reloadDashboardYaml,
    saveDashboardYaml,
} from './dashboard/yaml_bridge.js';
import {
    initDashboardPanelDelete,
    removeDashboardPanel,
} from './dashboard/panel_delete.js';
import {
    initDashboardEditingState,
    resetDashboardEditingState,
} from './dashboard/editing_state.js';
import {
    activeDashboardPageId,
    dashboardAvailableEntity,
    dashboardEditorRendererForType,
    fetchDashboardCardCatalog,
    initDashboardContext,
} from './dashboard/dashboard_context.js';
import {
    normalizeCache,
    readDashboardViewCache,
    saveDashboardViewCache,
    stashDashboardPageSnapshot,
} from './dashboard/dashboard_cache.js';
import { dashboardDefaultRowsForType } from './dashboard/card_catalog.js';
import {
    closeDashboardEntityPicker,
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
export { resetDashboardEditingState } from './dashboard/editing_state.js';
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


initDashboardContext({
    getCache: () => _dashboardCache,
    getCurrentPageId: () => _currentPageId,
    getCurrentEditorId: () => _dashboardCurrentEditorId,
    apiCall,
});

initDashboardEditingState({
    abortDashboardPageNavigation,
    setDashboardRefreshIndicator,
    setEditMode: (value) => { _dashboardEditMode = value; },
    setCurrentEditorId: (id) => { _dashboardCurrentEditorId = id; },
    closeDashboardMenu,
    closeDashboardAddModal,
    closeDashboardPageModal,
    closeDashboardWidgetEditor,
    renderDashboard,
});

initDashboardAddPicker({
    requireDashboardEditAccess,
    closeDashboardMenu,
    ensureHyveviewEntitySeed,
    hvOpenEditor,
    saveDashboardWidgetFromEditor,
});

initDashboardYamlBridge({
    requireDashboardEditAccess,
    apiCall,
    t,
    showToast,
    loadDashboard,
    getActivePageId: activeDashboardPageId,
    getActivePageName: () => {
        const pid = activeDashboardPageId();
        const pages = Array.isArray(_dashboardCache.pages) ? _dashboardCache.pages : [];
        const found = pages.find(p => p && String(p.id) === String(pid));
        return (found && found.title) || _dashboardCache.title || pid || '';
    },
});

initDashboardPanelDelete({
    requireDashboardEditAccess,
    showConfirm,
    getCurrentPageId: () => _currentPageId,
    refreshAvailableEntities,
    renderDashboard,
    showToast,
    t,
});

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
    getCurrentPageId: activeDashboardPageId,
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
    getActivePageId: activeDashboardPageId,
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
    dashboardDefaultRowsForType,
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
    getAvailableEntity: dashboardAvailableEntity,
    renderWidgetCardForPreview: renderWidgetCardForPreview,
    climateEntityRecordsForSave,
    t,
});

initDashboardWidgetAddModal({
    requireDashboardEditAccess,
    closeDashboardMenu,
    closeDashboardWidgetEditor,
    getCurrentPageId: activeDashboardPageId,
    getCurrentEditorId: () => _dashboardCurrentEditorId,
    clearCurrentEditorId: () => { _dashboardCurrentEditorId = null; },
    getAvailableEntity: dashboardAvailableEntity,
    dashboardEditorRenderer: dashboardEditorRendererForType,
    dashboardDefaultRowsForType,
    loadDashboardCardCatalog: fetchDashboardCardCatalog,
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
    getCurrentPageId: activeDashboardPageId,
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
