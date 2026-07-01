/**
 * Custom dropdown — rebuild, portal menu, document bindings.
 */
import type { GenericCustomSelectElement, PortaledSelectMenu } from './types.js';
import {
    bindPortaledSelectMenuReposition,
    portalSelectMenu,
    positionPortaledSelectMenu,
    restorePortaledSelectMenu,
} from './portal.js';
import { selectUiState } from './state.js';

const DD_SELECTOR = '.dashboard-custom-select[data-target]';

function escapeHtmlAttr(s: unknown): string {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function _resolveCustomSelectFromTarget(target: Element): {
    dd: GenericCustomSelectElement;
    btn: HTMLElement;
} | null {
    const btn = target.closest('.dashboard-custom-select__button');
    if (!(btn instanceof HTMLElement)) return null;
    const dd = btn.closest(DD_SELECTOR) as GenericCustomSelectElement | null;
    if (!dd) return null;
    return { dd, btn };
}

function _resolveCustomSelectFromOption(target: Element): {
    dd: GenericCustomSelectElement;
    opt: HTMLElement;
} | null {
    const opt = target.closest('.dashboard-custom-select__option');
    if (!opt) return null;
    const menuEl = opt.closest('.dashboard-custom-select__menu') as PortaledSelectMenu | null;
    const dd = (menuEl?.__ownerDd
        || opt.closest(DD_SELECTOR)) as GenericCustomSelectElement | null;
    // Menus owned by the dashboard enhancer share the same class names but have
    // no data-target; those handle their own clicks, so don't claim them here.
    if (!dd || !dd.matches?.(DD_SELECTOR)) return null;
    return { dd, opt: opt as HTMLElement };
}

function _syncCustomSelectValue(dd: GenericCustomSelectElement, current: string) {
    const menu = dd.__portaledMenu || dd.querySelector('.dashboard-custom-select__menu');
    const valueEl = dd.querySelector('.dashboard-custom-select__value');
    if (!menu || !valueEl) return;
    let selectedLabel = '';
    menu.querySelectorAll('.dashboard-custom-select__option').forEach((node) => {
        const el = node as HTMLElement;
        const selected = el.dataset.value === current;
        el.dataset.selected = selected ? 'true' : 'false';
        if (selected) selectedLabel = (el.textContent || '').trim();
    });
    if (selectedLabel) valueEl.textContent = selectedLabel;
}

export function rebuildGenericSelect(dd: GenericCustomSelectElement) {
    const target = document.getElementById(dd.dataset.target || '');
    const menu = dd.querySelector('.dashboard-custom-select__menu') || dd.__portaledMenu;
    const valueEl = dd.querySelector('.dashboard-custom-select__value');
    if (!menu || !valueEl) return;

    if (target instanceof HTMLSelectElement) {
        const current = target.value;
        const opts = Array.from(target.options || []);
        menu.innerHTML = opts.map(o => {
            const sel = o.value === current;
            return `<button type="button" class="dashboard-custom-select__option" data-value="${escapeHtmlAttr(o.value)}" data-selected="${sel ? 'true' : 'false'}">${escapeHtmlAttr((o.textContent || '').trim())}</button>`;
        }).join('');
        const selOpt = opts.find(o => o.value === current) || opts[0];
        valueEl.textContent = selOpt ? (selOpt.textContent || '').trim() : '—';
        return;
    }

    if (target instanceof HTMLInputElement) {
        _syncCustomSelectValue(dd, target.value);
    }
}

export function initGenericCustomSelects(root?: ParentNode) {
    const scope = root || document;
    scope.querySelectorAll(DD_SELECTOR).forEach((dd) => {
        rebuildGenericSelect(dd as GenericCustomSelectElement);
    });
}

function _positionGenericMenu(dd: GenericCustomSelectElement) {
    const menu = dd.__portaledMenu;
    const btn = dd.querySelector('.dashboard-custom-select__button');
    if (!menu || !(btn instanceof HTMLElement)) return;
    positionPortaledSelectMenu(btn, menu);
}

function _setCustomSelectOpen(dd: GenericCustomSelectElement, open: boolean) {
    const btn = dd.querySelector('.dashboard-custom-select__button');
    dd.dataset.open = open ? 'true' : 'false';
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function _openGenericSelect(dd: GenericCustomSelectElement) {
    rebuildGenericSelect(dd);
    _setCustomSelectOpen(dd, true);
    const menu = (dd.__portaledMenu
        || dd.querySelector('.dashboard-custom-select__menu')) as PortaledSelectMenu | null;
    if (menu) {
        portalSelectMenu(dd, menu);
        dd.__portaledMenu = menu;
    }
    _positionGenericMenu(dd);
}

function _closeGenericSelect(dd: GenericCustomSelectElement) {
    _setCustomSelectOpen(dd, false);
    const menu = dd.__portaledMenu;
    restorePortaledSelectMenu(dd, menu);
    dd.__portaledMenu = null;
}

function _closeAllGenericSelects(except: GenericCustomSelectElement | null) {
    document.querySelectorAll(`${DD_SELECTOR}[data-open="true"]`).forEach(o => {
        if (o !== except) _closeGenericSelect(o as GenericCustomSelectElement);
    });
}

function _applyCustomSelectValue(dd: GenericCustomSelectElement, value: string, label: string) {
    const selectTarget = document.getElementById(dd.dataset.target || '');
    if (selectTarget instanceof HTMLSelectElement) {
        if (selectTarget.value !== value) {
            selectTarget.value = value;
            try { selectTarget.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
        }
    } else if (selectTarget instanceof HTMLInputElement) {
        if (selectTarget.value !== value) {
            selectTarget.value = value;
            try { selectTarget.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
        }
    }
    const menuRoot = dd.__portaledMenu || dd;
    menuRoot.querySelectorAll('.dashboard-custom-select__option').forEach(o => {
        (o as HTMLElement).dataset.selected = (o as HTMLElement).dataset.value === value ? 'true' : 'false';
    });
    const valueEl = dd.querySelector('.dashboard-custom-select__value');
    if (valueEl) valueEl.textContent = label || value || '—';
}

if (typeof document !== 'undefined' && !selectUiState.genericSelectBound) {
    selectUiState.genericSelectBound = true;
    document.addEventListener('click', (e) => {
        const target = e.target;
        if (!(target instanceof Element)) return;

        const toggle = _resolveCustomSelectFromTarget(target);
        if (toggle) {
            const { dd } = toggle;
            e.preventDefault();
            e.stopPropagation();
            const willOpen = dd.dataset.open !== 'true';
            _closeAllGenericSelects(dd);
            if (willOpen) _openGenericSelect(dd); else _closeGenericSelect(dd);
            return;
        }

        const picked = _resolveCustomSelectFromOption(target);
        if (picked) {
            const { dd, opt } = picked;
            e.preventDefault();
            e.stopPropagation();
            const value = opt.dataset.value ?? '';
            _applyCustomSelectValue(dd, value, (opt.textContent || '').trim());
            _closeGenericSelect(dd);
            return;
        }

        document.querySelectorAll(`${DD_SELECTOR}[data-open="true"]`).forEach(o => {
            const el = o as GenericCustomSelectElement;
            const m = el.__portaledMenu;
            if (!o.contains(target) && !(m && m.contains(target))) _closeGenericSelect(el);
        });
    }, true);

    bindPortaledSelectMenuReposition(
        DD_SELECTOR,
        (owner) => (owner as GenericCustomSelectElement).__portaledMenu,
    );
}
