/**
 * Rich custom dropdowns for dashboard modals (replaces native <select> for listed IDs).
 */

import { DASHBOARD_CUSTOM_SELECT_IDS } from './constants.js';
import { escapeHtml } from './helpers.js';

const _dashboardCustomSelects = new WeakMap();
let _dashboardCustomSelectOutsideBound = false;

function dashboardSelectLabel(option) {
    return String(option?.label || option?.textContent || option?.value || '').trim() || '—';
}

export function closeDashboardCustomSelects(exceptWrap = null) {
    document.querySelectorAll('.dashboard-custom-select[data-open="true"]').forEach(wrap => {
        if (exceptWrap && wrap === exceptWrap) return;
        wrap.dataset.open = 'false';
        const button = wrap.querySelector('.dashboard-custom-select__button');
        if (button) button.setAttribute('aria-expanded', 'false');
    });
}

export function syncDashboardCustomSelect(select) {
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

export function enhanceDashboardCustomSelect(select) {
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

        state = {
            wrap,
            button: wrap.querySelector('.dashboard-custom-select__button'),
            value: wrap.querySelector('.dashboard-custom-select__value'),
            menu: wrap.querySelector('.dashboard-custom-select__menu'),
        };
        _dashboardCustomSelects.set(select, state);

        state.button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const willOpen = state.wrap.dataset.open !== 'true';
            closeDashboardCustomSelects(state.wrap);
            state.wrap.dataset.open = willOpen ? 'true' : 'false';
            state.button.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        });
        state.button.addEventListener('keydown', event => {
            if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
            event.preventDefault();
            closeDashboardCustomSelects(state.wrap);
            state.wrap.dataset.open = 'true';
            state.button.setAttribute('aria-expanded', 'true');
            const selectedButton = state.menu.querySelector('[data-selected="true"]') || state.menu.querySelector('.dashboard-custom-select__option:not(:disabled)');
            selectedButton?.focus?.();
        });
        state.menu.addEventListener('click', event => {
            const optionButton = event.target.closest('.dashboard-custom-select__option');
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
            state.button.focus?.();
        });
        state.menu.addEventListener('keydown', event => {
            const items = Array.from(state.menu.querySelectorAll('.dashboard-custom-select__option:not(:disabled)'));
            const currentIndex = items.indexOf(document.activeElement);
            if (event.key === 'Escape') {
                event.preventDefault();
                closeDashboardCustomSelects();
                state.button.focus?.();
            } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                const nextIndex = Math.min(Math.max(currentIndex + delta, 0), items.length - 1);
                items[nextIndex]?.focus?.();
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                document.activeElement?.click?.();
            }
        });
        select.addEventListener('change', () => syncDashboardCustomSelect(select));
    }

    syncDashboardCustomSelect(select);

    if (!_dashboardCustomSelectOutsideBound) {
        _dashboardCustomSelectOutsideBound = true;
        document.addEventListener('click', event => {
            if (event.target.closest('.dashboard-custom-select')) return;
            closeDashboardCustomSelects();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeDashboardCustomSelects();
        });
    }
}

export function enhanceDashboardCustomSelects(root = document) {
    const scope = root?.querySelectorAll ? root : document;
    const selectors = [
        ...Array.from(DASHBOARD_CUSTOM_SELECT_IDS, id => `#${id}`),
        'select[data-vis-field="op"]',
    ].join(',');
    scope.querySelectorAll(selectors).forEach(select => enhanceDashboardCustomSelect(select));
}
