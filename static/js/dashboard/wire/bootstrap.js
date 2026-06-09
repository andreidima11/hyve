/**
 * Bootstrap wiring — Hyveview host, context, editing, menus, page select, stores.
 */
import { apiCall } from '../../api.js';
import { showConfirm, showToast } from '../../utils.js';
import { t, tVacuumStatus } from '../../lang/index.js';
import { HVSetHost, hvOpenEditor } from '../hyveview_setup.js';
import { widgetIconSpec } from '../../icon_utils.js';
import { escapeHtml, stateOn } from '../helpers.js';
import { requireDashboardEditAccess } from '../edit_access.js';
import { weatherIcon, weatherIsNight, weatherVariant } from '../weather_host.js';
import { enhanceSparklinesIn, trendCache } from '../sparklines.js';
import { closeDashboardPageModal } from '../page_modal.js';
import { closeDashboardAddModal } from '../widget_add_modal.js';
import { closeDashboardWidgetEditor } from '../widget_legacy_edit.js';
import { ensureHyveviewEntitySeed, saveDashboardWidgetFromEditor } from '../widget_editor_bridge.js';
import { loadDashboard, readDashboardSectionFallback, refreshAvailableEntities, setDashboardRefreshIndicator, withDashboardTimeout, writeDashboardSectionFallback, } from '../dashboard_loader.js';
import { controlVisuallyPending } from '../control_state.js';
import { closeDashboardMenu, initDashboardMenu } from '../dashboard_menu.js';
import { initDashboardWidgetStore } from '../widget_store.js';
import { entityIcon, entityIconForState, iconClass } from '../widget_meta.js';
import { abortDashboardPageNavigation, initDashboardPageSelect } from '../page_select.js';
import { initDashboardStandalonePanel } from '../standalone_panel.js';
import { initDashboardWidgetDelete } from '../widget_delete.js';
import { initDashboardAddPicker } from '../add_picker.js';
import { initDashboardYamlBridge } from '../yaml_bridge.js';
import { initDashboardPanelDelete } from '../panel_delete.js';
import { initDashboardEditingState } from '../editing_state.js';
import { activeDashboardPageId, initDashboardContext } from '../dashboard_context.js';
import { getDashboardCache, setDashboardCache, setDashboardEditMode, getDashboardCurrentEditorId, setDashboardCurrentEditorId, getCurrentPageId, setCurrentPageId, } from '../dashboard_state.js';
import { publishDashboardHyveviewHost } from '../hyveview_host.js';
import { setHashForPage } from '../pages_nav.js';
import { renderDashboard } from '../dashboard_render.js';
import { closeDashboardClimateModeMenus } from '../climate.js';
export function wireDashboardBootstrap() {
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
        saveDashboardWidgetFromEditor: (result, opts) => saveDashboardWidgetFromEditor(result, opts),
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
            const found = pages.find((p) => p && String(p.id) === String(pid));
            return String((found && found.title) || getDashboardCache().title || pid || '');
        },
    });
    initDashboardPanelDelete({
        requireDashboardEditAccess,
        showConfirm: (message) => showConfirm(message),
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
        showConfirm: (message) => showConfirm(message),
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
}
