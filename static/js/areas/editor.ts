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

import { loadAreas } from './list.js';

function _ensureModalAtTopLevel() {
    const modal = document.getElementById('area-editor-modal');
    if (modal && modal.parentElement && modal.parentElement !== document.body) {
        document.body.appendChild(modal);
    }
    return modal;
}

function _openEditor(area: HyveArea | null) {
    const modal = _ensureModalAtTopLevel();
    if (!modal) {
        showToast(t('areas.modal_missing'), 'error');
        return;
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    const isEdit = !!area;
    const synced = !!(area && area.synced);
    areaState.editorState = {
        mode: isEdit ? 'edit' : 'create',
        areaId: isEdit ? area!.id : null,
        synced,
        entities: [],
    };

    try {
        const titleEl = document.getElementById('area-editor-title');
        if (titleEl) titleEl.innerHTML = `<i class="fas fa-house-chimney-window"></i><span>${render._esc(isEdit ? t('areas.editor_title_edit') : t('areas.editor_title_new'))}</span>`;

        const note = document.getElementById('area-editor-synced-note');
        if (note) note.classList.toggle('hidden', !synced);

        const deleteBtn = document.getElementById('area-editor-delete');
        if (deleteBtn) deleteBtn.classList.toggle('hidden', !isEdit || synced);

        const nameEl = document.getElementById('area-editor-name') as HTMLInputElement | null;
        const floorEl = document.getElementById('area-editor-floor') as HTMLInputElement | null;
        const iconEl = document.getElementById('area-editor-icon') as HTMLInputElement | null;
        const aliasesEl = document.getElementById('area-editor-aliases') as HTMLInputElement | null;
        if (nameEl) nameEl.value = area?.name || '';
        if (floorEl) floorEl.value = area?.floor || '';
        if (iconEl) iconEl.value = area?.icon || '';
        if (aliasesEl) aliasesEl.value = (Array.isArray(area?.aliases) ? area.aliases : []).join(', ');

        areaState.editorState.entities = Array.isArray(area?.extra_entities) ? [...area.extra_entities] : [];
        render._renderEditorEntities();
        _ensureEntitiesLoaded().catch(() => {});

        setTimeout(() => nameEl?.focus(), 50);
    } catch (err) {
        console.error('[areas] _openEditor populate failed', err);
    }
}
export function closeAreaEditor() {
    const modal = document.getElementById('area-editor-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

export function openCreateAreaModal() {
    _openEditor(null);
}

export function editArea(areaId: string) {
    const area = areaState.areasCache.find(a => a.id === areaId);
    if (!area) return;
    _openEditor(area);
}

export async function saveAreaFromEditor() {
    const nameEl = document.getElementById('area-editor-name') as HTMLInputElement | null;
    const floorEl = document.getElementById('area-editor-floor') as HTMLInputElement | null;
    const iconEl = document.getElementById('area-editor-icon') as HTMLInputElement | null;
    const aliasesEl = document.getElementById('area-editor-aliases') as HTMLInputElement | null;
    const name = (nameEl?.value || '').trim();
    if (!name) { showToast(t('areas.name_required'), 'error'); return; }
    const floor = (floorEl?.value || '').trim();
    const icon = (iconEl?.value || '').trim();
    const aliasesRaw = (aliasesEl?.value || '').trim();
    const aliases = aliasesRaw ? aliasesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

    const payload = {
        name,
        floor: floor || null,
        icon: icon || null,
        aliases,
        extra_entities: Array.isArray(areaState.editorState.entities) ? areaState.editorState.entities : [],
    };

    try {
        let res: Response;
        if (areaState.editorState.mode === 'edit' && areaState.editorState.areaId) {
            res = await apiCall(`/api/areas/${encodeURIComponent(areaState.editorState.areaId)}`, {
                method: 'PATCH',
                body: payload,
            });
        } else {
            res = await apiCall('/api/areas', {
                method: 'POST',
                body: payload,
            });
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({})) as { detail?: string };
            throw new Error(err?.detail || `HTTP ${res.status}`);
        }
        showToast(t('areas.saved'), 'success');
        closeAreaEditor();
        await loadAreas();
    } catch (err) {
        console.error('saveAreaFromEditor failed', err);
        showToast(`${t('common.error')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
}

export async function deleteArea(areaId: string) {
    const area = areaState.areasCache.find(a => a.id === areaId);
    if (!area) return;
    if (!(await showConfirm(t('areas.delete_confirm', { name: area.name })))) return;
    try {
        const res = await apiCall(`/api/areas/${encodeURIComponent(areaId)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({})) as { detail?: string };
            throw new Error(err?.detail || `HTTP ${res.status}`);
        }
        showToast(t('areas.deleted'), 'success');
        await loadAreas();
    } catch (err) {
        console.error('deleteArea failed', err);
        showToast(`${t('common.error')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
}

export async function deleteAreaFromEditor() {
    if (areaState.editorState.mode !== 'edit' || !areaState.editorState.areaId) return;
    const area = areaState.areasCache.find(a => a.id === areaState.editorState.areaId);
    if (!area) return;
    if (!(await showConfirm(t('areas.delete_confirm', { name: area.name })))) return;
    try {
        const res = await apiCall(`/api/areas/${encodeURIComponent(areaState.editorState.areaId)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({})) as { detail?: string };
            throw new Error(err?.detail || `HTTP ${res.status}`);
        }
        showToast(t('areas.deleted'), 'success');
        closeAreaEditor();
        await loadAreas();
    } catch (err) {
        console.error('deleteAreaFromEditor failed', err);
        showToast(`${t('common.error')}: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
}
async function _ensureEntitiesLoaded(force = false) {
    const fresh = (Date.now() - areaState.entitiesCacheTime) < 30_000;
    if (!force && fresh && areaState.allEntitiesCache.length) return areaState.allEntitiesCache;
    const res = await apiCall('/api/integrations/all-entities');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { entities?: AreaEntityRef[] };
    areaState.allEntitiesCache = Array.isArray(data?.entities) ? data.entities : [];
    areaState.entitiesCacheTime = Date.now();
    return areaState.allEntitiesCache;
}
export function removeAreaEditorEntity(eid: string) {
    areaState.editorState.entities = (areaState.editorState.entities || []).filter(x => x !== eid);
    render._renderEditorEntities();
}

export async function openAreaEntityPicker() {
    const modal = document.getElementById('area-entity-picker-modal');
    if (!modal) return;
    if (modal.parentElement !== document.body) document.body.appendChild(modal);
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    areaState.pickerSelected = new Set(areaState.editorState.entities || []);
    areaState.pickerFilter = '';
    const search = document.getElementById('area-entity-picker-search') as HTMLInputElement | null;
    if (search) search.value = '';

    const list = document.getElementById('area-entity-picker-list');
    if (list) list.innerHTML = `<div class="text-center text-xs text-slate-500 py-8"><i class="fas fa-spinner fa-spin mr-1.5"></i>${render._esc(t('areas.loading_entities'))}</div>`;

    try {
        await _ensureEntitiesLoaded();
        render._renderPickerList();
        setTimeout(() => search?.focus(), 50);
    } catch (err) {
        console.error('openAreaEntityPicker failed', err);
        if (list) list.innerHTML = `<div class="text-center text-xs text-rose-400 py-8">${render._esc(t('areas.load_entities_error'))}</div>`;
    }
}

export function closeAreaEntityPicker() {
    const modal = document.getElementById('area-entity-picker-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

export function filterAreaEntityPicker(value: string) {
    areaState.pickerFilter = String(value || '').trim().toLowerCase();
    render._renderPickerList();
}
export function toggleAreaPickerEntity(eid: string, checked: boolean) {
    if (checked) areaState.pickerSelected.add(eid);
    else areaState.pickerSelected.delete(eid);
    const counter = document.getElementById('area-entity-picker-count');
    if (counter) counter.textContent = t('areas.picker_selected_total', { selected: areaState.pickerSelected.size, total: areaState.allEntitiesCache.length });
}

export function confirmAreaEntityPicker() {
    areaState.editorState.entities = Array.from(areaState.pickerSelected);
    render._renderEditorEntities();
    closeAreaEntityPicker();
}
