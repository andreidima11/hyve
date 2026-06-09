/** Runtime user flags and handles set after auth/profile load. */

import type { NotificationTimerHandle } from './types/dashboard.js';

let _isAdmin: boolean | undefined;

let _notificationTimer: NotificationTimerHandle | null = null;

export function setIsAdmin(value: boolean | null | undefined): void {
    _isAdmin = value === undefined || value === null ? undefined : !!value;
}

export function isAdmin(): boolean {
    return _isAdmin === true;
}

export function isExplicitNonAdmin(): boolean {
    return _isAdmin === false;
}

export function getNotificationTimer(): NotificationTimerHandle | null {
    return _notificationTimer;
}

export function setNotificationTimer(timer: NotificationTimerHandle | null): void {
    const prev = _notificationTimer;
    if (prev?.stop) {
        try { prev.stop(); } catch { /* ignore */ }
    }
    _notificationTimer = timer || null;
}
