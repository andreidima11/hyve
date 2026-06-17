/**
 * Areas UI — HTML render helpers.
 */
import { t } from '../lang/index.js';
import { areaState } from './state.js';

export function _esc(value: unknown) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch as string] || ch));
}

export function _iconClass(spec: unknown, fallback = 'fas fa-location-dot') {
    const raw = String(spec || '').trim();
    if (!raw) return fallback;
    if (raw.startsWith('mdi:')) return `mdi mdi-${raw.slice(4)}`;
    if (/^mdi(\s|-)/.test(raw)) return raw.startsWith('mdi-') ? `mdi ${raw}` : raw;
    if (/\bfa[srlbd]?\b/.test(raw) || raw.startsWith('fa-')) return raw.startsWith('fa-') ? `fas ${raw}` : raw;
    return raw;
}

function _filteredAreas() {
    const q = areaState.listFilter;
    if (!q) return areaState.areasCache;
    return areaState.areasCache.filter((a) => {
        const aliases = Array.isArray(a.aliases) ? a.aliases.join(' ') : '';
        const hay = `${a.name || ''} ${a.id || ''} ${a.floor || ''} ${aliases}`.toLowerCase();
        return hay.includes(q);
    });
}

function _areaRowActions(areaId: string) {
    const id = _esc(areaId);
    return `<div class="hyd-row-actions" role="group">
        <button type="button" data-config-action="editArea" data-config-area-id="${id}" class="hyd-row-actions__btn" title="${_esc(t('common.edit'))}"><i class="fas fa-pen" aria-hidden="true"></i></button>
        <button type="button" data-config-action="deleteArea" data-config-area-id="${id}" class="hyd-row-actions__btn hyd-row-actions__btn--danger" title="${_esc(t('common.delete'))}"><i class="fas fa-trash-can" aria-hidden="true"></i></button>
    </div>`;
}

export function _renderAreas() {
    const list = document.getElementById('areas-list');
    const empty = document.getElementById('areas-empty');
    if (!list) return;

    if (!areaState.areasCache.length) {
        list.innerHTML = '';
        if (empty) {
            empty.classList.remove('hidden');
            empty.innerHTML = `
                <i class="fas fa-house-chimney-window hyd-list-placeholder__icon" aria-hidden="true"></i>
                <p>${_esc(t('areas.empty_list'))}</p>
                <button type="button" data-config-action="openCreateAreaModal" class="hyd-btn hyd-btn--glow">
                    <i class="fas fa-plus" aria-hidden="true"></i><span>${_esc(t('areas.new_area'))}</span>
                </button>`;
        }
        return;
    }

    const areas = _filteredAreas();
    if (!areas.length) {
        list.innerHTML = '';
        if (empty) empty.classList.add('hidden');
        return;
    }

    if (empty) empty.classList.add('hidden');
    list.innerHTML = areas.map((a) => {
        const id = _esc(a.id);
        const name = _esc(a.name || a.id);
        const aliases = Array.isArray(a.aliases) ? a.aliases : [];
        const aliasText = aliases.length ? aliases.join(', ') : '';
        const iconClass = _esc(_iconClass(a.icon || 'fa-house-chimney-window', 'fas fa-house-chimney-window'));
        const floor = a.floor ? _esc(a.floor) : '';
        const entCount = Array.isArray(a.extra_entities) ? a.extra_entities.length : 0;
        const sub = aliasText || floor || id;
        const tags = `<span class="hyd-row-badge"><i class="fas fa-microchip" aria-hidden="true"></i>${_esc(t('areas.entities_count', { count: entCount }))}</span>${floor ? `<span class="hyd-row-badge">${floor}</span>` : ''}`;
        return `
            <article class="hyd-entity-row hyd-entity-row--static" data-area-card="${id}" role="listitem">
                <span class="hyd-icon hyd-icon--list hyd-glow--default"><i class="${iconClass}" aria-hidden="true"></i></span>
                <div class="hyd-entity-row__body">
                    <div class="hyd-entity-row__name">${name}</div>
                    <div class="hyd-entity-row__sub">${_esc(sub)}</div>
                    <div class="hyd-entity-row__tags">${tags}</div>
                </div>
                ${_areaRowActions(String(a.id))}
            </article>`;
    }).join('');
}

