/**
 * User profile + notifications event delegation.
 */

import type { DelegatedEventHandlers } from '../types/integration.js';

let _handlers: DelegatedEventHandlers | null = null;
let _bound = false;

function _notifId(el: HTMLElement): string {
    const host = el.closest('[data-notif-id]');
    return String(el.dataset.notifId || (host instanceof HTMLElement ? host.dataset.notifId : '') || '').trim();
}

function _run(action: string, el: HTMLElement, event: Event): void {
    const inUserView = el.closest('#view-user');
    if (!inUserView && action !== 'logout') return;

    switch (action) {
    case 'switchTab':
        _handlers?.switchTab?.(el.dataset.userTab || '', event, el);
        return;
    case 'switchNotificationFilter':
        _handlers?.switchNotificationFilter?.(el.dataset.userNotificationFilter || 'all', event, el);
        return;
    case 'notifPage':
        _handlers?.changeNotificationsPage?.(Number(el.dataset.userDelta || 0), event, el);
        return;
    case 'notifMarkRead':
        event.stopPropagation();
        _handlers?.markNotificationRead?.(_notifId(el), event, el);
        return;
    case 'notifArchive':
        event.stopPropagation();
        _handlers?.archiveNotification?.(_notifId(el), event, el);
        return;
    case 'notifDelete':
        event.stopPropagation();
        _handlers?.deleteNotification?.(_notifId(el), event, el);
        return;
    case 'notifNavigate': {
        event.stopPropagation();
        const url = el.dataset.notifUrl || '';
        _handlers?.navigateNotification?.(url, _notifId(el), event, el);
        return;
    }
    default: {
        const fn = _handlers?.[action];
        if (typeof fn === 'function') fn(event, el);
    }
    }
}

function _onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const el = target.closest('[data-user-action]');
    if (!(el instanceof HTMLElement)) return;
    if (el.dataset.userStopPropagation === 'true') event.stopPropagation();
    _run(el.dataset.userAction || '', el, event);
}

export function initUserEventBindings(handlers: DelegatedEventHandlers = {}): void {
    _handlers = handlers;
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
}
