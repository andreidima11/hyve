// @ts-nocheck — tighten types in a follow-up pass.
/**
 * Areas (rooms/zones/floors) UI.
 *
 * Backed by /api/areas (see routers/areas.py). Areas are mirrored from
 * the area registry; areas may also be Hyve-only custom groups.
 */
import { apiCall } from './api.js';
import { showToast, showConfirm } from './utils.js';
import { t } from './lang/index.js';
let _areasCache = [];
let _allEntitiesCache = []; // [{entity_id, name, source, domain, area, ...}]
let _entitiesCacheTime = 0;
let _editorState = { mode: 'create', areaId: null, synced: false, entities: [] };
let _pickerSelected = new Set();
let _pickerFilter = '';
function _esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}
function _iconClass(spec, fallback = 'fas fa-location-dot') {
    const raw = String(spec || '').trim();
    if (!raw)
        return fallback;
    if (raw.startsWith('mdi:'))
        return `mdi mdi-${raw.slice(4)}`;
    if (/^mdi(\s|-)/.test(raw))
        return raw.startsWith('mdi-') ? `mdi ${raw}` : raw;
    if (/\bfa[srlbd]?\b/.test(raw) || raw.startsWith('fa-'))
        return raw.startsWith('fa-') ? `fas ${raw}` : raw;
    return raw;
}
function _renderAreas() {
    const list = document.getElementById('areas-list');
    const empty = document.getElementById('areas-empty');
    const toolbar = document.getElementById('areas-toolbar');
    if (!list)
        return;
    if (!_areasCache.length) {
        list.innerHTML = '';
        if (toolbar)
            toolbar.classList.add('hidden');
        if (empty)
            empty.classList.remove('hidden');
        return;
    }
    if (empty)
        empty.classList.add('hidden');
    if (toolbar)
        toolbar.classList.remove('hidden');
    list.innerHTML = _areasCache.map((a) => {
        const id = _esc(a.id);
        const name = _esc(a.name || a.id);
        const aliases = Array.isArray(a.aliases) ? a.aliases : [];
        const aliasText = aliases.length
            ? `<span class="text-[10px] text-slate-500 truncate">${_esc(aliases.join(', '))}</span>`
            : '';
        const sourceBadge = a.synced
            ? `<span class="inline-flex items-center gap-1 text-[9px] font-bold text-sky-300 bg-white/5 rounded-full px-2 py-0.5"><i class="fas fa-link text-[8px]"></i>Sync</span>`
            : `<span class="inline-flex items-center gap-1 text-[9px] font-bold text-purple-300 bg-white/5 rounded-full px-2 py-0.5"><i class="fas fa-star text-[8px]"></i>Hyve</span>`;
        const iconClass = _iconClass(a.icon || 'fa-house-chimney-window', 'fas fa-house-chimney-window');
        const floor = a.floor ? `<span class="text-[10px] text-slate-500">· ${_esc(a.floor)}</span>` : '';
        const entCount = Array.isArray(a.extra_entities) ? a.extra_entities.length : 0;
        const entBadge = `<span class="inline-flex items-center gap-1 text-[10px] text-slate-400"><i class="fas fa-microchip text-[9px]"></i>${_esc(t('areas.entities_count', { count: entCount }))}</span>`;
        const deleteBtn = `<button type="button" data-config-action="deleteArea" data-config-area-id="${id}" class="text-rose-400/70 hover:text-rose-300 px-2 py-1.5 rounded-lg text-[11px] inline-flex items-center" title="${_esc(t('common.delete'))}"><i class="fas fa-trash text-[10px]"></i></button>`;
        return `
            <div class="flex items-center justify-between gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/5 hover:border-white/10 transition-colors">
                <div class="flex items-center gap-3 min-w-0 flex-1">
                    <span class="w-9 h-9 rounded-xl bg-accent/10 text-accent flex items-center justify-center shrink-0"><i class="${_esc(iconClass)}"></i></span>
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="text-sm font-semibold text-white truncate">${name}</span>
                            ${entBadge}
                            ${floor}
                        </div>
                        ${aliasText}
                    </div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <button type="button" data-config-action="editArea" data-config-area-id="${id}" class="text-slate-400 hover:text-white px-2 py-1.5 rounded-lg text-[11px] inline-flex items-center" title="${_esc(t('common.edit'))}"><i class="fas fa-pen text-[10px]"></i></button>
                    ${deleteBtn}
                </div>
            </div>`;
    }).join('');
}
export async function loadAreas() {
    const list = document.getElementById('areas-list');
    if (list && !_areasCache.length) {
        list.innerHTML = `<div class="text-center text-xs text-slate-500 py-8"><i class="fas fa-spinner fa-spin mr-1.5"></i>${_esc(t('areas.loading'))}</div>`;
    }
    try {
        const res = await apiCall('/api/areas');
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        _areasCache = Array.isArray(data?.areas) ? data.areas : [];
        _renderAreas();
    }
    catch (err) {
        console.error('loadAreas failed', err);
        if (list)
            list.innerHTML = `<div class="text-center text-xs text-red-400 py-8">${_esc(t('areas.load_list_error'))}</div>`;
    }
}
export async function syncAreasFromHA(btn) {
    const button = (btn instanceof HTMLElement) ? btn : null;
    if (button) {
        button.disabled = true;
        button.classList.add('opacity-60');
    }
    try {
        const res = await apiCall('/api/areas/sync', { method: 'POST' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const synced = Number(data?.synced || 0);
        const removed = Number(data?.removed || 0);
        const removedSuffix = removed ? t('areas.sync_removed_suffix', { count: removed }) : '';
        showToast(t('areas.sync_success_detail', { synced, removed: removedSuffix }), 'success');
        _areasCache = Array.isArray(data?.areas) ? data.areas : [];
        _renderAreas();
    }
    catch (err) {
        console.error('syncAreasFromHA failed', err);
        showToast(`${t('areas.sync_error')}: ${err.message}`, 'error');
    }
    finally {
        if (button) {
            button.disabled = false;
            button.classList.remove('opacity-60');
        }
    }
}
function _ensureModalAtTopLevel() {
    const modal = document.getElementById('area-editor-modal');
    if (modal && modal.parentElement && modal.parentElement !== document.body) {
        document.body.appendChild(modal);
    }
    return modal;
}
function _openEditor(area) {
    console.log('[areas] _openEditor called', { area });
    const modal = _ensureModalAtTopLevel();
    if (!modal) {
        console.error('[areas] area-editor-modal NOT FOUND in DOM');
        showToast(t('areas.modal_missing'), 'error');
        return;
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    console.log('[areas] modal classes now:', modal.className);
    const $ = (id) => document.getElementById(id);
    const isEdit = !!area;
    const synced = !!(area && area.synced);
    _editorState = { mode: isEdit ? 'edit' : 'create', areaId: isEdit ? area.id : null, synced };
    try {
        const titleEl = $('area-editor-title');
        if (titleEl)
            titleEl.innerHTML = `<i class="fas fa-house-chimney-window"></i><span>${_esc(isEdit ? t('areas.editor_title_edit') : t('areas.editor_title_new'))}</span>`;
        const note = $('area-editor-synced-note');
        if (note)
            note.classList.toggle('hidden', !synced);
        const deleteBtn = $('area-editor-delete');
        if (deleteBtn)
            deleteBtn.classList.toggle('hidden', !isEdit || synced);
        const nameEl = $('area-editor-name');
        const floorEl = $('area-editor-floor');
        const iconEl = $('area-editor-icon');
        const aliasesEl = $('area-editor-aliases');
        if (nameEl)
            nameEl.value = area?.name || '';
        if (floorEl)
            floorEl.value = area?.floor || '';
        if (iconEl)
            iconEl.value = area?.icon || '';
        if (aliasesEl)
            aliasesEl.value = (Array.isArray(area?.aliases) ? area.aliases : []).join(', ');
        // Selected entities (separate from name/aliases form)
        _editorState.entities = Array.isArray(area?.extra_entities) ? [...area.extra_entities] : [];
        _renderEditorEntities();
        // Pre-warm entities cache so the picker opens fast
        _ensureEntitiesLoaded().catch(() => { });
        setTimeout(() => nameEl?.focus(), 50);
    }
    catch (err) {
        console.error('[areas] _openEditor populate failed', err);
    }
}
export function closeAreaEditor() {
    const modal = document.getElementById('area-editor-modal');
    if (!modal)
        return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}
export function openCreateAreaModal() {
    console.log('[areas] openCreateAreaModal click');
    _openEditor(null);
}
export function editArea(areaId) {
    const area = _areasCache.find(a => a.id === areaId);
    if (!area)
        return;
    _openEditor(area);
}
export async function saveAreaFromEditor() {
    const $ = (id) => document.getElementById(id);
    const name = ($('area-editor-name')?.value || '').trim();
    if (!name) {
        showToast(t('areas.name_required'), 'error');
        return;
    }
    const floor = ($('area-editor-floor')?.value || '').trim();
    const icon = ($('area-editor-icon')?.value || '').trim();
    const aliasesRaw = ($('area-editor-aliases')?.value || '').trim();
    const aliases = aliasesRaw ? aliasesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const payload = { name, floor: floor || null, icon: icon || null, aliases, extra_entities: Array.isArray(_editorState.entities) ? _editorState.entities : [] };
    try {
        let res;
        if (_editorState.mode === 'edit' && _editorState.areaId) {
            res = await apiCall(`/api/areas/${encodeURIComponent(_editorState.areaId)}`, {
                method: 'PATCH',
                body: payload,
            });
        }
        else {
            res = await apiCall('/api/areas', {
                method: 'POST',
                body: payload,
            });
        }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.detail || `HTTP ${res.status}`);
        }
        showToast(t('areas.saved'), 'success');
        closeAreaEditor();
        await loadAreas();
    }
    catch (err) {
        console.error('saveAreaFromEditor failed', err);
        showToast(`${t('common.error')}: ${err.message}`, 'error');
    }
}
export async function deleteArea(areaId) {
    const area = _areasCache.find(a => a.id === areaId);
    if (!area)
        return;
    if (!(await showConfirm(t('areas.delete_confirm', { name: area.name }))))
        return;
    try {
        const res = await apiCall(`/api/areas/${encodeURIComponent(areaId)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.detail || `HTTP ${res.status}`);
        }
        showToast(t('areas.deleted'), 'success');
        await loadAreas();
    }
    catch (err) {
        console.error('deleteArea failed', err);
        showToast(`${t('common.error')}: ${err.message}`, 'error');
    }
}
export async function deleteAreaFromEditor() {
    if (_editorState.mode !== 'edit' || !_editorState.areaId)
        return;
    const area = _areasCache.find(a => a.id === _editorState.areaId);
    if (!area)
        return;
    if (!(await showConfirm(t('areas.delete_confirm', { name: area.name }))))
        return;
    try {
        const res = await apiCall(`/api/areas/${encodeURIComponent(_editorState.areaId)}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.detail || `HTTP ${res.status}`);
        }
        showToast(t('areas.deleted'), 'success');
        closeAreaEditor();
        await loadAreas();
    }
    catch (err) {
        console.error('deleteAreaFromEditor failed', err);
        showToast(`${t('common.error')}: ${err.message}`, 'error');
    }
}
// ─────────────────────────────────────────────────────────────────────────
// Entity assignment (selected list inside editor + picker modal)
// ─────────────────────────────────────────────────────────────────────────
async function _ensureEntitiesLoaded(force = false) {
    const fresh = (Date.now() - _entitiesCacheTime) < 30000;
    if (!force && fresh && _allEntitiesCache.length)
        return _allEntitiesCache;
    const res = await apiCall('/api/integrations/all-entities');
    if (!res.ok)
        throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _allEntitiesCache = Array.isArray(data?.entities) ? data.entities : [];
    _entitiesCacheTime = Date.now();
    return _allEntitiesCache;
}
function _entityLookup(eid) {
    return _allEntitiesCache.find(e => e.entity_id === eid);
}
function _renderEditorEntities() {
    const wrap = document.getElementById('area-editor-entities');
    if (!wrap)
        return;
    const ids = Array.isArray(_editorState.entities) ? _editorState.entities : [];
    if (!ids.length) {
        wrap.innerHTML = `<p class="text-[11px] text-slate-500 italic">${_esc(t('areas.entities_empty'))}</p>`;
        return;
    }
    wrap.innerHTML = ids.map(eid => {
        const meta = _entityLookup(eid);
        const label = meta?.name || meta?.friendly_name || eid;
        const dom = (eid.split('.')[0] || '').toLowerCase();
        const src = meta?.source ? ` · ${_esc(meta.source)}` : '';
        return `<span class="inline-flex items-center gap-1.5 text-[11px] bg-white/5 border border-white/10 rounded-full pl-2 pr-1 py-0.5 text-slate-300" title="${_esc(eid)}">
            <i class="fas fa-microchip text-[9px] text-slate-500"></i>
            <span class="truncate max-w-[140px]">${_esc(label)}</span>
            <span class="text-[9px] text-slate-500">${_esc(dom)}${src}</span>
            <button type="button" data-config-action="removeAreaEditorEntity" data-config-entity-id="${_esc(eid)}" class="ml-1 w-4 h-4 rounded-full hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 inline-flex items-center justify-center" title="Scoate"><i class="fas fa-xmark text-[9px]"></i></button>
        </span>`;
    }).join('');
}
export function removeAreaEditorEntity(eid) {
    _editorState.entities = (_editorState.entities || []).filter(x => x !== eid);
    _renderEditorEntities();
}
export async function openAreaEntityPicker() {
    const modal = document.getElementById('area-entity-picker-modal');
    if (!modal)
        return;
    if (modal.parentElement !== document.body)
        document.body.appendChild(modal);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    _pickerSelected = new Set(_editorState.entities || []);
    _pickerFilter = '';
    const search = document.getElementById('area-entity-picker-search');
    if (search)
        search.value = '';
    const list = document.getElementById('area-entity-picker-list');
    if (list)
        list.innerHTML = `<div class="text-center text-xs text-slate-500 py-8"><i class="fas fa-spinner fa-spin mr-1.5"></i>${_esc(t('areas.loading_entities'))}</div>`;
    try {
        await _ensureEntitiesLoaded();
        _renderPickerList();
        setTimeout(() => search?.focus(), 50);
    }
    catch (err) {
        console.error('openAreaEntityPicker failed', err);
        if (list)
            list.innerHTML = `<div class="text-center text-xs text-rose-400 py-8">${_esc(t('areas.load_entities_error'))}</div>`;
    }
}
export function closeAreaEntityPicker() {
    const modal = document.getElementById('area-entity-picker-modal');
    if (!modal)
        return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}
