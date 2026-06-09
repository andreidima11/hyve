/**
 * Mutable dashboard orchestrator state (cache, edit mode, active page).
 */

import { DEFAULT_PREFS, DEFAULT_META } from './constants.js';
import { readDashboardViewCache } from './dashboard_cache.js';
import type { DashboardCache } from '../types/dashboard.js';

function emptyCache(): DashboardCache {
    return {
        widgets: [],
        available_entities: [],
        preferences: { ...DEFAULT_PREFS },
        title: DEFAULT_META.title,
        subtitle: DEFAULT_META.subtitle,
        pages: [],
        panels: [],
        page_id: null,
        current_page_id: null,
        icon: '',
        columns: 0,
    };
}

let _dashboardCache: DashboardCache = emptyCache();
let _dashboardEditMode = false;
let _dashboardCurrentEditorId: string | null = null;
let _currentPageId: string | null = null;

export function getDashboardCache(): DashboardCache {
    return _dashboardCache;
}

export function setDashboardCache(cache: DashboardCache): void {
    _dashboardCache = cache;
}

export function getDashboardEditMode(): boolean {
    return _dashboardEditMode;
}

export function setDashboardEditMode(value: boolean): void {
    _dashboardEditMode = value;
}

export function getDashboardCurrentEditorId(): string | null {
    return _dashboardCurrentEditorId;
}

export function setDashboardCurrentEditorId(id: string | null): void {
    _dashboardCurrentEditorId = id;
}

export function getCurrentPageId(): string | null {
    return _currentPageId;
}

export function setCurrentPageId(id: string | null): void {
    _currentPageId = id;
}

export function withoutDashboardEditMode<T>(fn: () => T): T {
    const was = _dashboardEditMode;
    _dashboardEditMode = false;
    try { return fn(); } finally { _dashboardEditMode = was; }
}

export function currentPageIdWithCacheFallback(): string {
    return _currentPageId || _dashboardCache.page_id || _dashboardCache.current_page_id || '';
}

/** Paint last view-cache snapshot when the grid is still empty. */
export function renderCachedDashboardIfEmpty(renderDashboard: () => void): boolean {
    const grid = document.getElementById('dashboard-grid');
    if (!grid || grid.firstElementChild) return false;
    const cached = readDashboardViewCache();
    if (!cached) return false;
    _dashboardCache = {
        ...cached,
        available_entities: Array.isArray(_dashboardCache.available_entities)
            ? _dashboardCache.available_entities
            : [],
    };
    if (_dashboardCache.page_id) _currentPageId = _dashboardCache.page_id;
    renderDashboard();
    return true;
}
