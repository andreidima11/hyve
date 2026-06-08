/**
 * Local standalone panel bucket for legacy single-grid widget layouts.
 */

import { DASHBOARD_STANDALONE_PANEL_ID } from './constants.js';
import { isDashboardStandalonePanel } from './dashboard_cache.js';

/** @type {object | null} */
let _deps = null;

function deps() {
    if (!_deps) throw new Error('Dashboard standalone panel not initialized');
    return _deps;
}

export function initDashboardStandalonePanel(depsIn) {
    _deps = depsIn;
}

export { isDashboardStandalonePanel };

export function makeDashboardStandalonePanel(widgets = []) {
    return {
        id: DASHBOARD_STANDALONE_PANEL_ID,
        title: '',
        size: 'wide',
        icon: '',
        pages: [],
        show_pagination: false,
        kind: 'standalone',
        widgets: Array.isArray(widgets) ? widgets : [],
    };
}

export function ensureDashboardStandalonePanelLocal() {
    const cache = deps().getCache();
    const panels = Array.isArray(cache.panels) ? cache.panels : [];
    let panel = panels.find(isDashboardStandalonePanel);
    if (panel) return panel;
    panel = makeDashboardStandalonePanel();
    panels.unshift(panel);
    cache.panels = panels;
    return panel;
}