export function _entityLookup(eid: string) {
    return areaState.allEntitiesCache.find(e => e.entity_id === eid);
}

export function _renderEditorEntities() {
    const wrap = document.getElementById('area-editor-entities');
    if (!wrap) return;
    const ids = Array.isArray(areaState.editorState.entities) ? areaState.editorState.entities : [];
    if (!ids.length) {
        wrap.innerHTML = `<p class="text-[11px] text-slate-500 italic">${_esc(t('areas.entities_empty'))}</p>`;
        return;
    }
    wrap.innerHTML = ids.map(eid => {
        const meta = _entityLookup(eid);
        const label = meta?.name || meta?.friendly_name || eid;
        const dom = (eid.split('.')[0] || '').toLowerCase();
        const src = meta?.source ? ` · ${_esc(meta.source)}` : '';
        return `<span class="inline-flex items-center gap-1.5 text-[11px] bg-white/5 border border-theme-subtle rounded-full pl-2 pr-1 py-0.5 text-slate-300" title="${_esc(eid)}">
            <i class="fas fa-microchip text-[9px] text-slate-500"></i>
            <span class="truncate max-w-[140px]">${_esc(label)}</span>
            <span class="text-[9px] text-slate-500">${_esc(dom)}${src}</span>
            <button type="button" data-config-action="removeAreaEditorEntity" data-config-entity-id="${_esc(eid)}" class="ml-1 w-4 h-4 rounded-full hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 inline-flex items-center justify-center" title="Scoate"><i class="fas fa-xmark text-[9px]"></i></button>
        </span>`;
    }).join('');
}

export function _renderPickerList() {
    const list = document.getElementById('area-entity-picker-list');
    const counter = document.getElementById('area-entity-picker-count');
    if (!list) return;
    const q = areaState.pickerFilter;
    const filtered = !q ? areaState.allEntitiesCache : areaState.allEntitiesCache.filter(e => {
        const hay = `${e.entity_id} ${e.name || ''} ${e.friendly_name || ''} ${e.source || ''} ${e.area || ''}`.toLowerCase();
        return hay.includes(q);
    });
    if (counter) counter.textContent = t('areas.picker_selected', { selected: areaState.pickerSelected.size, filtered: filtered.length, total: areaState.allEntitiesCache.length });

    if (!filtered.length) {
        list.innerHTML = `<p class="text-center text-xs text-slate-500 py-8">${_esc(t('areas.picker_empty'))}</p>`;
        return;
    }
    list.innerHTML = filtered.slice(0, 500).map(e => {
        const eid = e.entity_id;
        const checked = areaState.pickerSelected.has(eid);
        const dom = (eid.split('.')[0] || '').toLowerCase();
        const label = e.name || e.friendly_name || eid;
        const area = e.area ? `<span class="text-[10px] text-accent/80"><i class="fas fa-house-chimney-window text-[9px] mr-0.5"></i>${_esc(e.area)}</span>` : '';
        const src = e.source ? `<span class="text-[10px] text-slate-500">${_esc(e.source)}</span>` : '';
        return `<label class="hyd-entity-row hyd-entity-row--static hyd-picker-row cursor-pointer${checked ? ' is-selected' : ''}">
            <input type="checkbox" ${checked ? 'checked' : ''} data-config-input="toggleAreaPickerEntity" data-config-entity-id="${_esc(eid)}" class="accent-accent flex-shrink-0">
            <div class="hyd-entity-row__body min-w-0">
                <div class="hyd-entity-row__name truncate">${_esc(label)}</div>
                <div class="hyd-entity-row__sub flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span class="mono truncate">${_esc(eid)}</span>
                    <span class="hyd-row-badge hyd-row-badge--muted">${_esc(dom)}</span>
                    ${src ? `<span class="hyd-row-badge hyd-row-badge--muted">${src}</span>` : ''}
                    ${area ? area : ''}
                </div>
            </div>
        </label>`;
    }).join('') + (filtered.length > 500 ? `<p class="text-center text-[10px] text-slate-500 py-2">${_esc(t('areas.picker_truncated', { count: filtered.length - 500 }))}</p>` : '');
}
