/**
 * Dashboard entity picker (add/edit widget modals).
 */
import { getDashboardCardMeta } from './card_catalog.js';
let _deps = null;
let _activeIndex = -1;
let _outsideBound = false;
function deps() {
    if (!_deps)
        throw new Error('Dashboard entity picker not initialized');
    return _deps;
}
export function initDashboardEntityPicker(depsIn) {
    _deps = depsIn;
}
export function entityAllowedForCard(item, type = 'button') {
    const domain = String(item?.domain || item?.entity_id?.split?.('.')[0] || '').toLowerCase();
    const meta = getDashboardCardMeta(type);
    const renderer = String(meta.renderer || type || '').toLowerCase();
    const filter = String(meta.entity_filter || (renderer === 'label' ? 'none' : (renderer === 'info' ? 'all' : 'controllable'))).toLowerCase();
    if (filter === 'none')
        return false;
    if (filter === 'all')
        return true;
    if (filter === 'controllable')
        return item?.controllable !== false;
    if (filter === 'weather')
        return domain === 'weather';
    if (filter === 'climate')
        return domain === 'climate';
    if (filter === 'scene')
        return domain === 'scene';
    return domain === filter;
}
function getEntitySearchValue(input) {
    return String(input?.value || '').trim().toLowerCase();
}
export function entityMatchesSearch(item, query) {
    if (!query)
        return true;
    const aliases = Array.isArray(item?.aliases) ? item.aliases : [];
    const haystack = [item?.name, item?.entity_id, item?.source, item?.domain, ...aliases]
        .map((value) => String(value || '').toLowerCase())
        .join(' ');
    return haystack.includes(query);
}
export function entityOptionLabel(item) {
    const sourcePrefix = item?.source && item.source !== 'zigbee2mqtt' ? `${String(item.source).toUpperCase()} • ` : '';
    return `${sourcePrefix}${item?.name || item?.entity_id} • ${item?.entity_id}`;
}
export function setEntitySelectState(message, disabled = true, mode = 'add') {
    const input = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-select' : 'dashboard-entity-select');
    const list = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-options' : 'dashboard-entity-options');
    if (!input)
        return;
    input.disabled = !!disabled;
    input.value = '';
    input.dataset.currentValue = '';
    input.placeholder = message;
    if (list)
        list.innerHTML = '';
}
export function resolveEntityMatch(input, type = 'button') {
    if (!input || type === 'label')
        return null;
    const raw = String(input.value || '').trim();
    if (!raw)
        return null;
    const allItems = Array.isArray(deps().getCache()?.available_entities) ? deps().getCache().available_entities : [];
    const currentId = input.dataset.currentValue;
    if (currentId) {
        const direct = allItems.find((item) => item.entity_id === currentId);
        if (direct && entityAllowedForCard(direct, type))
            return direct;
    }
    const items = allItems.filter((item) => entityAllowedForCard(item, type));
    const normalized = raw.toLowerCase();
    const exact = items.find((item) => {
        const candidates = [item.entity_id, item.name, entityOptionLabel(item)];
        return candidates.some((value) => String(value || '').toLowerCase() === normalized);
    });
    if (exact) {
        input.dataset.currentValue = exact.entity_id;
        input.value = entityOptionLabel(exact);
        return exact;
    }
    const matches = items.filter((item) => entityMatchesSearch(item, normalized));
    if (matches.length === 1) {
        input.dataset.currentValue = matches[0].entity_id;
        input.value = entityOptionLabel(matches[0]);
        return matches[0];
    }
    return null;
}
export function renderEntityOptions(input, type = 'button', selectedValue = '') {
    if (!input)
        return;
    const { escapeHtml, t } = deps();
    const items = Array.isArray(deps().getCache()?.available_entities) ? deps().getCache().available_entities : [];
    const searchQuery = getEntitySearchValue(input);
    const list = document.getElementById(input.id === 'dashboard-edit-entity-select' ? 'dashboard-edit-entity-options' : 'dashboard-entity-options');
    if (type === 'label') {
        input.disabled = true;
        input.value = '';
        input.dataset.currentValue = '';
        input.placeholder = t('dashboard.entity_not_required_label') || 'Entity is not required for labels.';
        if (list)
            list.innerHTML = '';
        return;
    }
    const filtered = items
        .filter((item) => entityAllowedForCard(item, type))
        .filter((item) => entityMatchesSearch(item, searchQuery));
    if (list) {
        list.innerHTML = filtered.map((item) => {
            const label = entityOptionLabel(item);
            return `<option value="${escapeHtml(label)}"></option>`;
        }).join('');
    }
    input.disabled = false;
    input.placeholder = searchQuery
        ? (filtered.length
            ? (t('dashboard.entity_choose_from_results') || 'Choose the entity you want...')
            : (t('dashboard.entity_search_no_results') || 'No entities found for this search.'))
        : (t('dashboard.entity_choose_or_search') || 'Choose or search an entity...');
    if (selectedValue) {
        const selected = items.find((item) => item.entity_id === selectedValue);
        if (selected) {
            input.value = entityOptionLabel(selected);
            input.dataset.currentValue = selected.entity_id;
        }
    }
}
function currentEntityPickerItems(mode) {
    const input = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-select' : 'dashboard-entity-select');
    const type = document.getElementById(mode === 'edit' ? 'dashboard-edit-widget-type' : 'dashboard-widget-type')?.value || 'button';
    const items = Array.isArray(deps().getCache()?.available_entities) ? deps().getCache().available_entities : [];
    const query = getEntitySearchValue(input);
    return items
        .filter((item) => entityAllowedForCard(item, type))
        .filter((item) => entityMatchesSearch(item, query))
        .slice()
        .sort((a, b) => {
        const ac = a.controllable === false ? 1 : 0;
        const bc = b.controllable === false ? 1 : 0;
        if (ac !== bc)
            return ac - bc;
        return String(a.name || a.entity_id).localeCompare(String(b.name || b.entity_id));
    })
        .slice(0, 80);
}
function renderEntityPickerMenu(mode = 'add') {
    const { escapeHtml, t, entityIcon } = deps();
    const menu = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-picker-menu' : 'dashboard-entity-picker-menu');
    if (!menu)
        return;
    const items = currentEntityPickerItems(mode);
    if (!items.length) {
        menu.innerHTML = `<div class="dashboard-entity-picker__empty">${escapeHtml(t('dashboard.climate.entities_empty'))}</div>`;
        menu.classList.remove('hidden');
        return;
    }
    menu.innerHTML = items.map((it, idx) => {
        const isActive = idx === _activeIndex;
        const safeId = escapeHtml(it.entity_id);
        const safeMode = escapeHtml(mode);
        const icon = escapeHtml(entityIcon(it.domain));
        return `<button type="button"
            data-active="${isActive ? 'true' : 'false'}"
            class="dashboard-entity-picker__item"
            data-dash-prevent-default="true"
            data-dash-action="pickEntity"
            data-mode="${safeMode}"
            data-entity-id="${safeId}">
            <i class="${icon} dashboard-entity-picker__icon"></i>
            <span class="dashboard-entity-picker__name">${escapeHtml(it.name || it.entity_id)}</span>
            <span class="dashboard-entity-picker__id">${safeId}</span>
        </button>`;
    }).join('');
    menu.classList.remove('hidden');
}
export function filterDashboardEntityOptions(mode = 'add') {
    renderEntityPickerMenu(mode);
}
export function openDashboardEntityPicker(mode = 'add') {
    _activeIndex = -1;
    const menu = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-picker-menu' : 'dashboard-entity-picker-menu');
    if (menu)
        menu.classList.remove('hidden');
    renderEntityPickerMenu(mode);
    if (!_outsideBound) {
        _outsideBound = true;
        document.addEventListener('click', (ev) => {
            ['add', 'edit'].forEach((m) => {
                const wrap = document.getElementById(m === 'edit' ? 'dashboard-edit-entity-picker' : 'dashboard-entity-picker');
                const menuEl = document.getElementById(m === 'edit' ? 'dashboard-edit-entity-picker-menu' : 'dashboard-entity-picker-menu');
                if (!wrap || !menuEl)
                    return;
                if (!wrap.contains(ev.target))
                    menuEl.classList.add('hidden');
            });
        });
    }
}
export function closeDashboardEntityPicker(mode = 'add') {
    const menu = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-picker-menu' : 'dashboard-entity-picker-menu');
    if (menu)
        menu.classList.add('hidden');
}
export function handleDashboardEntityPickerKeydown(mode, ev) {
    const items = currentEntityPickerItems(mode);
    const menu = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-picker-menu' : 'dashboard-entity-picker-menu');
    if (!menu)
        return;
    if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        if (menu.classList.contains('hidden'))
            openDashboardEntityPicker(mode);
        _activeIndex = Math.min(items.length - 1, _activeIndex + 1);
        renderEntityPickerMenu(mode);
    }
    else if (ev.key === 'ArrowUp') {
        ev.preventDefault();
        _activeIndex = Math.max(0, _activeIndex - 1);
        renderEntityPickerMenu(mode);
    }
    else if (ev.key === 'Enter') {
        const pick = items[_activeIndex] || items[0];
        if (pick) {
            ev.preventDefault();
            pickDashboardEntityOption(mode, pick.entity_id);
        }
    }
    else if (ev.key === 'Escape') {
        closeDashboardEntityPicker(mode);
    }
}
export function pickDashboardEntityOption(mode, entityId) {
    const input = document.getElementById(mode === 'edit' ? 'dashboard-edit-entity-select' : 'dashboard-entity-select');
    if (!input)
        return;
    const items = Array.isArray(deps().getCache()?.available_entities) ? deps().getCache().available_entities : [];
    const found = items.find((it) => it.entity_id === entityId);
    if (found) {
        input.value = entityOptionLabel(found);
        input.dataset.currentValue = found.entity_id;
    }
    else {
        input.value = entityId;
        input.dataset.currentValue = entityId;
    }
    closeDashboardEntityPicker(mode);
    if (mode !== 'edit') {
        const type = document.getElementById('dashboard-widget-type')?.value || 'button';
        if (type === 'climate' && typeof deps().addClimateEntityId === 'function') {
            deps().addClimateEntityId(entityId);
        }
    }
}
