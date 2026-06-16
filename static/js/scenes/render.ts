/**
 * Scenes UI — HTML render helpers.
 */
import { t } from '../lang/index.js';
import type { SceneEntry, SceneSummary, SceneService } from '../types/scenes.js';
import { _SERVICE_VALUES, sceneState } from './state.js';

function _filteredScenes(): SceneSummary[] {
    const q = sceneState.listFilter;
    if (!q) return sceneState.scenesCache;
    return sceneState.scenesCache.filter((s) => {
        const hay = `${s.name || ''} ${s.description || ''} ${s.id || ''}`.toLowerCase();
        return hay.includes(q);
    });
}

function _sceneRowActions(sceneId: string) {
    const id = _escapeHtml(sceneId);
    return `<div class="hyd-row-actions" role="group">
        <button type="button" data-config-action="activateScene" data-config-scene-id="${id}" class="hyd-row-actions__btn hyd-row-actions__btn--accent" title="${_escapeHtml(t('scenes.activate_title'))}"><i class="fas fa-play" aria-hidden="true"></i></button>
        <button type="button" data-config-action="openSceneEditor" data-config-scene-id="${id}" class="hyd-row-actions__btn" title="${_escapeHtml(t('scenes.edit_title'))}"><i class="fas fa-pen" aria-hidden="true"></i></button>
        <button type="button" data-config-action="deleteScene" data-config-scene-id="${id}" class="hyd-row-actions__btn hyd-row-actions__btn--danger" title="${_escapeHtml(t('scenes.delete_title'))}"><i class="fas fa-trash-can" aria-hidden="true"></i></button>
    </div>`;
}

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
    const empty = document.getElementById('scenes-empty');
    if (!wrap) return;

    const scenes = _filteredScenes();
    if (!sceneState.scenesCache.length) {
        wrap.innerHTML = '';
        if (empty) {
            empty.classList.remove('hidden');
            empty.innerHTML = `
                <i class="fas fa-film hyd-list-placeholder__icon" aria-hidden="true"></i>
                <p>${_escapeHtml(t('scenes.empty_list'))}</p>
                <button type="button" data-config-action="openSceneEditor" class="hyd-btn hyd-btn--glow">
                    <i class="fas fa-plus" aria-hidden="true"></i><span>${_escapeHtml(t('scenes.new_scene'))}</span>
                </button>`;
        }
        return;
    }

    if (!scenes.length) {
        wrap.innerHTML = '';
        if (empty) {
            empty.classList.remove('hidden');
            empty.innerHTML = `<i class="fas fa-magnifying-glass hyd-list-placeholder__icon" aria-hidden="true"></i><p>${_escapeHtml(t('hy.entity_search_no_results'))}</p>`;
        }
        return;
    }

    if (empty) empty.classList.add('hidden');
    wrap.innerHTML = scenes.map((s) => {
        const icon = _escapeHtml(_iconClass(s.icon || 'fas fa-film'));
        const name = _escapeHtml(s.name || t('scenes.untitled'));
        const desc = _escapeHtml(s.description || '');
        const count = Number(s.entry_count || 0);
        const colorStyle = s.color ? ` style="color: ${_escapeHtml(s.color)}"` : '';
        const statusDot = s.enabled
            ? `<span class="hyd-status-dot hyd-status-dot--on" title="${_escapeHtml(t('scenes.enabled_badge_title'))}"></span>`
            : `<span class="hyd-status-dot hyd-status-dot--off" title="${_escapeHtml(t('scenes.disabled_badge_title'))}"></span>`;
        const sharedBadge = s.is_shared
            ? `<span class="hyd-row-badge">${_escapeHtml(t('scenes.shared_badge'))}</span>`
            : '';
        const meta = `${statusDot}${sharedBadge}<span class="hyd-row-badge"><i class="fas fa-list-ol" aria-hidden="true"></i>${count}</span>`;
        const sub = desc || String(s.id || '');
        return `
            <article class="hyd-entity-row hyd-entity-row--static" data-scene-card="${_escapeHtml(s.id)}" role="listitem">
                <span class="hyd-icon hyd-icon--list hyd-glow--default"${colorStyle}><i class="${icon}" aria-hidden="true"></i></span>
                <div class="hyd-entity-row__body">
                    <div class="hyd-entity-row__name">${name}</div>
                    <div class="hyd-entity-row__sub">${sub}</div>
                    <div class="hyd-entity-row__tags">${meta}</div>
                </div>
                ${_sceneRowActions(String(s.id))}
            </article>`;
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
