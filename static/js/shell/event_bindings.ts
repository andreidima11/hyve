/**
 * App shell navigation — sidebar, header menu, nav buttons in index.html.
 */

import type { DelegatedEventHandlers } from '../types/integration.js';

const _ROOTS = '#sidebar, #sidebar-backdrop, #app-header-menu-btn';

let _handlers: DelegatedEventHandlers | null = null;
let _bound = false;

function _inShell(el: Element | null): boolean {
    return !!el?.closest(_ROOTS);
}

function _run(action: string, el: HTMLElement, event: Event): void {
    if (!_handlers || !_inShell(el)) return;

    switch (action) {
    case 'switchTab':
        _handlers.switchTab?.(el.dataset.navTab || '', event, el);
        return;
    case 'toggleSidebar':
        _handlers.toggleSidebar?.(event, el);
        return;
    case 'newChatSession':
        _handlers.newChatSession?.(event, el);
        return;
    case 'clearSessionContext':
        _handlers.clearSessionContext?.(event, el);
        return;
    default: {
        const fn = _handlers[action];
        if (typeof fn === 'function') fn(event, el);
    }
    }
}

function _onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const el = target.closest('[data-nav-action]');
    if (!(el instanceof HTMLElement)) return;
    _run(el.dataset.navAction || '', el, event);
}

export function initShellEventBindings(handlers: DelegatedEventHandlers = {}): void {
    _handlers = handlers;
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
}
