/**
 * Mutable dashboard orchestrator state (cache, edit mode, active page).
 */

import { DEFAULT_PREFS, DEFAULT_META } from './constants.js';
import { readDashboardViewCache } from './dashboard_cache.js';

function emptyCache() {
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

let _dashboardCache = emptyCache();
let _dashboardEditMode = false;
let _dashboardCurrentEditorId = null;
let _currentPageId = null;

export function getDashboardCache() {
    return _dashboardCache;
}

export function setDashboardCache(cache) {
    _dashboardCache = cache;
}

export function getDashboardEditMode() {
    return _dashboardEditMode;
}

export function setDashboardEditMode(value) {
    _dashboardEditMode = value;
}

export function getDashboardCurrentEditorId() {
    return _dashboardCurrentEditorId;
}

export function setDashboardCurrentEditorId(id) {
    _dashboardCurrentEditorId = id;
}

export function getCurrentPageId() {
    return _currentPageId;
}

export function setCurrentPageId(id) {
    _currentPageId = id;
}

export function withoutDashboardEditMode(fn) {
    const was = _dashboardEditMode;
    _dashboardEditMode = false;
    try { return fn(); } finally { _dashboardEditMode = was; }
}

export function currentPageIdWithCacheFallback() {
    return _currentPageId || _dashboardCache.page_id || _dashboardCache.current_page_id || '';
}

/** Paint last view-cache snapshot when the grid is still empty. */
export function renderCachedDashboardIfEmpty(renderDashboard) {
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
