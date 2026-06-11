/**
 * Custom dropdown — rebuild, portal menu, document bindings.
 */
import { escapeHtml } from '../utils.js';
import { selectUiState } from './state.js';
function escapeHtmlAttr(s) {
    if (s == null)
        return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
export function rebuildGenericSelect(dd) {
    const target = document.getElementById(dd.dataset.target || '');
    if (!target)
        return;
    const menu = dd.querySelector('.dashboard-custom-select__menu') || dd.__portaledMenu;
    const valueEl = dd.querySelector('.dashboard-custom-select__value');
    if (!menu || !valueEl)
        return;
    const current = target.value;
    const opts = Array.from(target.options || []);
    menu.innerHTML = opts.map(o => {
        const sel = o.value === current;
        return `<button type="button" class="dashboard-custom-select__option" data-value="${escapeHtmlAttr(o.value)}" data-selected="${sel ? 'true' : 'false'}">${escapeHtml((o.textContent || '').trim())}</button>`;
    }).join('');
    const selOpt = opts.find(o => o.value === current) || opts[0];
    valueEl.textContent = selOpt ? (selOpt.textContent || '').trim() : '—';
}
export function initGenericCustomSelects(root) {
    const scope = root || document;
    scope.querySelectorAll('.dashboard-custom-select.js-generic-select[data-target]').forEach((dd) => {
        rebuildGenericSelect(dd);
    });
}
const GENERIC_MENU_Z = 9999;
function _positionGenericMenu(dd) {
    const menu = dd.__portaledMenu;
    if (!menu)
        return;
    const btn = dd.querySelector('.dashboard-custom-select__button');
    if (!btn)
        return;
    const r = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = Math.round(r.left) + 'px';
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    menu.style.right = 'auto';
    menu.style.width = Math.round(r.width) + 'px';
    menu.style.minWidth = Math.round(r.width) + 'px';
    menu.style.zIndex = String(GENERIC_MENU_Z);
    const mh = menu.offsetHeight;
    if (r.bottom + 6 + mh > window.innerHeight && r.top - 6 - mh > 0) {
        menu.style.top = Math.round(r.top - 6 - mh) + 'px';
    }
}
function _openGenericSelect(dd) {
    rebuildGenericSelect(dd);
    dd.dataset.open = 'true';
    const menu = dd.querySelector('.dashboard-custom-select__menu');
    if (menu && menu.parentElement !== document.body) {
        const ph = document.createComment('cselect-menu');
        menu.__placeholder = ph;
        menu.__ownerDd = dd;
        menu.parentElement.insertBefore(ph, menu);
        document.body.appendChild(menu);
        dd.__portaledMenu = menu;
        menu.style.display = 'grid';
        menu.style.gap = '3px';
    }
    _positionGenericMenu(dd);
}
function _closeGenericSelect(dd) {
    dd.dataset.open = 'false';
    const menu = dd.__portaledMenu;
    if (menu) {
        menu.style.display = '';
        menu.style.position = '';
        menu.style.left = '';
        menu.style.top = '';
        menu.style.right = '';
        menu.style.width = '';
        menu.style.minWidth = '';
        menu.style.zIndex = '';
        menu.style.gap = '';
        if (menu.__placeholder && menu.__placeholder.parentElement) {
            menu.__placeholder.parentElement.insertBefore(menu, menu.__placeholder);
            menu.__placeholder.remove();
        }
        menu.__placeholder = null;
        dd.__portaledMenu = null;
    }
}
function _closeAllGenericSelects(except) {
    document.querySelectorAll('.dashboard-custom-select.js-generic-select[data-open="true"]').forEach(o => {
        if (o !== except)
            _closeGenericSelect(o);
    });
}
if (typeof document !== 'undefined' && !selectUiState.genericSelectBound) {
    selectUiState.genericSelectBound = true;
    document.addEventListener('click', (e) => {
        const target = e.target;
        if (!(target instanceof Element))
            return;
        const btn = target.closest('.dashboard-custom-select.js-generic-select .dashboard-custom-select__button');
        if (btn) {
            const dd = btn.closest('.dashboard-custom-select.js-generic-select');
            if (!dd)
                return;
            e.preventDefault();
            e.stopPropagation();
            const willOpen = dd.dataset.open !== 'true';
            _closeAllGenericSelects(dd);
            if (willOpen)
                _openGenericSelect(dd);
            else
                _closeGenericSelect(dd);
            return;
        }
        const opt = target.closest('.dashboard-custom-select.js-generic-select .dashboard-custom-select__option, .dashboard-custom-select__menu .dashboard-custom-select__option');
        if (opt) {
            const menuEl = opt.closest('.dashboard-custom-select__menu');
            const dd = (menuEl && menuEl.__ownerDd) || opt.closest('.dashboard-custom-select.js-generic-select');
            if (!dd)
                return;
            e.preventDefault();
            e.stopPropagation();
            const selectTarget = document.getElementById(dd.dataset.target || '');
            const value = opt.dataset.value;
            if (selectTarget && value != null && selectTarget.value !== value) {
                selectTarget.value = value;
                try {
                    selectTarget.dispatchEvent(new Event('change', { bubbles: true }));
                }
                catch (_) { }
            }
            const menuRoot = dd.__portaledMenu || dd;
            menuRoot.querySelectorAll('.dashboard-custom-select__option').forEach(o => {
                o.dataset.selected = o.dataset.value === value ? 'true' : 'false';
            });
            const valueEl = dd.querySelector('.dashboard-custom-select__value');
            if (valueEl)
                valueEl.textContent = (opt.textContent || '').trim();
            _closeGenericSelect(dd);
            return;
        }
        document.querySelectorAll('.dashboard-custom-select.js-generic-select[data-open="true"]').forEach(o => {
            const el = o;
            const m = el.__portaledMenu;
            if (!o.contains(target) && !(m && m.contains(target)))
                _closeGenericSelect(el);
        });
    }, true);
    const _repositionOpenGenericMenus = () => {
        document.querySelectorAll('.dashboard-custom-select.js-generic-select[data-open="true"]').forEach((o) => {
            _positionGenericMenu(o);
        });
    };
    window.addEventListener('resize', _repositionOpenGenericMenus);
    document.addEventListener('scroll', _repositionOpenGenericMenus, true);
}
