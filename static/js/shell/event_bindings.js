/**
 * App shell navigation — sidebar, header menu, nav buttons in index.html.
 */

const _ROOTS = '#sidebar, #sidebar-backdrop, #app-header-menu-btn';

/** @type {Record<string, (...args: unknown[]) => unknown> | null} */
let _handlers = null;
let _bound = false;

function _inShell(el) {
    return !!el?.closest(_ROOTS);
}

function _run(action, el, event) {
    if (!_handlers || !_inShell(el)) return;

    switch (action) {
    case 'switchTab':
        _handlers.switchTab?.(el.dataset.navTab || '', event, el);
        return;
    default: {
        const fn = _handlers[action];
        if (typeof fn === 'function') fn(event, el);
    }
    }
}

function _onClick(event) {
    const el = event.target.closest('[data-nav-action]');
    if (!el) return;
    _run(el.dataset.navAction, el, event);
}

/**
 * @param {Record<string, (...args: unknown[]) => unknown>} handlers
 */
export function initShellEventBindings(handlers) {
    _handlers = handlers || {};
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
}
