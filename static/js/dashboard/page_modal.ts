/**
 * Dashboard page create/edit modal (title, icon, columns, default page).
 */

import { apiCall } from '../api.js';
import { showConfirm, showToast, syncModalViewportMetrics } from '../utils.js';
import { DEFAULT_PREFS, DEFAULT_META, DASHBOARD_LAST_PAGE_KEY } from './constants.js';
import { dashApiError } from './helpers.js';
import { enhanceDashboardCustomSelects } from './custom_selects.js';
import { setHashForPage } from './pages_nav.js';
import type { DashboardCache, DashboardPageModalDeps } from '../types/dashboard.js';

let _deps: DashboardPageModalDeps | null = null;
let _pageEditorMode: 'create' | 'edit' = 'edit';

function deps(): DashboardPageModalDeps {
    if (!_deps) throw new Error('Dashboard page modal not initialized');
    return _deps;
}

export function initDashboardPageModal(depsIn: DashboardPageModalDeps): void {
    _deps = depsIn;
}

function mergeCreatedPageIntoCache(createdPage: Record<string, unknown> | null | undefined, newId: string | null | undefined): void {
    const d = deps();
    if (!newId) return;
    d.setCurrentPageId(String(newId));
    try { localStorage.setItem(DASHBOARD_LAST_PAGE_KEY, String(newId)); } catch (_) {}
    setHashForPage(String(newId));
    const cache = d.getDashboardCache();
    if (!createdPage || typeof createdPage !== 'object') return;
    if (createdPage.title) {
        cache.title = String(createdPage.title);
        try { localStorage.setItem('hyve.lastDashboardTitle', cache.title); } catch (_) {}
    }
    if (createdPage.icon != null) cache.icon = String(createdPage.icon || '');
    if (createdPage.columns != null) cache.columns = Number(createdPage.columns) || 0;
    const pages = Array.isArray(cache.pages) ? [...cache.pages] : [];
    const idx = pages.findIndex(p => p && String(p.id) === String(newId));
    const merged = { ...(idx >= 0 ? pages[idx] : {}), ...createdPage, id: String(newId) };
    if (idx >= 0) pages[idx] = merged;
    else pages.push(merged);
    cache.pages = pages;
}

export function openDashboardPageModal(opts: { create?: boolean } = {}): void {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    d.closeDashboardMenu();
    syncModalViewportMetrics();
    const modal = document.getElementById('dashboard-page-modal');
    if (!modal) return;
    const createMode = !!(opts && opts.create);
    _pageEditorMode = createMode ? 'create' : 'edit';
    const cache = d.getDashboardCache();
    const currentPageId = d.getCurrentPageId();

    const titleInput = document.getElementById('dashboard-page-title-input') as HTMLInputElement | null;
    const iconInput = document.getElementById('dashboard-page-icon-input') as HTMLInputElement | null;
    const columnsInput = document.getElementById('dashboard-page-columns') as HTMLSelectElement | HTMLInputElement | null;
    const layoutInput = document.getElementById('dashboard-page-layout-mode') as HTMLSelectElement | null;
    const hideInput = document.getElementById('dashboard-page-hide-unavailable') as HTMLInputElement | null;
    const titleEl = document.getElementById('dashboard-page-modal-title');
    const saveBtn = document.getElementById('dashboard-page-save-btn');
    const defaultInput = document.getElementById('dashboard-page-default-input') as HTMLInputElement | null;

    if (createMode) {
        if (titleEl) titleEl.textContent = d.t('dashboard.new_page') || 'New page';
        if (saveBtn) saveBtn.textContent = d.t('dashboard.create') || 'Create';
        if (titleInput) titleInput.value = '';
        if (iconInput) iconInput.value = 'fa-table-cells-large';
        if (columnsInput) columnsInput.value = '0';
        if (layoutInput) layoutInput.value = DEFAULT_PREFS.layout_mode;
        if (hideInput) hideInput.checked = false;
    } else {
        if (titleEl) titleEl.textContent = d.t('dashboard.edit_page') || 'Edit page';
        if (saveBtn) saveBtn.textContent = d.t('common.save') || 'Save';
        if (titleInput) titleInput.value = cache.title || DEFAULT_META.title;
        if (iconInput) iconInput.value = cache.icon || 'fa-table-cells-large';
        if (columnsInput) columnsInput.value = String(cache.columns || 0);
        if (layoutInput) layoutInput.value = cache.preferences?.layout_mode || DEFAULT_PREFS.layout_mode;
        if (hideInput) hideInput.checked = !(cache.preferences?.show_unavailable ?? DEFAULT_PREFS.show_unavailable);
    }

    const delBtn = document.getElementById('dashboard-page-delete-btn');
    if (delBtn) {
        const pages = Array.isArray(cache.pages) ? cache.pages : [];
        const canDelete = !createMode && pages.length >= 2 && !!currentPageId;
        delBtn.classList.toggle('hidden', !canDelete);
    }

    if (defaultInput) {
        const row = defaultInput.closest('label');
        if (row) row.classList.toggle('hidden', createMode);
        const activeId = currentPageId || cache.current_page_id || cache.page_id;
        defaultInput.checked = !createMode && !!cache.default_page_id
            && String(cache.default_page_id) === String(activeId);
    }

    enhanceDashboardCustomSelects(modal);

    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (titleInput) try { titleInput.focus(); } catch (_) {}
}

