/**
 * Scenes UI — list, editor, activation.
 */
import { apiCall } from '../api.js';
import { showToast, showConfirm } from '../utils.js';
import { t } from '../lang/index.js';
import { _MAX_ENTRIES, sceneState } from './state.js';
import * as render from './render.js';
import { loadScenes, deleteScene } from './list.js';
export async function ensureEntityCatalog(force = false) {
    if (sceneState.entityCatalogLoaded && !force)
        return sceneState.entityCatalog;
    try {
        const res = await apiCall('/api/integrations/all-entities');
        if (res?.ok) {
            const data = await res.json();
            sceneState.entityCatalog = Array.isArray(data?.entities) ? data.entities : [];
            sceneState.entityCatalogLoaded = true;
        }
    }
    catch (_) {
        sceneState.entityCatalog = [];
    }
    return sceneState.entityCatalog;
}
export async function openSceneEditor(sceneId = null) {
    const modal = document.getElementById('scene-editor-modal');
    if (!modal)
        return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    sceneState.editorState.mode = sceneId ? 'edit' : 'create';
    sceneState.editorState.sceneId = sceneId;
    sceneState.editorState.entries = [];
    const titleEl = document.getElementById('scene-editor-title');
    const deleteBtn = document.getElementById('scene-editor-delete');
    const nameEl = document.getElementById('scene-name');
    const descEl = document.getElementById('scene-description');
    const iconEl = document.getElementById('scene-icon');
    const colorEl = document.getElementById('scene-color');
    const enabledEl = document.getElementById('scene-enabled');
    const sharedRow = document.getElementById('scene-shared-row');
    const sharedEl = document.getElementById('scene-shared');
    if (titleEl) {
        const label = render._escapeHtml(sceneId ? t('scenes.editor_title_edit') : t('scenes.editor_title_new'));
        titleEl.innerHTML = `<i class="fas fa-clapperboard"></i><span>${label}</span>`;
    }
    if (deleteBtn)
        deleteBtn.classList.toggle('hidden', !sceneId);
    const isAdmin = !!window.currentUser?.is_admin;
    if (sharedRow)
        sharedRow.classList.toggle('hidden', !isAdmin);
    if (sceneId) {
        try {
            const res = await apiCall(`/api/scenes/${encodeURIComponent(sceneId)}`);
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const scene = await res.json();
            if (nameEl)
                nameEl.value = scene.name || '';
            if (descEl)
                descEl.value = scene.description || '';
            if (iconEl)
                iconEl.value = scene.icon || '';
            if (colorEl)
                colorEl.value = scene.color || '';
            if (enabledEl)
                enabledEl.checked = scene.enabled !== false;
            if (sharedEl)
                sharedEl.checked = !!scene.is_shared;
            sceneState.editorState.entries = Array.isArray(scene.entries) ? scene.entries.map(e => ({ ...e })) : [];
        }
        catch (e) {
            showToast(t('scenes.load_scene_failed', { message: e instanceof Error ? e.message : String(e) }), 'error');
            closeSceneEditor();
            return;
        }
    }
    else {
        if (nameEl)
            nameEl.value = '';
        if (descEl)
            descEl.value = '';
        if (iconEl)
            iconEl.value = 'fas fa-film';
        if (colorEl)
            colorEl.value = '';
        if (enabledEl)
            enabledEl.checked = true;
        if (sharedEl)
            sharedEl.checked = false;
        sceneState.editorState.entries = [];
    }
    render._renderEditorEntries();
    await ensureEntityCatalog();
}
export function closeSceneEditor() {
    const modal = document.getElementById('scene-editor-modal');
    if (!modal)
        return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    closeSceneEntityPicker();
}
export function addSceneEntry() {
    if (sceneState.editorState.entries.length >= _MAX_ENTRIES) {
        showToast(t('scenes.max_entries', { max: _MAX_ENTRIES }), 'warning');
        return;
    }
    try {
        sceneState.editorState.entries = render._readEditorEntriesFromDOM();
    }
    catch (_) { }
    sceneState.editorState.entries.push({ entity_id: '', service: 'turn_on' });
    render._renderEditorEntries();
}
export function removeSceneEntry(idx) {
    try {
        sceneState.editorState.entries = render._readEditorEntriesFromDOM();
    }
    catch (_) { }
    if (idx < 0 || idx >= sceneState.editorState.entries.length)
        return;
    sceneState.editorState.entries.splice(idx, 1);
    render._renderEditorEntries();
}
export async function saveScene() {
    const nameEl = document.getElementById('scene-name');
    const descEl = document.getElementById('scene-description');
    const iconEl = document.getElementById('scene-icon');
    const colorEl = document.getElementById('scene-color');
    const enabledEl = document.getElementById('scene-enabled');
    const sharedEl = document.getElementById('scene-shared');
    const name = (nameEl?.value || '').trim();
    if (!name) {
        showToast(t('scenes.name_required'), 'warning');
        return;
    }
    let entries;
    try {
        entries = render._readEditorEntriesFromDOM();
    }
    catch (e) {
        showToast(e instanceof Error ? e.message : String(e), 'error');
        return;
    }
    if (!entries.length) {
        showToast(t('scenes.entry_required'), 'warning');
        return;
    }
    const payload = {
        name,
        description: (descEl?.value || '').trim() || null,
        icon: (iconEl?.value || '').trim() || null,
        color: (colorEl?.value || '').trim() || null,
        enabled: !!enabledEl?.checked,
        is_shared: !!sharedEl?.checked,
        entries,
    };
    try {
        let res;
        if (sceneState.editorState.mode === 'edit' && sceneState.editorState.sceneId) {
            res = await apiCall(`/api/scenes/${encodeURIComponent(sceneState.editorState.sceneId)}`, {
                method: 'PUT', body: payload,
            });
        }
        else {
            res = await apiCall('/api/scenes', { method: 'POST', body: payload });
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        showToast(sceneState.editorState.mode === 'edit'
            ? (t('scenes.updated'))
            : (t('scenes.created')), 'success');
        closeSceneEditor();
        await loadScenes();
    }
    catch (e) {
        showToast(`${t('scenes.save_failed')}: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
}
export async function deleteSceneFromEditor() {
    if (!sceneState.editorState.sceneId)
        return;
    const ok = await showConfirm(t('scenes.delete_confirm_hard'));
    if (!ok)
        return;
    await deleteScene(sceneState.editorState.sceneId, { skipConfirm: true });
    closeSceneEditor();
}
export async function openSceneEntityPicker(targetIdx) {
    sceneState.editorState.entityPickerTargetIdx = targetIdx;
    try {
        sceneState.editorState.entries = render._readEditorEntriesFromDOM();
    }
    catch (_) { }
    const modal = document.getElementById('scene-entity-picker-modal');
    if (!modal)
        return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    await ensureEntityCatalog();
    render._renderEntityPickerList('');
    const search = document.getElementById('scene-entity-picker-search');
    if (search) {
        search.value = '';
        setTimeout(() => search.focus(), 50);
    }
}
export function closeSceneEntityPicker() {
    const modal = document.getElementById('scene-entity-picker-modal');
    if (!modal)
        return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    sceneState.editorState.entityPickerTargetIdx = -1;
}
export function filterSceneEntityPicker() {
    const q = document.getElementById('scene-entity-picker-search')?.value || '';
    render._renderEntityPickerList(q);
}
export function pickSceneEntity(entityId) {
    const idx = sceneState.editorState.entityPickerTargetIdx;
    if (idx < 0) {
        closeSceneEntityPicker();
        return;
    }
    try {
        sceneState.editorState.entries = render._readEditorEntriesFromDOM();
    }
    catch (_) { }
    if (idx >= sceneState.editorState.entries.length) {
        sceneState.editorState.entries.push({ entity_id: entityId, service: 'turn_on' });
    }
    else {
        sceneState.editorState.entries[idx] = { ...sceneState.editorState.entries[idx], entity_id: entityId };
    }
    closeSceneEntityPicker();
    render._renderEditorEntries();
}
