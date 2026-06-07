/**
 * Generic custom dropdown + native <select> auto-upgrade (settings UI).
 */
import { escapeHtml } from './utils.js';

function escapeHtmlAttr(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// --- Generic custom dropdown ---------------------------------------------
// Any `.dashboard-custom-select.js-generic-select[data-target]` paired with a
// hidden native <select id="<target>"> is upgraded to the app's custom dropdown.
// Reads options + value from the native select, writes back + dispatches change.

function _rebuildGenericSelect(dd) {
    const target = document.getElementById(dd.dataset.target);
    if (!target) return;
    const menu = dd.querySelector('.dashboard-custom-select__menu') || dd.__portaledMenu;
    const valueEl = dd.querySelector('.dashboard-custom-select__value');
    if (!menu || !valueEl) return;
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
    scope.querySelectorAll('.dashboard-custom-select.js-generic-select[data-target]').forEach(dd => _rebuildGenericSelect(dd));
}

if (typeof window !== 'undefined') window.initGenericCustomSelects = initGenericCustomSelects;

// The open menu must escape any ancestor `overflow` clipping and `transform`
// stacking context (e.g. scroll panes / animated views), otherwise it gets cut
// off or rendered BEHIND sibling panels (like the live-logs view). We "portal"
// the menu to <body> with fixed positioning while it is open.
const GENERIC_MENU_Z = 9999;
function _positionGenericMenu(dd) {
    const menu = dd.__portaledMenu;
    if (!menu) return;
    const btn = dd.querySelector('.dashboard-custom-select__button');
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.left = Math.round(r.left) + 'px';
    menu.style.top = Math.round(r.bottom + 6) + 'px';
    menu.style.right = 'auto';
    menu.style.width = Math.round(r.width) + 'px';
    menu.style.minWidth = Math.round(r.width) + 'px';
    menu.style.zIndex = String(GENERIC_MENU_Z);
    // Flip above the button if it would overflow the viewport bottom.
    const mh = menu.offsetHeight;
    if (r.bottom + 6 + mh > window.innerHeight && r.top - 6 - mh > 0) {
        menu.style.top = Math.round(r.top - 6 - mh) + 'px';
    }
}
function _openGenericSelect(dd) {
    // Rebuild while the menu is still inside the wrapper so querySelector works.
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
        // Portaled menus aren't matched by the `[data-open] .menu` descendant
        // rule anymore, so apply the open display inline.
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
    document.querySelectorAll('.dashboard-custom-select.js-generic-select[data-open="true"]').forEach(o => { if (o !== except) _closeGenericSelect(o); });
}

if (typeof document !== 'undefined' && !window.__genericSelectBound) {
    window.__genericSelectBound = true;
    // NOTE: capture phase. Many converted selects live inside rows/cards that
    // carry their own inline `onclick` (e.g. open entity card, navigate). In the
    // bubble phase those ancestor handlers fire BEFORE a document-level listener,
    // stealing the click so the dropdown never opens. Handling in capture lets us
    // intercept first and stopPropagation() to block the ancestor handler.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.dashboard-custom-select.js-generic-select .dashboard-custom-select__button');
        if (btn) {
            const dd = btn.closest('.dashboard-custom-select.js-generic-select');
            e.preventDefault();
            e.stopPropagation();
            const willOpen = dd.dataset.open !== 'true';
            _closeAllGenericSelects(dd);
            if (willOpen) _openGenericSelect(dd); else _closeGenericSelect(dd);
            return;
        }
        const opt = e.target.closest('.dashboard-custom-select.js-generic-select .dashboard-custom-select__option, .dashboard-custom-select__menu .dashboard-custom-select__option');
        if (opt) {
            const menuEl = opt.closest('.dashboard-custom-select__menu');
            const dd = (menuEl && menuEl.__ownerDd) || opt.closest('.dashboard-custom-select.js-generic-select');
            if (!dd) return;
            e.preventDefault();
            e.stopPropagation();
            const target = document.getElementById(dd.dataset.target);
            const value = opt.dataset.value;
            if (target && target.value !== value) {
                target.value = value;
                try { target.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
            }
            const menuRoot = dd.__portaledMenu || dd;
            menuRoot.querySelectorAll('.dashboard-custom-select__option').forEach(o => { o.dataset.selected = o.dataset.value === value ? 'true' : 'false'; });
            const valueEl = dd.querySelector('.dashboard-custom-select__value');
            if (valueEl) valueEl.textContent = (opt.textContent || '').trim();
            _closeGenericSelect(dd);
            return;
        }
        document.querySelectorAll('.dashboard-custom-select.js-generic-select[data-open="true"]').forEach(o => {
            const m = o.__portaledMenu;
            if (!o.contains(e.target) && !(m && m.contains(e.target))) _closeGenericSelect(o);
        });
    }, true);

    // Keep the portaled menu glued to its button while the page scrolls/resizes.
    const _repositionOpenGenericMenus = () => {
        document.querySelectorAll('.dashboard-custom-select.js-generic-select[data-open="true"]').forEach(_positionGenericMenu);
    };
    window.addEventListener('resize', _repositionOpenGenericMenus);
    document.addEventListener('scroll', _repositionOpenGenericMenus, true);
}

