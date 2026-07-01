/**
 * Render stack wiring — preferences, toggle, live, visibility, cards, render, loader.
 */

import { t } from '../../lang/index.js';
import { escapeHtml, stateOn } from '../helpers.js';
import { applyDashboardEditAccess, canEditDashboard, requireDashboardEditAccess } from '../edit_access.js';
import { enhanceSparklines } from '../sparklines.js';
import {
    dashboardIntentAction,
    iconClass,
    isControllableDomain,
    isInfoDomain,
    widgetRenderer,
} from '../widget_meta.js';
import { dashboardDefaultRowsForType } from '../card_catalog.js';
import { HVBridge } from '../hyveview_setup.js';
import {
    filteredWidgets,
    initDashboardPreferences,
    syncPreferenceControls,
    updateStats,
} from '../dashboard_preferences.js';
import { initDashboardWidgetToggle } from '../widget_toggle.js';
import { controlPending, controlVisuallyPending } from '../control_state.js';
import { findWidget, dashboardWidgetById } from '../widget_store.js';
import {
    configureHyveviewMounted,
    connectDashboardLive,
    initDashboardLiveBridge,
    resumeDashboardCameras,
    tryFastPathForEntities,
} from '../live_bridge.js';
import { initDashboardVisibility } from '../dashboard_visibility.js';
import { cameraWidgetEntities, initDashboardWidgetCards } from '../widget_cards.js';
import { initDashboardRender, renderDashboard } from '../dashboard_render.js';
import {
    initDashboardLoader,
    readDashboardSectionFallback,
    writeDashboardSectionFallback,
} from '../dashboard_loader.js';
import { setEntitySelectState } from '../entity_picker.js';
import { isDashboardStandalonePanel } from '../standalone_panel.js';
import { closeDashboardMenu } from '../dashboard_menu.js';
import { resolveCurrentDashboardPageId, renderDashboardPagesList } from '../pages_nav.js';
import { activeDashboardPageId } from '../dashboard_context.js';
import { resetDashboardEditingState } from '../editing_state.js';
import { climateConfiguredIds } from '../climate.js';
import {
    getDashboardCache,
    setDashboardCache,
    getDashboardEditMode,
    setDashboardEditMode,
    getCurrentPageId,
    setCurrentPageId,
    withoutDashboardEditMode,
    renderCachedDashboardIfEmpty,
} from '../dashboard_state.js';

export function wireDashboardRender(): void {
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
        getCurrentPageId,
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
        getCache: getDashboardCache,
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
        controlVisuallyPending: (widgetId?: string) => controlVisuallyPending(widgetId ?? ''),
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
        setEntitySelectState,
        escapeHtml,
        t,
    });
}
