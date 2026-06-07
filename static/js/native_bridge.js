/**
 * Globals exposed for the Android WebView / native shell.
 * Single implementation — do not redefine on window elsewhere.
 */
import { showToast } from './utils.js';
import { switchTab, switchUserProfileTab } from './nav_bridge.js';

/** @type {((filter?: string) => void) | null} */
let _loadUserNotifications = null;
/** @type {((sessionId: string) => Promise<void>) | null} */
let _openSession = null;

export function installHyveNativeBridge({ loadUserNotifications, openSession } = {}) {
    if (typeof loadUserNotifications === 'function') {
        _loadUserNotifications = loadUserNotifications;
    }
    if (typeof openSession === 'function') {
        _openSession = openSession;
    }

    window.__hyveShowNotification = function(title, message, sessionId) {
        switchTab('user');
        switchUserProfileTab('notifications');
        _loadUserNotifications?.('all');
        if (sessionId && _openSession) {
            _openSession(sessionId).catch(() => {});
        }
        if (message) showToast(message, 'info', 3500);
    };

    if (window.__pendingHyveNotification) {
        const pending = window.__pendingHyveNotification;
        delete window.__pendingHyveNotification;
        window.__hyveShowNotification(pending.title, pending.message, pending.sessionId);
    }
}
