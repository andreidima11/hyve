/**
 * Areas (rooms/zones/floors) UI.
 */
import { apiCall } from '../api.js';
import { showToast, showConfirm } from '../utils.js';
import { t } from '../lang/index.js';
import type { HyveEntity } from '../types/entity.js';
import type { AreaEntityRef, HyveArea } from './state.js';
import { areaState } from './state.js';
import * as render from './render.js';
import { listShellErrorHtml, listShellLoadingHtml, wireConfigListSearch } from '../config/list_shell.js';

function _refreshAreasI18n() {
    if (!document.getElementById('areas-list')) return;
    render._renderAreas();
}

if (typeof window !== 'undefined') {
    window.addEventListener('hyve:i18n-bundles-loaded', _refreshAreasI18n);
}

function _ensureAreasSearch() {
    wireConfigListSearch('areas-search', (query) => {
        areaState.listFilter = query;
        render._renderAreas();
    });
}

export async function loadAreas() {
    _ensureAreasSearch();
    const list = document.getElementById('areas-list');
    if (list && !areaState.areasCache.length) {
        list.innerHTML = listShellLoadingHtml(render._esc(t('areas.loading')));
    }
    try {
        const res = await apiCall('/api/areas');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { areas?: HyveArea[] };
        areaState.areasCache = Array.isArray(data?.areas) ? data.areas : [];
        render._renderAreas();
    } catch (err) {
        console.error('loadAreas failed', err);
        if (list) list.innerHTML = listShellErrorHtml(render._esc(t('areas.load_list_error')));
    }
}

export async function syncAreasFromHA(btn?: Event | HTMLElement | null) {
    const button = (btn instanceof HTMLButtonElement) ? btn : (btn instanceof HTMLElement ? btn as HTMLButtonElement : null);
    if (button) { button.disabled = true; button.classList.add('opacity-60'); }
    try {
        const res = await apiCall('/api/areas/sync', { method: 'POST' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({})) as { detail?: string };
            throw new Error(err?.detail || `HTTP ${res.status}`);
        }
        const data = await res.json() as { synced?: number; removed?: number; areas?: HyveArea[] };
        const synced = Number(data?.synced || 0);
        const removed = Number(data?.removed || 0);
        const removedSuffix = removed ? t('areas.sync_removed_suffix', { count: removed }) : '';
        showToast(t('areas.sync_success_detail', { synced, removed: removedSuffix }), 'success');
        areaState.areasCache = Array.isArray(data?.areas) ? data.areas : [];
        render._renderAreas();
    } catch (err) {
        console.error('syncAreasFromHA failed', err);
        showToast(`${t('areas.sync_error')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
        if (button) { button.disabled = false; button.classList.remove('opacity-60'); }
    }
}
