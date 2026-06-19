/**
 * Event bindings, pull-to-refresh, drag/resize, and Hyveview card registration.
 */

import { apiCall } from '../../api.js';
import { showToast } from '../../utils.js';
import { t } from '../../lang/index.js';
import { registerHyveviewDashboardCards } from '../hyveview_setup.js';
import { initDashboardEventBindings } from '../event_bindings.js';
import { initDashboardPullToRefresh } from '../pull_refresh.js';
import { initDashboardDragResize, startDashboardDrag, startDashboardPanelDrag } from '../drag_resize.js';
import { closeDashboardMenu } from '../dashboard_menu.js';
import {
    toggleDashboardEditMode,
    saveDashboardPreferences,
} from '../dashboard_preferences.js';
import { openDashboardAddPicker } from '../add_picker.js';
import {
    createDashboardPage,
    openDashboardPageModal,
    closeDashboardPageModal,
    deleteDashboardPage,
    saveDashboardHeader,
} from '../page_modal.js';
import {
    openDashboardYamlEditor,
    closeDashboardYamlEditor,
    reloadDashboardYaml,
    saveDashboardYaml,
} from '../yaml_bridge.js';
import {
    closeDashboardPanelModal,
    saveDashboardPanel,
    setDashboardPanelSize,
    addDashboardPanelModalPage,
    openDashboardPanelCreator,
    openDashboardPanelEditor,
} from '../panel_modal.js';
import { removeDashboardPanel } from '../panel_delete.js';
import { selectDashboardPanelPage, renderDashboard } from '../dashboard_render.js';
import { openDashboardWidgetEditor } from '../widget_editor_bridge.js';
import { removeDashboardWidget } from '../widget_delete.js';
import {
    handleDashboardCardClick,
    handleDashboardCardKeydown,
} from '../widget_toggle.js';
import { selectDashboardPage } from '../page_select.js';
import { openDashboardPageNav } from '../pages_nav.js';
import { pickDashboardEntityOption } from '../entity_picker.js';
import {
    startDashboardClimateSwipe,
    adjustDashboardClimateTemperature,
    toggleDashboardClimateModeMenu,
    setDashboardClimateMode,
    selectDashboardClimateSlide,
    removeDashboardClimateEntity,
    updateDashboardClimateEntityMeta,
} from '../climate.js';
import {
    onDashboardLockAction,
    onDashboardVacuumAction,
    onDashboardLawnMowerAction,
    onDashboardBrightnessInput,
    onDashboardBrightnessChange,
    onDashboardNumberInput,
    onDashboardNumberChange,
    onDashboardSelectChange,
} from '../widget_actions.js';
import { dashboardWidgetEntityIds } from '../live_bridge.js';
import { loadDashboard, setDashboardRefreshIndicator, readDashboardSectionFallback, writeDashboardSectionFallback } from '../dashboard_loader.js';
import { findWidget } from '../widget_store.js';
import { dashboardPanelColSpan, widgetSpan } from '../widget_cards.js';
import { isDashboardStandalonePanel, ensureDashboardStandalonePanelLocal } from '../standalone_panel.js';
import {
    getDashboardCache,
    getDashboardEditMode,
    currentPageIdWithCacheFallback,
} from '../dashboard_state.js';

export function wireDashboardEvents(): void {
    initDashboardEventBindings({
        closeMenu: () => closeDashboardMenu(),
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
            if (event.type === 'keydown') handleDashboardCardKeydown(event as KeyboardEvent, widgetId);
            else handleDashboardCardClick(event, widgetId);
        },
        selectPage: ({ pageId }) => { selectDashboardPage(pageId); },
        openPageNav: ({ pageId }) => { openDashboardPageNav(pageId); },
        pickEntity: ({ mode, entityId }: { mode: string; entityId: string }) => pickDashboardEntityOption(mode as 'add' | 'edit', entityId),
        widgetDrag: ({ event, widgetId }) => startDashboardDrag(event, widgetId),
        panelDrag: ({ event, panelId }) => startDashboardPanelDrag(event, panelId),
        climateSwipeStart: ({ event, widgetId }) => startDashboardClimateSwipe(event, widgetId),
        climateAdjustTemp: ({ widgetId, entityId, delta }) => {
            adjustDashboardClimateTemperature(widgetId, delta, entityId);
        },
        climateToggleModeMenu: ({ event, widgetId, entityId }: { event: Event; widgetId: string; entityId: string }) => {
            toggleDashboardClimateModeMenu(widgetId, event as never, entityId);
        },
        climateSetMode: ({ widgetId, entityId, climateMode }: { widgetId: string; entityId: string; climateMode: string }) => {
            setDashboardClimateMode(widgetId, climateMode, entityId);
        },
        climateSelectSlide: ({ event, widgetId, slideIndex }: { event: Event; widgetId: string; slideIndex: number }) => {
            selectDashboardClimateSlide(widgetId, slideIndex, event as never);
        },
        climateRemoveEntity: ({ entityId }) => removeDashboardClimateEntity(entityId),
        climateEntityMeta: ({ entityId, field, event }: { entityId: string; field: string; event: Event }) => {
            updateDashboardClimateEntityMeta(entityId, field, (event.target as HTMLInputElement).value);
        },
        lockAction: ({ widgetId, action }) => { onDashboardLockAction(widgetId, action); },
        vacuumAction: ({ widgetId, action }) => { onDashboardVacuumAction(widgetId, action); },
        lawnMowerAction: ({ widgetId, action }) => { onDashboardLawnMowerAction(widgetId, action); },
        brightnessInput: ({ event, widgetId }) => onDashboardBrightnessInput(event, widgetId),
        brightnessChange: ({ event, widgetId }) => onDashboardBrightnessChange(event, widgetId),
        numberInput: ({ event, widgetId }) => onDashboardNumberInput(event, widgetId),
        numberChange: ({ event, widgetId }) => onDashboardNumberChange(event, widgetId),
        selectChange: ({ event, widgetId }) => { void onDashboardSelectChange(event, widgetId); },
    });

    registerHyveviewDashboardCards(dashboardWidgetEntityIds);

    initDashboardPullToRefresh({
        loadDashboard,
        selectDashboardPage,
        setRefreshIndicator: setDashboardRefreshIndicator,
        showToast,
        t,
        getCurrentPageId: currentPageIdWithCacheFallback,
        getEditMode: getDashboardEditMode,
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
}