export function closeDashboardPageModal(): void {
    const modal = document.getElementById('dashboard-page-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

export async function createDashboardPage(): Promise<void> {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    openDashboardPageModal({ create: true });
}

export async function saveDashboardHeader(): Promise<void> {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    const cache = d.getDashboardCache();
    const titleInput = (document.getElementById('dashboard-page-title-input') || document.getElementById('dashboard-title-input')) as HTMLInputElement | null;
    const iconInput = document.getElementById('dashboard-page-icon-input') as HTMLInputElement | null;
    const columnsInput = document.getElementById('dashboard-page-columns') as HTMLSelectElement | HTMLInputElement | null;
    const layoutInput = document.getElementById('dashboard-page-layout-mode') as HTMLSelectElement | null;
    const hideInput = document.getElementById('dashboard-page-hide-unavailable') as HTMLInputElement | null;

    const newTitle = (titleInput?.value || DEFAULT_META.title).trim() || DEFAULT_META.title;
    const newIcon = (iconInput?.value || cache.icon || 'fa-table-cells-large').trim();
    const newColumns = Number(columnsInput?.value || 0) || 0;

    cache.title = newTitle;
    cache.icon = newIcon;
    cache.columns = newColumns;
    cache.preferences = {
        ...DEFAULT_PREFS,
        ...(cache.preferences || {}),
        layout_mode: layoutInput?.value || cache.preferences?.layout_mode || DEFAULT_PREFS.layout_mode,
        show_unavailable: !(hideInput?.checked),
    };

    const pageId = d.getCurrentPageId() || cache.current_page_id || cache.page_id;

    if (_pageEditorMode === 'create') {
        const typedTitle = (titleInput?.value || '').trim();
        if (!typedTitle) {
            showToast(d.t('dashboard.title_required') || 'Pagina trebuie să aibă un titlu.', 'warning');
            try { titleInput?.focus(); } catch (_) {}
            return;
        }
        try {
            const res = await apiCall('/api/dashboard/pages', {
                method: 'POST',
                body: {
                    title: typedTitle,
                    icon: newIcon,
                    columns: newColumns,
                },
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(dashApiError(err.detail, 'dashboard.page_create_error'));
            }
            const data = await res.json().catch(() => ({}));
            const newId = data?.page?.id || data?.current_page_id;
            _pageEditorMode = 'edit';
            closeDashboardPageModal();
            if (newId) {
                d.abortPendingLoad();
                mergeCreatedPageIntoCache(data?.page, newId);
                d.syncPreferenceControls();
                d.renderDashboardPagesList();
                await d.selectDashboardPage(newId);
            } else {
                await d.loadDashboard();
            }
            showToast(d.t('dashboard.page_created'), 'success');
        } catch (e) {
            const message = e instanceof Error ? e.message : d.t('dashboard.page_create_error');
            showToast(message, 'error');
        }
        return;
    }

    try {
        let renamedToId = null;
        if (pageId) {
            const pageRes = await apiCall(`/api/dashboard/pages/${encodeURIComponent(pageId)}`, {
                method: 'PATCH',
                body: {
                    title: newTitle,
                    icon: newIcon,
                    columns: newColumns,
                },
            });
            if (!pageRes.ok && pageRes.status !== 404) {
                const err = await pageRes.json().catch(() => ({}));
                throw new Error(dashApiError(err.detail, 'dashboard.save_page_failed'));
            }
            const pageData = pageRes.ok ? await pageRes.json().catch(() => ({})) : {};
            const newId = pageData?.page?.id;
            if (newId && newId !== pageId) {
                renamedToId = newId;
            }
        }

        await apiCall('/api/dashboard/preferences', {
            method: 'PATCH',
            body: {
                ...DEFAULT_PREFS,
                ...(cache.preferences || {}),
                title: newTitle,
                icon: newIcon,
            },
        }).catch(() => null);

        const defaultInput = document.getElementById('dashboard-page-default-input') as HTMLInputElement | null;
        if (defaultInput) {
            const wantDefault = !!defaultInput.checked;
            const effectiveId = renamedToId || pageId;
            const isDefault = String(cache.default_page_id || '') === String(effectiveId);
            if (wantDefault !== isDefault) {
                await apiCall('/api/dashboard/preferences/default-page', {
                    method: 'PATCH',
                    body: { page_id: wantDefault ? effectiveId : null },
                }).catch(() => null);
            }
        }

        closeDashboardPageModal();
        if (renamedToId) {
            d.setCurrentPageId(renamedToId);
            await d.loadDashboard();
            await d.selectDashboardPage(renamedToId);
        } else {
            await d.loadDashboard();
        }
        showToast(d.t('dashboard.page_settings_saved') || 'Page settings saved', 'success');
    } catch (e) {
        const message = e instanceof Error ? e.message : (d.t('dashboard.page_save_error') || 'Could not save page');
        showToast(message, 'error');
    }
}

export async function deleteDashboardPage(): Promise<void> {
    const d = deps();
    if (!d.requireDashboardEditAccess()) return;
    const cache = d.getDashboardCache();
    const pageId = d.getCurrentPageId() || cache.current_page_id || cache.page_id;
    if (!pageId) return;
    const pages = Array.isArray(cache.pages) ? cache.pages : [];
    if (pages.length <= 1) {
        showToast(d.t('dashboard.min_one_page') || 'At least one dashboard page must remain.', 'warning');
        return;
    }
    if (!(await showConfirm(d.t('dashboard.delete_page_confirm') || 'Delete the current page? Its cards and panels will be removed.'))) return;
    try {
        const res = await apiCall(`/api/dashboard/pages/${encodeURIComponent(pageId)}`, { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || (d.t('dashboard.page_delete_error') || 'Could not delete page'));
        }
        const data = await res.json().catch(() => ({}));
        const nextId = data.current_page_id || (pages.find(p => p.id !== pageId)?.id) || null;
        closeDashboardPageModal();
        if (nextId) {
            await d.selectDashboardPage(nextId);
        } else {
            await d.loadDashboard();
        }
        showToast(d.t('dashboard.page_deleted') || 'Page deleted', 'success');
    } catch (e) {
        const message = e instanceof Error ? e.message : (d.t('dashboard.page_delete_error') || 'Could not delete page');
        showToast(message, 'error');
    }
}
