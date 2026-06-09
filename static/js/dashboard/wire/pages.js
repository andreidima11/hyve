/**
 * Multi-page navigation and page/panel modal wiring.
 */
import { t } from '../../lang/index.js';
import { showToast } from '../../utils.js';
import { escapeHtml } from '../helpers.js';
import { iconClass } from '../widget_meta.js';
import { requireDashboardEditAccess } from '../edit_access.js';
import { switchTab, closeSidebar, isSidebarOpen } from '../../nav_bridge.js';
import { initDashboardPagesNav } from '../pages_nav.js';
import { initDashboardPanelModal } from '../panel_modal.js';
import { initDashboardPageModal } from '../page_modal.js';
import { abortPendingLoad, loadDashboard, refreshAvailableEntities, } from '../dashboard_loader.js';
import { closeDashboardMenu } from '../dashboard_menu.js';
import { syncPreferenceControls } from '../dashboard_preferences.js';
import { renderDashboardPagesList } from '../pages_nav.js';
import { selectDashboardPage } from '../page_select.js';
import { renderDashboard } from '../dashboard_render.js';
import { readDashboardViewCache } from '../dashboard_cache.js';
import { getDashboardCache, getCurrentPageId, setCurrentPageId, } from '../dashboard_state.js';
export function wireDashboardPages() {
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
        isSidebarOpen: () => !!isSidebarOpen(),
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
}