// --- Global auto-upgrade of native <select> ------------------------------
// Any native <select> rendered anywhere is automatically converted into the
// app's custom dropdown, so new UI gets consistent styling for free. To keep a
// raw OS <select>, add `data-no-custom-select` (or class `native-select`).
let _genericSelectSeq = 0;
function _isUpgradableSelect(sel) {
    if (!sel || sel.tagName !== 'SELECT') return false;
    if (sel.multiple || sel.size > 1) return false;
    if (sel.classList.contains('dashboard-custom-select-native')) return false; // already paired
    if (sel.classList.contains('native-select')) return false;
    if (sel.hasAttribute('data-no-custom-select')) return false;
    return true;
}
function upgradeNativeSelect(sel) {
    if (!_isUpgradableSelect(sel)) return;
    if (!sel.id) sel.id = `cselect-${++_genericSelectSeq}`;
    // Already upgraded? (overlay immediately after, pointing at this select)
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
    // Keep the overlay in sync when options are populated/changed later.
    if (!sel._optObserver && typeof MutationObserver !== 'undefined') {
        sel._optObserver = new MutationObserver(() => {
            const ov = sel.nextElementSibling;
            if (ov && ov.classList.contains('js-generic-select')) _rebuildGenericSelect(ov);
        });
        sel._optObserver.observe(sel, { childList: true });
    }
}
export function upgradeNativeSelects(root) {
    const scope = root || document;
    if (scope.tagName === 'SELECT') { upgradeNativeSelect(scope); return; }
    scope.querySelectorAll && scope.querySelectorAll('select').forEach(upgradeNativeSelect);
}
if (typeof window !== 'undefined') window.upgradeNativeSelects = upgradeNativeSelects;

if (typeof document !== 'undefined' && !window.__nativeSelectAutoUpgrade) {
    window.__nativeSelectAutoUpgrade = true;
    const runAll = () => upgradeNativeSelects(document);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runAll, { once: true });
    } else {
        runAll();
    }
    // Keep paired dropdown labels in sync when a native select changes value
    // (programmatically or via our own option clicks).
    document.addEventListener('change', (e) => {
        const sel = e.target;
        if (sel && sel.tagName === 'SELECT' && sel.classList.contains('dashboard-custom-select-native')) {
            const overlay = sel.nextElementSibling;
            if (overlay && overlay.classList.contains('js-generic-select')) _rebuildGenericSelect(overlay);
        }
    }, true);
    // Upgrade selects added to the DOM later (batched via rAF).
    let _pending = false;
    const observer = new MutationObserver((mutations) => {
        let found = false;
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                if (node.tagName === 'SELECT' || (node.querySelector && node.querySelector('select'))) { found = true; break; }
            }
            if (found) break;
        }
        if (found && !_pending) {
            _pending = true;
            requestAnimationFrame(() => { _pending = false; upgradeNativeSelects(document); });
        }
    });
    const startObserver = () => observer.observe(document.body, { childList: true, subtree: true });
    if (document.body) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver, { once: true });
}
