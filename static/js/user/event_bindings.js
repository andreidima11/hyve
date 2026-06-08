/**
 * User profile + notifications event delegation.
 */

/** @type {Record<string, (...args: unknown[]) => unknown> | null} */
let _handlers = null;
let _bound = false;

function _notifId(el) {
    return String(el.dataset.notifId || el.closest('[data-notif-id]')?.dataset.notifId || '').trim();
}

function _run(action, el, event) {
    const inUserView = el.closest('#view-user');
    const inNotifList = el.closest('#user-notifications-list');
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

function _onClick(event) {
    const el = event.target.closest('[data-user-action]');
    if (!el) return;
    if (el.dataset.userStopPropagation === 'true') event.stopPropagation();
    _run(el.dataset.userAction, el, event);
}

/**
 * @param {Record<string, (...args: unknown[]) => unknown>} handlers
 */
export function initUserEventBindings(handlers) {
    _handlers = handlers || {};
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
}