export function filterAreaEntityPicker(value) {
    _pickerFilter = String(value || '').trim().toLowerCase();
    _renderPickerList();
}
function _renderPickerList() {
    const list = document.getElementById('area-entity-picker-list');
    const counter = document.getElementById('area-entity-picker-count');
    if (!list)
        return;
    const q = _pickerFilter;
    const filtered = !q ? _allEntitiesCache : _allEntitiesCache.filter(e => {
        const hay = `${e.entity_id} ${e.name || ''} ${e.friendly_name || ''} ${e.source || ''} ${e.area || ''}`.toLowerCase();
        return hay.includes(q);
    });
    if (counter)
        counter.textContent = t('areas.picker_selected', { selected: _pickerSelected.size, filtered: filtered.length, total: _allEntitiesCache.length });
    if (!filtered.length) {
        list.innerHTML = `<p class="text-center text-xs text-slate-500 py-8">${_esc(t('areas.picker_empty'))}</p>`;
        return;
    }
    list.innerHTML = filtered.slice(0, 500).map(e => {
        const eid = e.entity_id;
        const checked = _pickerSelected.has(eid);
        const dom = (eid.split('.')[0] || '').toLowerCase();
        const label = e.name || e.friendly_name || eid;
        const area = e.area ? `<span class="text-[10px] text-accent/80"><i class="fas fa-house-chimney-window text-[9px] mr-0.5"></i>${_esc(e.area)}</span>` : '';
        const src = e.source ? `<span class="text-[10px] text-slate-500">${_esc(e.source)}</span>` : '';
        return `<label class="flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 cursor-pointer ${checked ? 'bg-accent/10 border border-accent/30' : 'border border-transparent'}">
            <input type="checkbox" ${checked ? 'checked' : ''} data-config-input="toggleAreaPickerEntity" data-config-entity-id="${_esc(eid)}" class="accent-accent">
            <div class="min-w-0 flex-1">
                <div class="text-[12px] font-medium text-slate-200 truncate">${_esc(label)}</div>
                <div class="flex items-center gap-2 mt-0.5">
                    <span class="text-[10px] text-slate-500 mono truncate">${_esc(eid)}</span>
                    <span class="text-[10px] text-slate-600">·</span>
                    <span class="text-[10px] text-slate-500">${_esc(dom)}</span>
                    ${src ? `<span class="text-[10px] text-slate-600">·</span>${src}` : ''}
                    ${area ? `<span class="text-[10px] text-slate-600">·</span>${area}` : ''}
                </div>
            </div>
        </label>`;
    }).join('') + (filtered.length > 500 ? `<p class="text-center text-[10px] text-slate-500 py-2">${_esc(t('areas.picker_truncated', { count: filtered.length - 500 }))}</p>` : '');
}
export function toggleAreaPickerEntity(eid, checked) {
    if (checked)
        _pickerSelected.add(eid);
    else
        _pickerSelected.delete(eid);
    const counter = document.getElementById('area-entity-picker-count');
    if (counter)
        counter.textContent = t('areas.picker_selected_total', { selected: _pickerSelected.size, total: _allEntitiesCache.length });
}
export function confirmAreaEntityPicker() {
    _editorState.entities = Array.from(_pickerSelected);
    _renderEditorEntities();
    closeAreaEntityPicker();
}
