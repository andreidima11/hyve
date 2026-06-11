/**
 * Native <select> auto-upgrade to custom dropdown.
 */
import type { GenericCustomSelectElement, UpgradableNativeSelect } from './types.js';
import { rebuildGenericSelect } from './generic.js';
import { selectUiState } from './state.js';

function _isUpgradableSelect(sel: HTMLSelectElement | null): sel is UpgradableNativeSelect {
    if (!sel || sel.tagName !== 'SELECT') return false;
    if (sel.multiple || sel.size > 1) return false;
    if (sel.classList.contains('dashboard-custom-select-native')) return false;
    if (sel.classList.contains('native-select')) return false;
    if (sel.hasAttribute('data-no-custom-select')) return false;
    return true;
}
export function upgradeNativeSelect(sel: HTMLSelectElement) {
    if (!_isUpgradableSelect(sel)) return;
    if (!sel.id) sel.id = `cselect-${++selectUiState.genericSelectSeq}`;
    const nextEl = sel.nextElementSibling;
    if (nextEl && nextEl.classList.contains('js-generic-select') && nextEl.getAttribute('data-target') === sel.id) {
        rebuildGenericSelect(nextEl as GenericCustomSelectElement);
        return;
    }
    sel.classList.add('dashboard-custom-select-native');
    const wrap = document.createElement('div');
    wrap.className = 'dashboard-custom-select js-generic-select';
    wrap.setAttribute('data-target', sel.id);
    wrap.setAttribute('data-open', 'false');
    wrap.innerHTML = '<button type="button" class="dashboard-custom-select__button"><span class="dashboard-custom-select__value">—</span><i class="fas fa-chevron-down"></i></button><div class="dashboard-custom-select__menu"></div>';
    sel.insertAdjacentElement('afterend', wrap);
    rebuildGenericSelect(wrap);
    if (!sel._optObserver && typeof MutationObserver !== 'undefined') {
        sel._optObserver = new MutationObserver(() => {
            const ov = sel.nextElementSibling;
            if (ov && ov.classList.contains('js-generic-select')) rebuildGenericSelect(ov as GenericCustomSelectElement);
        });
        sel._optObserver.observe(sel, { childList: true });
    }
}
export function upgradeNativeSelects(root?: ParentNode | HTMLSelectElement) {
    const scope = root || document;
    if (scope instanceof HTMLSelectElement) { upgradeNativeSelect(scope); return; }
    scope.querySelectorAll?.('select').forEach((node) => upgradeNativeSelect(node));
}

if (typeof document !== 'undefined' && !selectUiState.nativeSelectAutoUpgrade) {
    selectUiState.nativeSelectAutoUpgrade = true;
    const runAll = () => upgradeNativeSelects(document);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', runAll, { once: true });
    } else {
        runAll();
    }
    document.addEventListener('change', (e) => {
        const sel = e.target;
        if (sel instanceof HTMLSelectElement && sel.classList.contains('dashboard-custom-select-native')) {
            const overlay = sel.nextElementSibling;
            if (overlay && overlay.classList.contains('js-generic-select')) {
                rebuildGenericSelect(overlay as GenericCustomSelectElement);
            }
        }
    }, true);
    let _pending = false;
    const observer = new MutationObserver((mutations) => {
        let found = false;
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== 1) continue;
                const el = node as Element;
                if (el.tagName === 'SELECT' || (el.querySelector && el.querySelector('select'))) { found = true; break; }
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
