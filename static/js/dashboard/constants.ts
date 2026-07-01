/** Shared dashboard constants (extracted from dashboard.js). */

import type { DashboardMeta, DashboardPrefs } from '../types/dashboard.js';

export const DEFAULT_PREFS: DashboardPrefs = {
    show_unavailable: true,
};

/**
 * Desktop section columns for a page: how many sections sit side by side.
 * 0 = auto → follow the number of sections (fallback), clamped to 1..4.
 */
export function effectivePageColumns(raw: number | null | undefined, fallback = 4): number {
    const n = Number(raw || 0);
    if (n >= 1 && n <= 4) return n;
    const fb = Math.round(Number(fallback) || 4);
    return Math.min(Math.max(fb, 1), 4);
}

export const DEFAULT_META: DashboardMeta = {
    title: 'Dashboard',
    subtitle: 'Acasă',
};

export const DASHBOARD_LOCAL_KEY = 'hyve_dashboard_local';
export const DASHBOARD_PAGES_NAV_KEY = 'hyve.dashboardPagesNav';
export const DASHBOARD_LAST_PAGE_KEY = 'hyve.lastDashboardPageId';
export const DASHBOARD_STANDALONE_PANEL_ID = '__standalone__';
export const DASHBOARD_OPTIMISTIC_GUARD_MS = 3500;
export const DASHBOARD_PENDING_VISUAL_MS = 260;
export const SECTION_COLS = 4;
export const DASHBOARD_COL_POINTS_MIN = 1;
export const DASHBOARD_COL_POINTS_MAX = 4;
export const DEFAULT_CAMERA_INTERVAL = 10;
export const DASHBOARD_GRID_COLS = 12;

export const DASHBOARD_CUSTOM_SELECT_IDS = new Set([
    'dashboard-widget-type',
    'dashboard-widget-size',
    'dashboard-widget-col-span',
    'dashboard-widget-row-span',
    'dashboard-widget-camera-mode',
    'dashboard-visibility-logic',
    'dashboard-page-columns',
]);
