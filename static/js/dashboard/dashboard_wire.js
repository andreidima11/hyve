/**
 * Wire all dashboard submodules — called once from dashboard.js after card registration.
 */

import { apiCall } from '../api.js';
import { showConfirm, showToast } from '../utils.js';
import { t, tVacuumStatus } from '../lang/index.js';
import { switchTab, closeSidebar, isSidebarOpen } from '../nav_bridge.js';
import { HVBridge, HVSetHost, hvOpenEditor, registerHyveviewDashboardCards } from './hyveview_setup.js';
import { widgetTitle } from '/static/hyveview/host.js';
import { widgetIconSpec } from '../icon_utils.js';
import { dashApiError, escapeHtml, stateOn } from './helpers.js';
import { initDashboardWidgetActions, onDashboardBrightnessInput, onDashboardBrightnessChange, onDashboardLockAction, onDashboardVacuumAction } from './widget_actions.js';
import { initDashboardDragResize, startDashboardDrag, startDashboardPanelDrag } from './drag_resize.js';
import { applyDashboardEditAccess, canEditDashboard, requireDashboardEditAccess } from './edit_access.js';
import { initDashboardEventBindings } from './event_bindings.js';
import {
    initDashboardPagesNav,
    openDashboardPageNav,
    renderDashboardPagesList,
    setHashForPage,
    resolveCurrentDashboardPageId,
} from './pages_nav.js';
import { weatherIcon, weatherIsNight, weatherVariant } from './weather_host.js';
import { enhanceSparklines, enhanceSparklinesIn, trendCache } from './sparklines.js';
import {
    addDashboardPanelModalPage,
    closeDashboardPanelModal,
    initDashboardPanelModal,
    openDashboardPanelCreator,
    openDashboardPanelEditor,
    saveDashboardPanel,
    setDashboardPanelSize,
} from './panel_modal.js';
import {
    closeDashboardPageModal,
    createDashboardPage,
    deleteDashboardPage,
    initDashboardPageModal,
    openDashboardPageModal,
    saveDashboardHeader,
} from './page_modal.js';
import {
    abortPendingLoad,
    initDashboardLoader,
    loadDashboard,
    readDashboardSectionFallback,
    refreshAvailableEntities,
    setDashboardRefreshIndicator,
    withDashboardTimeout,
    writeDashboardSectionFallback,
} from './dashboard_loader.js';
import {
    initDashboardWidgetAddEditor,
    renderDashboardAddPreview,
} from './widget_add_editor.js';
import {
    addDashboardSwitch,
    closeDashboardAddModal,
    initDashboardWidgetAddModal,
    updateDashboardEntityOptions,
} from './widget_add_modal.js';
import {
    closeDashboardWidgetEditor,
    initDashboardWidgetLegacyEdit,
} from './widget_legacy_edit.js';
import {
    ensureHyveviewEntitySeed,
    initDashboardWidgetEditorBridge,
    openDashboardWidgetEditor,
    saveDashboardWidgetFromEditor,
} from './widget_editor_bridge.js';
import { initDashboardVisibility } from './dashboard_visibility.js';
import {
    cameraWidgetEntities,
    dashboardPanelColSpan,
    initDashboardWidgetCards,
    renderWidgetCardForPreview,
    widgetDragAttrs,
    widgetEditControls,
    widgetSizeClass,
    widgetSpan,
} from './widget_cards.js';
import {
    initDashboardRender,
    renderDashboard,
    selectDashboardPanelPage,
} from './dashboard_render.js';
import {
    filteredWidgets,
    initDashboardPreferences,
    saveDashboardPreferences,
    syncPreferenceControls,
    toggleDashboardEditMode,
    toggleDashboardLayout,
    updateStats,
} from './dashboard_preferences.js';
import {
    handleDashboardCardClick,
    handleDashboardCardKeydown,
    initDashboardWidgetToggle,
    patchDashboardEntityState,
    restoreDashboardEntitySnapshot,
    snapshotDashboardEntityState,
} from './widget_toggle.js';
import {
    controlPending,
    controlVisuallyPending,
    setPendingControl,
    deletePendingControl,
} from './control_state.js';
import {
    configureHyveviewMounted,
    connectDashboardLive,
    dashboardWidgetEntityIds,
    initDashboardLiveBridge,
    resumeDashboardCameras,
    tryFastPathForEntities,
} from './live_bridge.js';
import {
    closeDashboardMenu,
    initDashboardMenu,
    toggleDashboardMenu,
} from './dashboard_menu.js';
import {
    dashboardWidgetById,
    findWidget,
    initDashboardWidgetStore,
} from './widget_store.js';
import {
    dashboardIntentAction,
    entityIcon,
    entityIconForState,
    iconClass,
    isControllableDomain,
    isInfoDomain,
    widgetRenderer,
} from './widget_meta.js';
import {
    abortDashboardPageNavigation,
    initDashboardPageSelect,
    selectDashboardPage,
} from './page_select.js';
import {
    ensureDashboardStandalonePanelLocal,
    initDashboardStandalonePanel,
    isDashboardStandalonePanel,
} from './standalone_panel.js';
import { initDashboardWidgetDelete, removeDashboardWidget } from './widget_delete.js';
import { initDashboardAddPicker, openDashboardAddPicker } from './add_picker.js';
import {
    closeDashboardYamlEditor,
    initDashboardYamlBridge,
    openDashboardYamlEditor,
    reloadDashboardYaml,
    saveDashboardYaml,
} from './yaml_bridge.js';
import { initDashboardPanelDelete, removeDashboardPanel } from './panel_delete.js';
import { initDashboardEditingState, resetDashboardEditingState } from './editing_state.js';
import {
    activeDashboardPageId,
    dashboardAvailableEntity,
    dashboardEditorRendererForType,
    fetchDashboardCardCatalog,
    initDashboardContext,
} from './dashboard_context.js';
import { readDashboardViewCache } from './dashboard_cache.js';
import { dashboardDefaultRowsForType } from './card_catalog.js';
import {
    initDashboardEntityPicker,
    pickDashboardEntityOption,
    resolveEntityMatch,
    setEntitySelectState,
} from './entity_picker.js';
import { initDashboardPullToRefresh } from './pull_refresh.js';
import {
    initDashboardClimate,
    climateConfiguredIds,
    toggleDashboardClimateModeMenu,
    selectDashboardClimateSlide,
    startDashboardClimateSwipe,
    adjustDashboardClimateTemperature,
    setDashboardClimateMode,
    updateDashboardClimateEntityMeta,
    removeDashboardClimateEntity,
    clearDashboardClimateEntitySelection,
    addDashboardClimateEntityId,
    climateEntityRecordsForSave,
    renderDashboardClimateEntityChips,
    closeDashboardClimateModeMenus,
} from './climate.js';
import {
    getDashboardCache,
    setDashboardCache,
    getDashboardEditMode,
    setDashboardEditMode,
    getDashboardCurrentEditorId,
    setDashboardCurrentEditorId,
    getCurrentPageId,
    setCurrentPageId,
    withoutDashboardEditMode,
    renderCachedDashboardIfEmpty,
    currentPageIdWithCacheFallback,
} from './dashboard_state.js';
import { publishDashboardHyveviewHost } from './hyveview_host.js';

