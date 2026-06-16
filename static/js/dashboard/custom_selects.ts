/**
 * Rich custom dropdowns for dashboard modals (replaces native <select> for listed IDs).
 */

import { DASHBOARD_CUSTOM_SELECT_IDS } from './constants.js';
import { escapeHtml } from './helpers.js';
import {
    portalSelectMenu,
    positionPortaledSelectMenu,
    restorePortaledSelectMenu,
    bindPortaledSelectMenuReposition,
} from '../custom_selects/portal.js';
import type { PortaledSelectMenu } from '../custom_selects/types.js';
import type { DashboardCustomSelectState } from '../types/dashboard.js';

type DashboardPortaledMenu = PortaledSelectMenu;

interface DashboardCustomSelectUiState extends DashboardCustomSelectState {
    portaledMenu: DashboardPortaledMenu | null;
}

const _dashboardCustomSelects = new WeakMap<HTMLSelectElement, DashboardCustomSelectUiState>();
let _dashboardCustomSelectOutsideBound = false;

function dashboardSelectLabel(option: HTMLOptionElement | null | undefined): string {
    return String(option?.label || option?.textContent || option?.value || '').trim() || '—';
}

function _positionDashboardMenu(state: DashboardCustomSelectUiState): void {
    const menu = state.portaledMenu || state.menu;
    if (!menu) return;
    positionPortaledSelectMenu(state.button, menu);
}

function _openDashboardMenu(state: DashboardCustomSelectUiState): void {
    portalSelectMenu(state.wrap, state.menu as DashboardPortaledMenu);
    state.portaledMenu = state.menu as DashboardPortaledMenu;
    _positionDashboardMenu(state);
}

function _closeDashboardMenu(state: DashboardCustomSelectUiState): void {
    restorePortaledSelectMenu(state.wrap, state.portaledMenu);
    state.portaledMenu = null;
}

export function closeDashboardCustomSelects(exceptWrap: HTMLElement | null = null): void {
    document.querySelectorAll('.dashboard-custom-select[data-open="true"]').forEach((wrap) => {
        if (exceptWrap && wrap === exceptWrap) return;
        if (wrap.classList.contains('js-generic-select')) return;
        (wrap as HTMLElement).dataset.open = 'false';
        const button = wrap.querySelector('.dashboard-custom-select__button');
        if (button) button.setAttribute('aria-expanded', 'false');
        const select = wrap.previousElementSibling;
        if (select instanceof HTMLSelectElement) {
            const state = _dashboardCustomSelects.get(select);
            if (state) _closeDashboardMenu(state);
        }
    });
}

export function syncDashboardCustomSelect(select: HTMLSelectElement): void {
    const state = _dashboardCustomSelects.get(select);
    if (!state) return;
    const options = Array.from(select.options || []);
    const selectedIndex = Math.max(0, select.selectedIndex);
    const selected = options[selectedIndex] || options[0];
    state.value.textContent = dashboardSelectLabel(selected);
    state.button.disabled = !!select.disabled || !options.length;
    state.wrap.dataset.disabled = state.button.disabled ? 'true' : 'false';
    state.menu.innerHTML = options.map((option, index) => {
        const isSelected = index === selectedIndex;
        const disabled = option.disabled ? ' disabled' : '';
        return `<button type="button" role="option" class="dashboard-custom-select__option" data-index="${index}" data-selected="${isSelected ? 'true' : 'false'}" aria-selected="${isSelected ? 'true' : 'false'}"${disabled}>${escapeHtml(dashboardSelectLabel(option))}</button>`;
    }).join('');
}

