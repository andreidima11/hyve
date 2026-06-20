/**
 * Bootstrap wiring — Hyveview host, context, editing, menus, page select, stores.
 */

import { apiCall } from '../../api.js';
import { showConfirm, showToast } from '../../utils.js';
import { t, tVacuumStatus, tLawnMowerStatus } from '../../lang/index.js';
import { HVSetHost, hvOpenEditor } from '../hyveview_setup.js';
import { widgetIconSpec } from '../../icon_utils.js';
import { escapeHtml, stateOn } from '../helpers.js';
import { requireDashboardEditAccess } from '../edit_access.js';
import { weatherIcon, weatherIsNight, weatherVariant } from '../weather_host.js';
import { enhanceSparklinesIn, trendCache } from '../sparklines.js';
import { closeDashboardPageModal } from '../page_modal.js';
import { ensureHyveviewEntitySeed, saveDashboardWidgetFromEditor } from '../widget_editor_bridge.js';
import {
    loadDashboard,
    readDashboardSectionFallback,
    refreshAvailableEntities,
    setDashboardRefreshIndicator,
    withDashboardTimeout,
    writeDashboardSectionFallback,
} from '../dashboard_loader.js';
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
import {
    getDashboardCache,
    setDashboardCache,
    setDashboardEditMode,
    getDashboardCurrentEditorId,
    setDashboardCurrentEditorId,
    getCurrentPageId,
    setCurrentPageId,
} from '../dashboard_state.js';
import { publishDashboardHyveviewHost } from '../hyveview_host.js';
import { setHashForPage } from '../pages_nav.js';
import { renderDashboard } from '../dashboard_render.js';
import { closeDashboardClimateModeMenus } from '../climate.js';
import { cardLikeFromEditor, describeInteractionPreview } from '../interactions/preview.js';

export function wireDashboardBootstrap(): void {
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
        tLawnMowerStatus,
        t,
        listDashboardPages: () => {
            const pages = getDashboardCache().pages || [];
            return pages
                .map((page) => ({
                    id: String(page?.id || '').trim(),
                    title: String(page?.title || page?.id || '').trim(),
                }))
                .filter((page) => page.id);
        },
        describeCardInteraction: (
            card: { entity?: string | null; type?: string; config?: Record<string, unknown> },
            gesture: 'tap' | 'double_tap' | 'hold',
            override?: Record<string, unknown> | null,
        ) => {
            const widget = cardLikeFromEditor(card);
            return describeInteractionPreview(
                widget,
                gesture,
                override as Parameters<typeof describeInteractionPreview>[2],
            );
        },
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
        closeDashboardPageModal,
        renderDashboard,
    });

    initDashboardAddPicker({
        requireDashboardEditAccess,
        closeDashboardMenu,
        ensureHyveviewEntitySeed,
        hvOpenEditor,
        saveDashboardWidgetFromEditor: (
            result: unknown,
            opts?: { editingId?: string | null; original?: unknown },
        ) => saveDashboardWidgetFromEditor(result, opts as { editingId?: null; original?: null }),
    });

    initDashboardYamlBridge({
        requireDashboardEditAccess,
        apiCall,
        t,
        showToast,
        loadDashboard,
        getActivePageId: activeDashboardPageId,
        getActivePageName: (): string => {
            const pid = activeDashboardPageId();
            const pages = Array.isArray(getDashboardCache().pages) ? getDashboardCache().pages : [];
            const found = pages.find((p) => p && String(p.id) === String(pid));
            return String((found && found.title) || getDashboardCache().title || pid || '');
        },
    });

    initDashboardPanelDelete({
        requireDashboardEditAccess,
        showConfirm: (message: string) => showConfirm(message) as Promise<boolean>,
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
        showConfirm: (message: string) => showConfirm(message) as Promise<boolean>,
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