export function wireDashboardModules() {
    publishDashboardHyveviewHost(HVSetHost, {
        iconClass,
        widgetIcon: widgetIconSpec,
        entityIcon,
        entityIconForState,
        escape: escapeHtml,
        enhanceSparklinesIn,
        trendCache,
        stateOn,
        controlVisuallyPending,
        weatherIcon,
        weatherVariant,
        weatherIsNight,
        tVacuumStatus,
        t,
    });

    initDashboardContext({
        getCache: getDashboardCache,
        getCurrentPageId,
        getCurrentEditorId: getDashboardCurrentEditorId,
        apiCall,
    });

    initDashboardEditingState({
        abortDashboardPageNavigation,
        setDashboardRefreshIndicator,
        setEditMode: setDashboardEditMode,
        setCurrentEditorId: setDashboardCurrentEditorId,
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
            const pages = Array.isArray(getDashboardCache().pages) ? getDashboardCache().pages : [];
            const found = pages.find(p => p && String(p.id) === String(pid));
            return (found && found.title) || getDashboardCache().title || pid || '';
        },
    });

    initDashboardPanelDelete({
        requireDashboardEditAccess,
        showConfirm,
        getCurrentPageId,
        refreshAvailableEntities,
        renderDashboard,
        showToast,
        t,
    });

    initDashboardMenu({ closeDashboardClimateModeMenus });

    initDashboardStandalonePanel({ getCache: getDashboardCache });

    initDashboardPageSelect({
        getCache: getDashboardCache,
        setCache: setDashboardCache,
        getCurrentPageId,
        setCurrentPageId,
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
        getCache: getDashboardCache,
        getCurrentPageId,
        renderDashboard,
        readDashboardSectionFallback,
        writeDashboardSectionFallback,
    });

    initDashboardPreferences({
        getCache: getDashboardCache,
        getCurrentPageId: activeDashboardPageId,
        getEditMode: getDashboardEditMode,
        setEditMode: setDashboardEditMode,
        requireDashboardEditAccess,
        resolveCurrentDashboardPageId,
        closeDashboardMenu,
        renderDashboard,
        readDashboardSectionFallback,
        writeDashboardSectionFallback,
        t,
    });

    initDashboardWidgetToggle({
        getCache: getDashboardCache,
        getEditMode: getDashboardEditMode,
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
        getCache: getDashboardCache,
        climateConfiguredIds,
        cameraWidgetEntities,
        widgetRenderer,
        widgetById: dashboardWidgetById,
        renderDashboard,
    });

    initDashboardVisibility({
        getEditMode: getDashboardEditMode,
        renderDashboard,
    });

    initDashboardWidgetCards({
        getCache: getDashboardCache,
        getEditMode: getDashboardEditMode,
        withoutEditMode: withoutDashboardEditMode,
        widgetRenderer,
        dashboardDefaultRowsForType,
        escapeHtml,
        stateOn,
        controlVisuallyPending,
        HVBridge,
        t,
    });

    initDashboardRender({
        getCache: getDashboardCache,
        getEditMode: getDashboardEditMode,
        syncPreferenceControls,
        updateStats,
        renderDashboardPagesList,
        isStandalonePanel: isDashboardStandalonePanel,
        filteredWidgets,
        escapeHtml,
        t,
        iconClass,
        enhanceSparklines,
        configureHyveviewMounted,
        resumeDashboardCameras,
    });

    initDashboardLoader({
        getDashboardCache,
        setDashboardCache,
        getCurrentPageId,
        setCurrentPageId,
        isControllableDomain,
        isInfoDomain,
        renderCachedDashboardIfEmpty: () => renderCachedDashboardIfEmpty(renderDashboard),
        renderDashboard,
        applyDashboardEditAccess,
        canEditDashboard,
        getEditMode: getDashboardEditMode,
        resetDashboardEditingState,
        resumeDashboardCameras,
        connectDashboardLive,
        configureHyveviewMounted,
        updateDashboardEntityOptions,
        setEntitySelectState,
        escapeHtml,
        t,
    });

    initDashboardPagesNav({
        getCurrentPageId,
        setCurrentPageId,
        getDashboardCache,
        setDashboardPages: (pages) => { getDashboardCache().pages = pages; },
        readDashboardViewCache,
        escape: escapeHtml,
        iconClass,
        selectDashboardPage,
        switchTab,
        closeSidebar,
        isSidebarOpen,
    });

    initDashboardPanelModal({
        requireDashboardEditAccess,
        getDashboardCache,
        getCurrentPageId,
        refreshAvailableEntities,
        renderDashboard,
        closeDashboardMenu,
        t,
        showToast,
    });

    initDashboardPageModal({
        requireDashboardEditAccess,
        getDashboardCache,
        getCurrentPageId,
        setCurrentPageId,
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
        getCurrentPageId: currentPageIdWithCacheFallback,
    });

    initDashboardDragResize({
        getCache: getDashboardCache,
        getCurrentPageId: currentPageIdWithCacheFallback,
        getEditMode: getDashboardEditMode,
        findWidget,
        widgetSpan,
        panelColSpan: dashboardPanelColSpan,
        isStandalonePanel: isDashboardStandalonePanel,
        ensureStandalonePanelLocal: ensureDashboardStandalonePanelLocal,
        renderDashboard,
        loadDashboard,
        readDashboardSectionFallback,
        writeDashboardSectionFallback,
        apiCall,
        t,
        showToast,
    });

    initDashboardWidgetAddEditor({
        getDashboardCache: getDashboardCache,
        getAvailableEntity: dashboardAvailableEntity,
        renderWidgetCardForPreview,
        climateEntityRecordsForSave,
        t,
    });

    initDashboardWidgetAddModal({
        requireDashboardEditAccess,
        closeDashboardMenu,
        closeDashboardWidgetEditor,
        getCurrentPageId: activeDashboardPageId,
        getCurrentEditorId: getDashboardCurrentEditorId,
        clearCurrentEditorId: () => { setDashboardCurrentEditorId(null); },
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
        getCurrentEditorId: getDashboardCurrentEditorId,
        readDashboardSectionFallback,
        writeDashboardSectionFallback,
        loadDashboard,
        t,
    });

    initDashboardWidgetEditorBridge({
        requireDashboardEditAccess,
        findWidget,
        getDashboardCache: getDashboardCache,
        getCurrentPageId: activeDashboardPageId,
        refreshAvailableEntities,
        loadDashboard,
        readDashboardSectionFallback,
        writeDashboardSectionFallback,
        t,
    });

    initDashboardEntityPicker({
        getCache: getDashboardCache,
        escapeHtml,
        t,
        entityIcon,
        addClimateEntityId: addDashboardClimateEntityId,
        renderDashboardAddPreview,
    });

    initDashboardClimate({
        getCache: getDashboardCache,
        findWidget,
        renderDashboard,
        renderDashboardAddPreview,
        getEditMode: getDashboardEditMode,
        widgetDragAttrs,
        widgetEditControls,
        widgetSizeClass,
        resolveEntityMatch,
        apiCall,
        t,
        showToast,
        dashApiError,
        escapeHtml,
        stateOn,
        widgetTitle,
        HVBridge,
        controlPending,
        setPendingControl,
        deletePendingControl,
        snapshotEntityState: snapshotDashboardEntityState,
        restoreEntitySnapshot: restoreDashboardEntitySnapshot,
        patchEntityState: patchDashboardEntityState,
        tryFastPathForEntities,
        getCurrentPageId: currentPageIdWithCacheFallback,
    });

    initDashboardWidgetActions({
        apiCall,
        t,
        showToast,
        findWidget,
        tryFastPathForEntities,
        renderDashboard,
    });
}