export function enhanceDashboardCustomSelect(select: HTMLSelectElement | null): void {
    if (!select || select.tagName !== 'SELECT') return;
    if (!DASHBOARD_CUSTOM_SELECT_IDS.has(select.id) && !select.matches('[data-vis-field="op"]')) return;

    let state = _dashboardCustomSelects.get(select);
    if (!state) {
        const genericOverlay = select.nextElementSibling;
        if (genericOverlay
            && genericOverlay.classList.contains('dashboard-custom-select')
            && genericOverlay.classList.contains('js-generic-select')
            && genericOverlay.getAttribute('data-target') === select.id) {
            genericOverlay.remove();
        }
        const wrap = document.createElement('div');
        wrap.className = 'dashboard-custom-select';
        if (select.matches('[data-vis-field="op"]') || String(select.className || '').includes('text-xs')) {
            wrap.classList.add('dashboard-custom-select--compact');
        }
        wrap.dataset.open = 'false';
        wrap.innerHTML = `
            <button type="button" class="dashboard-custom-select__button" aria-haspopup="listbox" aria-expanded="false">
                <span class="dashboard-custom-select__value"></span>
                <i class="fas fa-chevron-down"></i>
            </button>
            <div class="dashboard-custom-select__menu" role="listbox"></div>
        `;
        select.classList.add('dashboard-custom-select-native');
        select.setAttribute('aria-hidden', 'true');
        select.tabIndex = -1;
        select.insertAdjacentElement('afterend', wrap);

        const button = wrap.querySelector('.dashboard-custom-select__button') as HTMLButtonElement;
        const value = wrap.querySelector('.dashboard-custom-select__value') as HTMLSpanElement;
        const menu = wrap.querySelector('.dashboard-custom-select__menu') as HTMLDivElement;
        state = { wrap, button, value, menu, portaledMenu: null };
        _dashboardCustomSelects.set(select, state);

        state.button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const willOpen = state!.wrap.dataset.open !== 'true';
            closeDashboardCustomSelects(state!.wrap);
            if (willOpen) {
                state!.wrap.dataset.open = 'true';
                state!.button.setAttribute('aria-expanded', 'true');
                _openDashboardMenu(state!);
            } else {
                state!.wrap.dataset.open = 'false';
                state!.button.setAttribute('aria-expanded', 'false');
                _closeDashboardMenu(state!);
            }
        });
        state.button.addEventListener('keydown', (event) => {
            if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            closeDashboardCustomSelects(state!.wrap);
            state!.wrap.dataset.open = 'true';
            state!.button.setAttribute('aria-expanded', 'true');
            _openDashboardMenu(state!);
            const selectedButton = state!.menu.querySelector('[data-selected="true"]') as HTMLButtonElement | null
                || state!.menu.querySelector('.dashboard-custom-select__option:not(:disabled)') as HTMLButtonElement | null;
            selectedButton?.focus?.();
        });
        state.menu.addEventListener('click', (event) => {
            const target = event.target as Element | null;
            const optionButton = target?.closest('.dashboard-custom-select__option') as HTMLButtonElement | null;
            if (!optionButton || optionButton.disabled) return;
            event.preventDefault();
            event.stopPropagation();
            const index = Number(optionButton.getAttribute('data-index'));
            if (Number.isFinite(index) && select.options[index]) {
                select.selectedIndex = index;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
            syncDashboardCustomSelect(select);
            closeDashboardCustomSelects();
            state!.button.focus?.();
        });
        state.menu.addEventListener('keydown', (event) => {
            const items = Array.from(state!.menu.querySelectorAll('.dashboard-custom-select__option:not(:disabled)')) as HTMLButtonElement[];
            const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === 'Escape') {
                event.preventDefault();
                closeDashboardCustomSelects();
                state!.button.focus?.();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                const nextIndex = Math.min(Math.max(currentIndex + delta, 0), items.length - 1);
                items[nextIndex]?.focus?.();
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                (document.activeElement as HTMLButtonElement | null)?.click?.();
            }
        });
        select.addEventListener('change', () => syncDashboardCustomSelect(select));
    }

    syncDashboardCustomSelect(select);

    if (!_dashboardCustomSelectOutsideBound) {
        _dashboardCustomSelectOutsideBound = true;
        document.addEventListener('click', (event) => {
            const target = event.target as Element | null;
            if (target?.closest('.dashboard-custom-select[data-target]')) return;
            const portaledMenu = target?.closest('.dashboard-custom-select__menu') as DashboardPortaledMenu | null;
            if (portaledMenu?.__ownerDd) return;
            if (target?.closest('.dashboard-custom-select')) return;
            closeDashboardCustomSelects();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') closeDashboardCustomSelects();
        });
        bindPortaledSelectMenuReposition(
            '.dashboard-custom-select:not(.js-generic-select)',
            (owner) => {
                for (const menu of document.body.querySelectorAll('.dashboard-custom-select__menu')) {
                    const portaled = menu as DashboardPortaledMenu;
                    if (portaled.__ownerDd === owner) return menu as HTMLElement;
                }
                return null;
            },
        );
    }
}

export function enhanceDashboardCustomSelects(root: ParentNode = document): void {
    const scope = root instanceof Document ? root : (root as Element);
    const selectors = [
        ...Array.from(DASHBOARD_CUSTOM_SELECT_IDS, (id) => `#${id}`),
        'select[data-vis-field="op"]',
    ].join(',');
    scope.querySelectorAll(selectors).forEach((select) => {
        enhanceDashboardCustomSelect(select as HTMLSelectElement);
    });
}
