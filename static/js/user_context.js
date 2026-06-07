/** Runtime user flags and handles set after auth/profile load. */

/** @type {boolean | undefined} */
let _isAdmin;

/** @type {{ stop?: () => void, setEnabled?: (enabled: boolean) => void } | null} */
let _notificationTimer = null;

export function setIsAdmin(value) {
    _isAdmin = value === undefined || value === null ? undefined : !!value;
}

export function isAdmin() {
    return _isAdmin === true;
}

export function isExplicitNonAdmin() {
    return _isAdmin === false;
}

export function getNotificationTimer() {
    return _notificationTimer;
}

export function setNotificationTimer(timer) {
    const prev = _notificationTimer;
    if (prev?.stop) {
        try { prev.stop(); } catch (_) {}
    }
    _notificationTimer = timer || null;
}
