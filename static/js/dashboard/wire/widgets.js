/**
 * Widget editor, entity picker, climate, and card action wiring.
 */
import { apiCall } from '../../api.js';
import { showToast } from '../../utils.js';
import { t } from '../../lang/index.js';
import { widgetTitle } from '/static/hyveview/host.js';
import { escapeHtml, stateOn, dashApiError } from '../helpers.js';
import { HVBridge } from '../hyveview_setup.js';
import { initDashboardWidgetEditorBridge } from '../widget_editor_bridge.js';
import { initDashboardEntityPicker, resolveEntityMatch } from '../entity_picker.js';
import { initDashboardWidgetActions } from '../widget_actions.js';
import { initDashboardClimate } from '../climate.js';
import { widgetDragAttrs, widgetEditControls, widgetSizeClass, } from '../widget_cards.js';
import { entityIcon } from '../widget_meta.js';
import { findWidget } from '../widget_store.js';
import { loadDashboard, readDashboardSectionFallback, refreshAvailableEntities, writeDashboardSectionFallback, } from '../dashboard_loader.js';
import { activeDashboardPageId } from '../dashboard_context.js';
import { controlPending, setPendingControl, deletePendingControl, } from '../control_state.js';
import { snapshotDashboardEntityState, restoreDashboardEntitySnapshot, patchDashboardEntityState, } from '../widget_toggle.js';
import { tryFastPathForEntities } from '../live_bridge.js';
import { renderDashboard } from '../dashboard_render.js';
import { addDashboardClimateEntityId } from '../climate.js';
import { getDashboardCache, getDashboardEditMode, currentPageIdWithCacheFallback, } from '../dashboard_state.js';
import { requireDashboardEditAccess } from '../edit_access.js';
export function wireDashboardWidgets() {
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
    });
    initDashboardClimate({
        getCache: getDashboardCache,
        findWidget,
        renderDashboard,
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
