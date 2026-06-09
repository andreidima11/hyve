/**
 * Generic custom dropdown + native <select> auto-upgrade (settings UI).
 */
import { escapeHtml } from './utils.js';
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
function _rebuildGenericSelect(dd) {
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
        _rebuildGenericSelect(dd);
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
    _rebuildGenericSelect(dd);
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
let _genericSelectBound = false;
if (typeof document !== 'undefined' && !_genericSelectBound) {
    _genericSelectBound = true;
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
let _genericSelectSeq = 0;
function _isUpgradableSelect(sel) {
    if (!sel || sel.tagName !== 'SELECT')
        return false;
    if (sel.multiple || sel.size > 1)
        return false;
    if (sel.classList.contains('dashboard-custom-select-native'))
        return false;
    if (sel.classList.contains('native-select'))
        return false;
    if (sel.hasAttribute('data-no-custom-select'))
        return false;
    return true;
}
export function upgradeNativeSelect(sel) {
    if (!_isUpgradableSelect(sel))
        return;
    if (!sel.id)
        sel.id = `cselect-${++_genericSelectSeq}`;
    const nextEl = sel.nextElementSibling;
    if (nextEl && nextEl.classList.contains('js-generic-select') && nextEl.getAttribute('data-target') === sel.id) {
        _rebuildGenericSelect(nextEl);
        return;
    }
    sel.classList.add('dashboard-custom-select-native');
    const wrap = document.createElement('div');
    wrap.className = 'dashboard-custom-select js-generic-select';
    wrap.setAttribute('data-target', sel.id);
    wrap.setAttribute('data-open', 'false');
    wrap.innerHTML = '<button type="button" class="dashboard-custom-select__button"><span class="dashboard-custom-select__value">—</span><i class="fas fa-chevron-down"></i></button><div class="dashboard-custom-select__menu"></div>';
    sel.insertAdjacentElement('afterend', wrap);
    _rebuildGenericSelect(wrap);
    if (!sel._optObserver && typeof MutationObserver !== 'undefined') {
        sel._optObserver = new MutationObserver(() => {
            const ov = sel.nextElementSibling;
            if (ov && ov.classList.contains('js-generic-select'))
                _rebuildGenericSelect(ov);
        });
        sel._optObserver.observe(sel, { childList: true });
    }
}
export function upgradeNativeSelects(root) {
    const scope = root || document;
    if (scope instanceof HTMLSelectElement) {
        upgradeNativeSelect(scope);
        return;
    }
    scope.querySelectorAll?.('select').forEach((node) => upgradeNativeSelect(node));
}
let _nativeSelectAutoUpgrade = false;
if (typeof document !== 'undefined' && !_nativeSelectAutoUpgrade) {
    _nativeSelectAutoUpgrade = true;
    const runAll = () => upgradeNativeSelects(document);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runAll, { once: true });
    }
    else {
        runAll();
    }
    document.addEventListener('change', (e) => {
        const sel = e.target;
        if (sel instanceof HTMLSelectElement && sel.classList.contains('dashboard-custom-select-native')) {
            const overlay = sel.nextElementSibling;
            if (overlay && overlay.classList.contains('js-generic-select')) {
                _rebuildGenericSelect(overlay);
            }
        }
    }, true);
    let _pending = false;
    const observer = new MutationObserver((mutations) => {
        let found = false;
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1)
                    continue;
                const el = node;
                if (el.tagName === 'SELECT' || (el.querySelector && el.querySelector('select'))) {
                    found = true;
                    break;
                }
            }
            if (found)
                break;
        }
        if (found && !_pending) {
            _pending = true;
            requestAnimationFrame(() => { _pending = false; upgradeNativeSelects(document); });
        }
    });
    const startObserver = () => observer.observe(document.body, { childList: true, subtree: true });
    if (document.body)
        startObserver();
    else
        document.addEventListener('DOMContentLoaded', startObserver, { once: true });
}
