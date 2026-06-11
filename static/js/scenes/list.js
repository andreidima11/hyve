/**
 * Scenes UI — list, editor, activation.
 */
import { apiCall } from '../api.js';
import { showToast, showConfirm } from '../utils.js';
import { t } from '../lang/index.js';
import { sceneState } from './state.js';
import * as render from './render.js';
import { ensureEntityCatalog } from './editor.js';
export async function loadScenes() {
    const wrap = document.getElementById('scenes-list');
    if (wrap && !sceneState.scenesCache.length) {
        wrap.innerHTML = `<div class="col-span-full text-center text-xs text-slate-500 py-10">
            <i class="fas fa-spinner fa-spin mr-1.5"></i>${render._escapeHtml(t('scenes.loading'))}
        </div>`;
    }
    try {
        const res = await apiCall('/api/scenes');
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        sceneState.scenesCache = Array.isArray(data?.scenes) ? data.scenes : [];
        render._renderScenesList();
    }
    catch (e) {
        if (wrap) {
            wrap.innerHTML = `<div class="col-span-full text-center text-xs text-red-400 py-10">
                ${render._escapeHtml(t('scenes.load_failed', { message: e instanceof Error ? e.message : String(e) }))}
            </div>`;
        }
    }
}
export async function openScenesPage() {
    const page = document.getElementById('scenes-page');
    if (!page)
        return;
    page.classList.remove('hidden');
    page.classList.add('flex');
    await loadScenes();
    ensureEntityCatalog().catch(() => { });
}
export function closeScenesPage() {
    const page = document.getElementById('scenes-page');
    if (!page)
        return;
    page.classList.add('hidden');
    page.classList.remove('flex');
}
export async function deleteScene(sceneId, opts = {}) {
    if (!sceneId)
        return;
    if (!opts.skipConfirm) {
        const ok = await showConfirm(t('scenes.delete_confirm'));
        if (!ok)
            return;
    }
    try {
        const res = await apiCall(`/api/scenes/${encodeURIComponent(sceneId)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        showToast(t('scenes.deleted'), 'success');
        await loadScenes();
    }
    catch (e) {
        showToast(`${t('scenes.delete_failed')}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
}
export async function activateScene(sceneId) {
    if (!sceneId)
        return;
    try {
        const res = await apiCall(`/api/scenes/${encodeURIComponent(sceneId)}/activate`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.detail || `HTTP ${res.status}`);
        }
        const succeeded = Number(data?.succeeded || 0);
        const failed = Number(data?.failed || 0);
        const total = Number(data?.total || 0);
        if (failed === 0) {
            showToast(t('scenes.activated') + ' ' + t('scenes.activated_count', { succeeded, total }), 'success');
        }
        else {
            showToast(`${t('scenes.activated_with_errors')}: ${t('scenes.activated_errors_detail', { succeeded, failed })}`, 'warning');
        }
        loadScenes().catch(() => { });
    }
    catch (e) {
        showToast(`${t('scenes.activation_failed')}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
}
