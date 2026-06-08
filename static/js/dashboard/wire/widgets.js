/**
 * Widget editor, entity picker, climate, and card action wiring.
 */

import { apiCall } from '../../api.js';
import { showToast } from '../../utils.js';
import { t } from '../../lang/index.js';
import { widgetTitle } from '/static/hyveview/host.js';
import { escapeHtml, stateOn, dashApiError } from '../helpers.js';
import { requireDashboardEditAccess } from '../edit_access.js';
import { HVBridge } from '../hyveview_setup.js';
import { closeDashboardMenu } from '../dashboard_menu.js';
import { closeDashboardWidgetEditor, initDashboardWidgetLegacyEdit } from '../widget_legacy_edit.js';
import { initDashboardWidgetAddEditor, renderDashboardAddPreview } from '../widget_add_editor.js';
import { initDashboardWidgetAddModal } from '../widget_add_modal.js';
import { initDashboardWidgetEditorBridge } from '../widget_editor_bridge.js';
import { initDashboardEntityPicker, resolveEntityMatch } from '../entity_picker.js';
import { initDashboardWidgetActions } from '../widget_actions.js';
import { initDashboardClimate } from '../climate.js';
import {
    widgetDragAttrs,
    widgetEditControls,
    widgetSizeClass,
    renderWidgetCardForPreview,
} from '../widget_cards.js';
import { entityIcon } from '../widget_meta.js';
import { findWidget } from '../widget_store.js';
import {
    loadDashboard,
    readDashboardSectionFallback,
    refreshAvailableEntities,
    writeDashboardSectionFallback,
} from '../dashboard_loader.js';
import {
    activeDashboardPageId,
    dashboardAvailableEntity,
    dashboardEditorRendererForType,
    fetchDashboardCardCatalog,
} from '../dashboard_context.js';
import { dashboardDefaultRowsForType } from '../card_catalog.js';
import {
    controlPending,
    setPendingControl,
    deletePendingControl,
} from '../control_state.js';
import {
    snapshotDashboardEntityState,
    restoreDashboardEntitySnapshot,
    patchDashboardEntityState,
} from '../widget_toggle.js';
import { tryFastPathForEntities } from '../live_bridge.js';
import { renderDashboard } from '../dashboard_render.js';
import {
    clearDashboardClimateEntitySelection,
    addDashboardClimateEntityId,
    climateEntityRecordsForSave,
    renderDashboardClimateEntityChips,
} from '../climate.js';
import {
    getDashboardCache,
    getDashboardEditMode,
    getDashboardCurrentEditorId,
    setDashboardCurrentEditorId,
    currentPageIdWithCacheFallback,
} from '../dashboard_state.js';

export function wireDashboardWidgets() {
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
