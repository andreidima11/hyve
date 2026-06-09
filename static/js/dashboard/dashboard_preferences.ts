/**
 * Dashboard preferences UI — layout, filter, edit mode, and preference sync.
 */

import { apiCall } from '../api.js';
import { showToast } from '../utils.js';
import { DEFAULT_PREFS, DEFAULT_META } from './constants.js';
import { dashApiError } from './helpers.js';
import type { DashboardCache, DashboardPreferencesDeps } from '../types/dashboard.js';

let _deps: DashboardPreferencesDeps | null = null;

function deps(): DashboardPreferencesDeps {
    if (!_deps) throw new Error('Dashboard preferences not initialized');
    return _deps;
}

export function initDashboardPreferences(depsIn: DashboardPreferencesDeps) {
    _deps = depsIn;
}

export function syncPreferenceControls() {
    const d = deps();
    const cache = d.getCache();
    const prefs = cache.preferences || DEFAULT_PREFS;

    const titleEl = document.getElementById('dashboard-page-title');
    const titleInput = document.getElementById('dashboard-page-title-input') as HTMLInputElement | null;
    const pageLayoutInput = document.getElementById('dashboard-page-layout-mode') as HTMLSelectElement | null;
    const pageHideInput = document.getElementById('dashboard-page-hide-unavailable') as HTMLInputElement | null;
    const effectiveTitle = cache.title || DEFAULT_META.title;
    if (titleEl) titleEl.textContent = effectiveTitle;
    if (titleInput) titleInput.value = effectiveTitle;
    if (pageLayoutInput) pageLayoutInput.value = prefs.layout_mode || DEFAULT_PREFS.layout_mode;
    if (pageHideInput) pageHideInput.checked = !prefs.show_unavailable;

    const headerTitleEl = document.getElementById('current-view-title');
    if (headerTitleEl) {
        const onDashTab = (() => {
            const view = document.getElementById('view-dashboard');
            return !!view && !view.classList.contains('hidden');
        })();
        if (onDashTab) headerTitleEl.textContent = effectiveTitle;
    }
    try { if (effectiveTitle) localStorage.setItem('hyve.lastDashboardTitle', effectiveTitle); } catch (_) {}

    const activeId = d.getCurrentPageId();
    if (activeId && Array.isArray(cache.pages)) {
        const page = cache.pages.find(p => p && String(p.id) === String(activeId));
        if (page && page.title !== effectiveTitle) {
            page.title = effectiveTitle;
        }
    }

    const editMode = d.getEditMode();
    const editModeLabel = document.getElementById('dashboard-edit-mode-label');
    const editModeIcon = document.getElementById('dashboard-edit-mode-icon');
    if (editModeLabel) editModeLabel.textContent = editMode ? d.t('dashboard.done') : d.t('dashboard.edit_mode');
    if (editModeIcon) editModeIcon.className = editMode ? 'fas fa-check' : 'fas fa-pen-to-square';

    const editModeLabelMenu = document.getElementById('dashboard-edit-mode-label-menu');
    const editModeIconMenu = document.getElementById('dashboard-edit-mode-icon-menu');
    if (editModeLabelMenu) editModeLabelMenu.textContent = editMode ? d.t('dashboard.done') : d.t('common.edit');
    if (editModeIconMenu) editModeIconMenu.className = editMode ? 'fas fa-check w-4' : 'fas fa-pen-to-square w-4';
}

export function updateStats() {
    const cache = deps().getCache();
    const widgets = Array.isArray(cache.widgets) ? cache.widgets : [];
    const count = document.getElementById('dashboard-count');
    if (count) count.textContent = String(widgets.length);
}

export function filteredWidgets() {
    const cache = deps().getCache();
    return Array.isArray(cache.widgets) ? cache.widgets : [];
}

export function toggleDashboardEditMode() {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    d.resolveCurrentDashboardPageId();
    const next = !d.getEditMode();
    d.setEditMode(next);
    if (next) {
        document.documentElement.setAttribute('data-dashboard-editing', 'true');
    } else {
        document.documentElement.removeAttribute('data-dashboard-editing');
    }
    d.closeDashboardMenu();
    d.renderDashboard();
    showToast(next
        ? (d.t('dashboard.edit_mode_on') || 'Edit mode enabled')
        : (d.t('dashboard.edit_mode_off') || 'Edit mode disabled'), 'success');
}

export async function setDashboardFilter(mode: string) {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    const cache = d.getCache();
    cache.preferences = { ...DEFAULT_PREFS, ...(cache.preferences || {}), filter_mode: mode || 'all' };
    d.renderDashboard();
    await saveDashboardPreferences(true);
}

export async function toggleDashboardLayout() {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    const cache = d.getCache();
    const next = (cache.preferences?.layout_mode === 'compact') ? 'comfortable' : 'compact';
    cache.preferences = { ...DEFAULT_PREFS, ...(cache.preferences || {}), layout_mode: next };
    d.renderDashboard();
    await saveDashboardPreferences(true);
}

function _hideUnavailableFromUi(cache: DashboardCache) {
    const pageHide = document.getElementById('dashboard-page-hide-unavailable') as HTMLInputElement | null;
    if (pageHide) return !pageHide.checked;
    if (cache?.preferences && typeof cache.preferences.show_unavailable === 'boolean') {
        return cache.preferences.show_unavailable;
    }
    return DEFAULT_PREFS.show_unavailable;
}

export async function saveDashboardPreferences(silent = false) {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    const cache = d.getCache();
    const prefs = {
        ...DEFAULT_PREFS,
        ...(cache.preferences || {}),
        show_unavailable: _hideUnavailableFromUi(cache),
    };

    try {
        const res = await apiCall('/api/dashboard/preferences', {
            method: 'PATCH',
            body: {
                ...prefs,
                title: cache.title || DEFAULT_META.title,
                subtitle: cache.subtitle || DEFAULT_META.subtitle,
                icon: cache.icon || undefined,
            },
        });
        if (res.ok) {
            const data = await res.json().catch(() => ({})) as { preferences?: typeof prefs };
            cache.preferences = { ...DEFAULT_PREFS, ...(data.preferences || prefs) };
            d.renderDashboard();
            if (!silent) showToast(d.t('dashboard.preferences_saved'), 'success');
            return;
        }
        if (res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError(err.detail, 'dashboard.save_preferences_failed'));
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        if (!msg.includes(d.t('dashboard.save_widget_failed'))) {
            // continue to fallback
        }
    }

    const section = await d.readDashboardSectionFallback();
    section.preferences = prefs;
    await d.writeDashboardSectionFallback(section);
    cache.preferences = { ...DEFAULT_PREFS, ...(section.preferences as typeof prefs) };
    d.renderDashboard();
    if (!silent) showToast(d.t('dashboard.preferences_saved'), 'success');
}
