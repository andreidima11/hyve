/**
 * Chat UI event delegation — replaces inline onclick in chat partial.
 */

import type { DelegatedEventHandlers } from '../types/integration.js';

let _handlers: DelegatedEventHandlers | null = null;
let _bound = false;

const _SESSION_ACTIONS = new Set(['openSession', 'deleteSession', 'confirmDeleteSession', 'cancelDeleteSession']);
const _CHAT_SELECTOR_ACTIONS = new Set(['activateProfile']);

function _run(action: string, event: Event, el: Element): void {
    if (!_handlers) return;
    if (action === 'selectThinkingMode') {
        const mode = (el instanceof HTMLElement ? el.dataset.chatMode : '') || el.getAttribute('data-mode') || '';
        _handlers.selectThinkingMode?.(mode);
        return;
    }
    if (_SESSION_ACTIONS.has(action)) {
        if (!el.closest('#sessions-list')) return;
        const id = el instanceof HTMLElement ? (el.dataset.chatSessionId || '') : '';
        if (action === 'openSession') _handlers.openSession?.(id, event, el);
        else if (action === 'deleteSession') _handlers.deleteSession?.(id, event, el);
        else if (action === 'confirmDeleteSession') _handlers.confirmDeleteSession?.(id, event, el);
        else if (action === 'cancelDeleteSession') _handlers.cancelDeleteSession?.(id, event, el);
        return;
    }
    if (_CHAT_SELECTOR_ACTIONS.has(action)) {
        if (!el.closest('#model-selector-balloon')) return;
        if (action === 'activateProfile' && el instanceof HTMLElement) {
            _handlers.activateProfile?.(el.dataset.chatProfileId || '', event, el);
            _handlers.closeModelSelector?.(event, el);
        }
        return;
    }
    if (action === 'toggleProfileDropdown') {
        if (!el.closest('#model-profile-picker')) return;
        event.stopPropagation();
        _handlers.toggleProfileDropdown?.(event, el);
        return;
    }
    if (action === 'showSourcesModal' && el instanceof HTMLElement) {
        _handlers.showSourcesModal?.(el.dataset.chatSourceGroup || '', event, el);
        return;
    }
    const fn = _handlers[action];
    if (typeof fn === 'function') fn(event, el);
}

function _onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const el = target.closest('[data-chat-action]');
    if (!el) return;
    _run(el instanceof HTMLElement ? (el.dataset.chatAction || '') : '', event, el);
}

export function initChatEventBindings(handlers: DelegatedEventHandlers): void {
    _handlers = handlers;
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', _onClick);
}
