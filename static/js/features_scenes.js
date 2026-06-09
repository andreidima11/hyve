/**
 * Scenes UI — list, editor, activation.
 *
 * Backed by /api/scenes (see routers/scenes.py).
 * Each scene is a list of entries: {entity_id, service, service_data?}.
 */
import { apiCall } from './api.js';
import { showToast, showConfirm } from './utils.js';
import { t } from './lang/index.js';
const _MAX_ENTRIES = 64;
const _SERVICE_VALUES = ['turn_on', 'turn_off', 'toggle'];
let _scenesCache = [];
let _entityCatalog = [];
let _entityCatalogLoaded = false;
let _editorState = {
    mode: 'create',
    sceneId: null,
    entries: [],
    entityPickerTargetIdx: -1,
};
function _escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch] || ch));
}
function _iconClass(spec, fallback = 'fas fa-film') {
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
function _entityDomain(entityId) {
    const idx = String(entityId || '').indexOf('.');
    return idx > 0 ? entityId.slice(0, idx) : '';
}
async function _ensureEntityCatalog(force = false) {
    if (_entityCatalogLoaded && !force)
        return _entityCatalog;
    try {
        const res = await apiCall('/api/integrations/all-entities');
        if (res?.ok) {
            const data = await res.json();
            _entityCatalog = Array.isArray(data?.entities) ? data.entities : [];
            _entityCatalogLoaded = true;
        }
    }
    catch (_) {
        _entityCatalog = [];
    }
    return _entityCatalog;
}
function _serviceSelectHtml(idx, currentService) {
    const labels = {
        turn_on: t('scenes.service_turn_on'),
        turn_off: t('scenes.service_turn_off'),
        toggle: t('scenes.service_toggle'),
    };
    const opts = _SERVICE_VALUES.map(v => `<option value="${v}" ${v === currentService ? 'selected' : ''}>${_escapeHtml(labels[v] || v)}</option>`).join('');
    return `<select data-scene-entry-service="${idx}" class="bg-slate-900 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:border-accent outline-none">${opts}</select>`;
}
function _entryRowHtml(entry, idx) {
    const eid = _escapeHtml(entry.entity_id || '');
    const service = entry.service || 'turn_on';
    const dataJson = entry.service_data ? _escapeHtml(JSON.stringify(entry.service_data)) : '';
    return `
        <div class="rounded-xl border border-white/5 bg-white/[0.02] p-3 space-y-2" data-scene-entry-row="${idx}">
            <div class="flex items-center gap-2">
                <span class="text-[10px] font-bold text-slate-500 w-6">${idx + 1}.</span>
                <input type="text" data-scene-entry-entity="${idx}" value="${eid}"
                    placeholder="${_escapeHtml(t('scenes.entity_id_ph'))}"
                    class="flex-1 min-w-0 bg-slate-900 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-slate-200 mono focus:border-accent outline-none">
                <button type="button" data-config-action="openSceneEntityPicker" data-config-index="${idx}"
                    class="px-2 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-white/5 border border-white/10" title="${_escapeHtml(t('scenes.pick_entity_title'))}">
                    <i class="fas fa-magnifying-glass"></i>
                </button>
                ${_serviceSelectHtml(idx, String(service))}
                <button type="button" data-config-action="removeSceneEntry" data-config-index="${idx}"
                    class="w-7 h-7 rounded-lg text-red-400 hover:bg-red-500/10 flex items-center justify-center" title="${_escapeHtml(t('scenes.remove_entry_title'))}">
                    <i class="fas fa-trash-can text-xs"></i>
                </button>
            </div>
            <details class="text-[11px] text-slate-400">
                <summary class="cursor-pointer select-none hover:text-slate-200">${_escapeHtml(t('scenes.service_data_summary'))}</summary>
                <input type="text" data-scene-entry-data="${idx}" value="${dataJson}"
                    placeholder="${_escapeHtml(t('scenes.service_data_ph'))}"
                    class="mt-1 w-full bg-slate-900 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-slate-300 mono focus:border-accent outline-none">
            </details>
        </div>`;
}
function _renderEditorEntries() {
    const wrap = document.getElementById('scene-entries-list');
    if (!wrap)
        return;
    if (!_editorState.entries.length) {
        wrap.innerHTML = `<div class="rounded-xl border border-dashed border-white/10 p-6 text-center text-xs text-slate-500">
            ${t('scenes.entries_empty_html')}
        </div>`;
        return;
    }
    wrap.innerHTML = _editorState.entries.map((e, i) => _entryRowHtml(e, i)).join('');
}
function _readEditorEntriesFromDOM() {
    const rows = document.querySelectorAll('[data-scene-entry-row]');
    const out = [];
    rows.forEach((row) => {
        const idx = Number(row.getAttribute('data-scene-entry-row'));
        const eid = row.querySelector(`[data-scene-entry-entity="${idx}"]`)?.value.trim() || '';
        const service = row.querySelector(`[data-scene-entry-service="${idx}"]`)?.value || 'turn_on';
        const dataRaw = row.querySelector(`[data-scene-entry-data="${idx}"]`)?.value.trim() || '';
        if (!eid)
            return;
        const item = { entity_id: eid, service };
        if (dataRaw) {
            try {
                const parsed = JSON.parse(dataRaw);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    item.service_data = parsed;
                }
            }
            catch (_) {
                throw new Error(t('scenes.entry_invalid_json', { n: idx + 1 }));
            }
        }
        out.push(item);
    });
    return out;
}
function _renderScenesList() {
    const wrap = document.getElementById('scenes-list');
    if (!wrap)
        return;
    if (!_scenesCache.length) {
        wrap.innerHTML = `
            <div class="flex flex-col items-center justify-center text-center py-12">
                <div class="text-5xl text-slate-600 mb-3"><i class="fas fa-film"></i></div>
                <p class="text-sm text-slate-500 mb-4">${_escapeHtml(t('scenes.empty_list'))}</p>
                <button type="button" data-config-action="openSceneEditor"
                    class="px-3 py-2 rounded-xl text-xs font-bold bg-accent text-bg-main hover:bg-accent-hover transition-colors">
                    <i class="fas fa-plus mr-1.5"></i>${_escapeHtml(t('scenes.new_scene'))}
                </button>
            </div>`;
        return;
    }
    wrap.innerHTML = _scenesCache.map((s) => {
        const icon = _escapeHtml(_iconClass(s.icon || 'fas fa-film'));
        const name = _escapeHtml(s.name || t('scenes.untitled'));
        const desc = _escapeHtml(s.description || '');
        const count = Number(s.entry_count || 0);
        const colorStyle = s.color ? `style="color: ${_escapeHtml(s.color)}"` : '';
        const enabledDot = s.enabled
            ? `<span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" title="${_escapeHtml(t('scenes.enabled_badge_title'))}"></span>`
            : `<span class="inline-block w-1.5 h-1.5 rounded-full bg-slate-600" title="${_escapeHtml(t('scenes.disabled_badge_title'))}"></span>`;
        const sharedBadge = s.is_shared
            ? `<span class="inline-flex items-center gap-1 text-[9px] font-bold text-sky-300 bg-white/5 rounded-full px-2 py-0.5"><i class="fas fa-users text-[8px]"></i>${_escapeHtml(t('scenes.shared_badge'))}</span>`
            : '';
        const countBadge = `<span class="inline-flex items-center gap-1 text-[10px] text-slate-400"><i class="fas fa-list-ol text-[9px]"></i>${count}</span>`;
        return `
            <div class="flex items-center justify-between gap-3 p-3 rounded-xl bg-white/[0.02] border border-white/5 hover:border-white/10 transition-colors"
                 data-scene-card="${_escapeHtml(s.id)}">
                <div class="flex items-center gap-3 min-w-0 flex-1">
                    <span class="w-9 h-9 rounded-xl bg-accent/10 text-accent flex items-center justify-center shrink-0" ${colorStyle}><i class="${icon}"></i></span>
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2 flex-wrap">
                            ${enabledDot}
                            <span class="text-sm font-semibold text-white truncate">${name}</span>
                            ${countBadge}
                            ${sharedBadge}
                        </div>
                        ${desc ? `<span class="text-[10px] text-slate-500 truncate block">${desc}</span>` : ''}
                    </div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <button type="button" data-config-action="activateScene" data-config-scene-id="${_escapeHtml(s.id)}" class="text-accent hover:text-accent-hover px-2 py-1.5 rounded-lg text-[11px] inline-flex items-center" title="${_escapeHtml(t('scenes.activate_title'))}"><i class="fas fa-play text-[10px]"></i></button>
                    <button type="button" data-config-action="openSceneEditor" data-config-scene-id="${_escapeHtml(s.id)}" class="text-slate-400 hover:text-white px-2 py-1.5 rounded-lg text-[11px] inline-flex items-center" title="${_escapeHtml(t('scenes.edit_title'))}"><i class="fas fa-pen text-[10px]"></i></button>
                    <button type="button" data-config-action="deleteScene" data-config-scene-id="${_escapeHtml(s.id)}" class="text-rose-400/70 hover:text-rose-300 px-2 py-1.5 rounded-lg text-[11px] inline-flex items-center" title="${_escapeHtml(t('scenes.delete_title'))}"><i class="fas fa-trash text-[10px]"></i></button>
                </div>
            </div>`;
    }).join('');
}
export async function loadScenes() {
    const wrap = document.getElementById('scenes-list');
    if (wrap && !_scenesCache.length) {
        wrap.innerHTML = `<div class="col-span-full text-center text-xs text-slate-500 py-10">
            <i class="fas fa-spinner fa-spin mr-1.5"></i>${_escapeHtml(t('scenes.loading'))}
        </div>`;
    }
    try {
        const res = await apiCall('/api/scenes');
        if (!res.ok)
            throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        _scenesCache = Array.isArray(data?.scenes) ? data.scenes : [];
        _renderScenesList();
    }
    catch (e) {
        if (wrap) {
            wrap.innerHTML = `<div class="col-span-full text-center text-xs text-red-400 py-10">
                ${_escapeHtml(t('scenes.load_failed', { message: e instanceof Error ? e.message : String(e) }))}
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
    _ensureEntityCatalog().catch(() => { });
}
export function closeScenesPage() {
    const page = document.getElementById('scenes-page');
    if (!page)
        return;
    page.classList.add('hidden');
    page.classList.remove('flex');
}
export async function openSceneEditor(sceneId = null) {
    const modal = document.getElementById('scene-editor-modal');
    if (!modal)
        return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    _editorState.mode = sceneId ? 'edit' : 'create';
    _editorState.sceneId = sceneId;
    _editorState.entries = [];
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
        const label = _escapeHtml(sceneId ? t('scenes.editor_title_edit') : t('scenes.editor_title_new'));
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
            _editorState.entries = Array.isArray(scene.entries) ? scene.entries.map(e => ({ ...e })) : [];
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
        _editorState.entries = [];
    }
    _renderEditorEntries();
    await _ensureEntityCatalog();
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
    if (_editorState.entries.length >= _MAX_ENTRIES) {
        showToast(t('scenes.max_entries', { max: _MAX_ENTRIES }), 'warning');
        return;
    }
    try {
        _editorState.entries = _readEditorEntriesFromDOM();
    }
    catch (_) { }
    _editorState.entries.push({ entity_id: '', service: 'turn_on' });
    _renderEditorEntries();
}
export function removeSceneEntry(idx) {
    try {
        _editorState.entries = _readEditorEntriesFromDOM();
    }
    catch (_) { }
    if (idx < 0 || idx >= _editorState.entries.length)
        return;
    _editorState.entries.splice(idx, 1);
    _renderEditorEntries();
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
        entries = _readEditorEntriesFromDOM();
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
        if (_editorState.mode === 'edit' && _editorState.sceneId) {
            res = await apiCall(`/api/scenes/${encodeURIComponent(_editorState.sceneId)}`, {
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
        showToast(_editorState.mode === 'edit'
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
    if (!_editorState.sceneId)
        return;
    const ok = await showConfirm(t('scenes.delete_confirm_hard'));
    if (!ok)
        return;
    await deleteScene(_editorState.sceneId, { skipConfirm: true });
    closeSceneEditor();
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
export async function openSceneEntityPicker(targetIdx) {
    _editorState.entityPickerTargetIdx = targetIdx;
    try {
        _editorState.entries = _readEditorEntriesFromDOM();
    }
    catch (_) { }
    const modal = document.getElementById('scene-entity-picker-modal');
    if (!modal)
        return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    await _ensureEntityCatalog();
    _renderEntityPickerList('');
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
    _editorState.entityPickerTargetIdx = -1;
}
function _renderEntityPickerList(query) {
    const list = document.getElementById('scene-entity-picker-list');
    if (!list)
        return;
    const q = String(query || '').trim().toLowerCase();
    const filtered = _entityCatalog.filter(e => {
        if (!e?.entity_id)
            return false;
        if (!q)
            return true;
        const hay = `${e.entity_id} ${e.friendly_name || ''} ${e.label || ''}`.toLowerCase();
        return hay.includes(q);
    }).slice(0, 200);
    if (!filtered.length) {
        list.innerHTML = `<div class="text-center text-xs text-slate-500 py-6">${_escapeHtml(t('scenes.picker_no_match'))}</div>`;
        return;
    }
    list.innerHTML = filtered.map(e => {
        const eid = _escapeHtml(e.entity_id);
        const label = _escapeHtml(e.friendly_name || e.label || e.entity_id);
        const domain = _escapeHtml(_entityDomain(e.entity_id));
        const source = _escapeHtml(e.source || '');
        return `
            <button type="button" data-config-action="pickSceneEntity" data-config-entity-id="${eid}"
                class="w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 border border-transparent hover:border-white/10 flex items-center gap-2">
                <span class="text-[10px] uppercase tracking-widest text-slate-500 w-20 flex-shrink-0">${domain}</span>
                <span class="flex-1 min-w-0">
                    <span class="block text-xs text-slate-200 truncate">${label}</span>
                    <span class="block text-[10px] text-slate-500 mono truncate">${eid}</span>
                </span>
                ${source ? `<span class="text-[9px] text-slate-500">${source}</span>` : ''}
            </button>`;
    }).join('');
}
export function filterSceneEntityPicker() {
    const q = document.getElementById('scene-entity-picker-search')?.value || '';
    _renderEntityPickerList(q);
}
export function pickSceneEntity(entityId) {
    const idx = _editorState.entityPickerTargetIdx;
    if (idx < 0) {
        closeSceneEntityPicker();
        return;
    }
    try {
        _editorState.entries = _readEditorEntriesFromDOM();
    }
    catch (_) { }
    if (idx >= _editorState.entries.length) {
        _editorState.entries.push({ entity_id: entityId, service: 'turn_on' });
    }
    else {
        _editorState.entries[idx] = { ..._editorState.entries[idx], entity_id: entityId };
    }
    closeSceneEntityPicker();
    _renderEditorEntries();
}
