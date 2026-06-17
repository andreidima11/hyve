/**
 * Searchable entity combobox for Hyveview schema forms.
 */

import { t } from '../../js/lang/index.js';
import type { HyveviewEntityState } from '../types/card.js';

export interface HyveviewEntitySearchFieldApi {
    element: HTMLElement;
    getValue: () => string;
    setValue: (entityId: string) => void;
}

function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeAttr(value: unknown): string {
    return escapeHtml(value).replace(/'/g, '&#39;');
}

function entityLabel(entity: HyveviewEntityState): string {
    const id = String(entity.entity_id || '');
    const name = String(entity.friendly_name || '').trim();
    return name ? `${id} (${name})` : id;
}

function entityMatches(entity: HyveviewEntityState, query: string): boolean {
    if (!query) return true;
    const haystack = [
        entity.entity_id,
        entity.friendly_name,
        entity.domain,
    ].map((part) => String(part || '').toLowerCase()).join(' ');
    return haystack.includes(query);
}

let _docBound = false;

function _bindDocumentClose(): void {
    if (_docBound || typeof document === 'undefined') return;
    _docBound = true;
    document.addEventListener('mousedown', (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        document.querySelectorAll('.hv-entity-search[data-open="true"]').forEach((node) => {
            if (node.contains(target)) return;
            (node as HTMLElement).dataset.open = 'false';
            node.querySelector('.hv-entity-search__menu')?.classList.add('hidden');
        });
    });
}

export function buildEntitySearchField(
    entities: HyveviewEntityState[],
    initialValue = '',
): HyveviewEntitySearchFieldApi {
    _bindDocumentClose();

    const wrap = document.createElement('div');
    wrap.className = 'hv-entity-search';
    wrap.dataset.open = 'false';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'hv-entity-search__input';
    input.autocomplete = 'off';
    input.placeholder = t('dashboard.entity_choose_or_search');

    const menu = document.createElement('div');
    menu.className = 'hv-entity-search__menu hidden';
    menu.setAttribute('role', 'listbox');

    let storedValue = '';
    let highlightIndex = -1;

    const setOpen = (open: boolean) => {
        wrap.dataset.open = open ? 'true' : 'false';
        menu.classList.toggle('hidden', !open);
    };

    const emitChange = () => {
        wrap.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const applyValue = (entityId: string, label: string) => {
        storedValue = entityId;
        input.value = label;
        setOpen(false);
        emitChange();
    };

    const renderMenu = () => {
        const query = input.value.trim().toLowerCase();
        const filtered = entities.filter((entity) => entityMatches(entity, query)).slice(0, 80);
        if (!filtered.length) {
            menu.innerHTML = `<div class="hv-entity-search__empty">${escapeHtml(t('dashboard.entity_search_no_results'))}</div>`;
            highlightIndex = -1;
            return;
        }
        menu.innerHTML = filtered.map((entity, index) => {
            const id = String(entity.entity_id || '');
            const active = index === highlightIndex ? ' is-active' : '';
            return `<button type="button" class="hv-entity-search__option${active}" role="option" data-entity-id="${escapeAttr(id)}">${escapeHtml(entityLabel(entity))}</button>`;
        }).join('');
    };

    const selectHighlighted = () => {
        const options = Array.from(menu.querySelectorAll('.hv-entity-search__option[data-entity-id]')) as HTMLButtonElement[];
        if (highlightIndex < 0 || highlightIndex >= options.length) return;
        const option = options[highlightIndex];
        const entityId = option.dataset.entityId || '';
        applyValue(entityId, (option.textContent || '').trim());
    };

    if (initialValue) {
        const selected = entities.find((entity) => entity.entity_id === initialValue);
        storedValue = initialValue;
        input.value = selected ? entityLabel(selected) : `${initialValue} (offline)`;
    }

    input.addEventListener('focus', () => {
        highlightIndex = -1;
        renderMenu();
        setOpen(true);
    });

    input.addEventListener('input', () => {
        highlightIndex = -1;
        storedValue = '';
        renderMenu();
        setOpen(true);
        emitChange();
    });

    input.addEventListener('keydown', (event) => {
        const options = menu.querySelectorAll('.hv-entity-search__option[data-entity-id]');
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (!options.length) return;
            highlightIndex = Math.min(highlightIndex + 1, options.length - 1);
            renderMenu();
            options[highlightIndex]?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (!options.length) return;
            highlightIndex = Math.max(highlightIndex - 1, 0);
            renderMenu();
            options[highlightIndex]?.scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter') {
            if (wrap.dataset.open === 'true' && highlightIndex >= 0) {
                event.preventDefault();
                selectHighlighted();
            }
        } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
            input.blur();
        }
    });

    menu.addEventListener('click', (event) => {
        const option = (event.target as Element | null)?.closest('.hv-entity-search__option[data-entity-id]') as HTMLButtonElement | null;
        if (!option) return;
        event.preventDefault();
        applyValue(option.dataset.entityId || '', (option.textContent || '').trim());
    });

    wrap.append(input, menu);

    return {
        element: wrap,
        getValue: () => storedValue,
        setValue: (entityId: string) => {
            const selected = entities.find((entity) => entity.entity_id === entityId);
            storedValue = entityId;
            input.value = selected ? entityLabel(selected) : (entityId ? `${entityId} (offline)` : '');
        },
    };
}
