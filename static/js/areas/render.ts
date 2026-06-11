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
export function _renderAreas() {
    const list = document.getElementById('areas-list');
    const empty = document.getElementById('areas-empty');
    const toolbar = document.getElementById('areas-toolbar');
    if (!list) return;
    if (!areaState.areasCache.length) {
        list.innerHTML = '';
        if (toolbar) toolbar.classList.add('hidden');
        if (empty) empty.classList.remove('hidden');
        return;
    }
    if (empty) empty.classList.add('hidden');
    if (toolbar) toolbar.classList.remove('hidden');
    list.innerHTML = areaState.areasCache.map((a) => {
        const id = _esc(a.id);
        const name = _esc(a.name || a.id);
        const aliases = Array.isArray(a.aliases) ? a.aliases : [];
        const aliasText = aliases.length
            ? `<span class="text-[10px] text-slate-500 truncate">${_esc(aliases.join(', '))}</span>`
            : '';
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
        return `<span class="inline-flex items-center gap-1.5 text-[11px] bg-white/5 border border-white/10 rounded-full pl-2 pr-1 py-0.5 text-slate-300" title="${_esc(eid)}">
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
