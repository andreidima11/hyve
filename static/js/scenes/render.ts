/**
 * Scenes UI — HTML render helpers.
 */
import { t } from '../lang/index.js';
import type { SceneEntry, SceneSummary, SceneService } from '../types/scenes.js';
import { _SERVICE_VALUES, sceneState } from './state.js';

export function _escapeHtml(value: unknown) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch as string] || ch));
}

export function _iconClass(spec: unknown, fallback = 'fas fa-film') {
    const raw = String(spec || '').trim();
    if (!raw) return fallback;
    if (raw.startsWith('mdi:')) return `mdi mdi-${raw.slice(4)}`;
    if (/^mdi(\s|-)/.test(raw)) return raw.startsWith('mdi-') ? `mdi ${raw}` : raw;
    if (/\bfa[srlbd]?\b/.test(raw) || raw.startsWith('fa-')) return raw.startsWith('fa-') ? `fas ${raw}` : raw;
    return raw;
}

export function _entityDomain(entityId: string) {
    const idx = String(entityId || '').indexOf('.');
    return idx > 0 ? entityId.slice(0, idx) : '';
}
export function _serviceSelectHtml(idx: number, currentService: string) {
    const labels: Record<SceneService, string> = {
        turn_on: t('scenes.service_turn_on'),
        turn_off: t('scenes.service_turn_off'),
        toggle: t('scenes.service_toggle'),
    };
    const opts = _SERVICE_VALUES.map(v =>
        `<option value="${v}" ${v === currentService ? 'selected' : ''}>${_escapeHtml(labels[v] || v)}</option>`
    ).join('');
    return `<select data-scene-entry-service="${idx}" class="bg-slate-900 border border-theme-subtle rounded-lg px-2 py-1.5 text-xs text-slate-200 focus:border-accent outline-none">${opts}</select>`;
}

export function _entryRowHtml(entry: SceneEntry, idx: number) {
    const eid = _escapeHtml(entry.entity_id || '');
    const service = entry.service || 'turn_on';
    const dataJson = entry.service_data ? _escapeHtml(JSON.stringify(entry.service_data)) : '';
    return `
        <div class="rounded-xl border border-theme-subtle bg-white/[0.02] p-3 space-y-2" data-scene-entry-row="${idx}">
            <div class="flex items-center gap-2">
                <span class="text-[10px] font-bold text-slate-500 w-6">${idx + 1}.</span>
                <input type="text" data-scene-entry-entity="${idx}" value="${eid}"
                    placeholder="${_escapeHtml(t('scenes.entity_id_ph'))}"
                    class="flex-1 min-w-0 bg-slate-900 border border-theme-subtle rounded-lg px-2 py-1.5 text-xs text-slate-200 mono focus:border-accent outline-none">
                <button type="button" data-config-action="openSceneEntityPicker" data-config-index="${idx}"
                    class="px-2 py-1.5 rounded-lg text-xs text-slate-300 hover:bg-white/5 border border-theme-subtle" title="${_escapeHtml(t('scenes.pick_entity_title'))}">
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
                    class="mt-1 w-full bg-slate-900 border border-theme-subtle rounded-lg px-2 py-1.5 text-xs text-slate-300 mono focus:border-accent outline-none">
            </details>
        </div>`;
}

export function _renderEditorEntries() {
    const wrap = document.getElementById('scene-entries-list');
    if (!wrap) return;
    if (!sceneState.editorState.entries.length) {
        wrap.innerHTML = `<div class="rounded-xl border border-dashed border-theme-subtle p-6 text-center text-xs text-slate-500">
            ${t('scenes.entries_empty_html')}
        </div>`;
        return;
    }
    wrap.innerHTML = sceneState.editorState.entries.map((e, i) => _entryRowHtml(e, i)).join('');
}

export function _readEditorEntriesFromDOM(): SceneEntry[] {
    const rows = document.querySelectorAll('[data-scene-entry-row]');
    const out: SceneEntry[] = [];
    rows.forEach((row) => {
        const idx = Number(row.getAttribute('data-scene-entry-row'));
        const eid = (row.querySelector(`[data-scene-entry-entity="${idx}"]`) as HTMLInputElement | null)?.value.trim() || '';
        const service = (row.querySelector(`[data-scene-entry-service="${idx}"]`) as HTMLSelectElement | null)?.value || 'turn_on';
        const dataRaw = (row.querySelector(`[data-scene-entry-data="${idx}"]`) as HTMLInputElement | null)?.value.trim() || '';
        if (!eid) return;
        const item: SceneEntry = { entity_id: eid, service };
        if (dataRaw) {
            try {
                const parsed = JSON.parse(dataRaw) as unknown;
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    item.service_data = parsed as Record<string, unknown>;
                }
            } catch (_) {
                throw new Error(t('scenes.entry_invalid_json', { n: idx + 1 }));
            }
        }
        out.push(item);
    });
    return out;
}
export function _renderScenesList() {
    const wrap = document.getElementById('scenes-list');
    if (!wrap) return;
    if (!sceneState.scenesCache.length) {
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
    wrap.innerHTML = sceneState.scenesCache.map((s) => {
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
            <div class="flex items-center justify-between gap-3 p-3 rounded-xl bg-white/[0.02] border border-theme-subtle hover:border-theme-subtle transition-colors"
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
export function _renderEntityPickerList(query: string) {
    const list = document.getElementById('scene-entity-picker-list');
    if (!list) return;
    const q = String(query || '').trim().toLowerCase();
    const filtered = sceneState.entityCatalog.filter(e => {
        if (!e?.entity_id) return false;
        if (!q) return true;
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
                class="w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 border border-transparent hover:border-theme-subtle flex items-center gap-2">
                <span class="text-[10px] uppercase tracking-widest text-slate-500 w-20 flex-shrink-0">${domain}</span>
                <span class="flex-1 min-w-0">
                    <span class="block text-xs text-slate-200 truncate">${label}</span>
                    <span class="block text-[10px] text-slate-500 mono truncate">${eid}</span>
                </span>
                ${source ? `<span class="text-[9px] text-slate-500">${source}</span>` : ''}
            </button>`;
    }).join('');
}
