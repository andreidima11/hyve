/** Hyve app entry — wires boot, bindings, and nav bridge. */

import './custom_selects/generic.js';
import './features_custom_selects.js';
import { sendMessage } from './chat.js';
import { switchTab, closeSidebar, toggleSidebar, isSidebarOpen, openConfigSection } from './ui.js';
import { switchUserProfileTab, loadUserProfilePage } from './user_profile.js';
import { loadSessionsList } from './features.js';
import { initDashboardSidebarNav } from './dashboard.js';
import { registerNavBridge } from './nav_bridge.js';
import { initDomReadyBindings } from './bindings/index.js';
import {
    _lazyAction,
    _loadAppsModule,
    _loadAreasModule,
    _loadPlannerModule,
    _loadScenesModule,
    populateAppTab,
} from './boot/index.js';
import type { DelegatedEventHandlers } from './types/integration.js';

window.sendMessage = sendMessage;

window.addEventListener('DOMContentLoaded', () => {
    initDomReadyBindings();
});

registerNavBridge({
    switchTab,
    closeSidebar,
    toggleSidebar,
    isSidebarOpen,
    openConfigSection,
    switchUserProfileTab,
    loadUserProfilePage,
    populateAppTab,
    loadSessionsList,
    initDashboardSidebarNav,
    loadPlanner: _lazyAction(_loadPlannerModule, 'loadPlanner'),
    loadApps: _lazyAction(_loadAppsModule, 'loadApps'),
    loadScenes: _lazyAction(_loadScenesModule, 'loadScenes'),
    loadAreas: _lazyAction(_loadAreasModule, 'loadAreas'),
    closeAddonWebUI: () => _lazyAction(_loadAppsModule, 'closeAddonWebUI')(),
} as DelegatedEventHandlers);
