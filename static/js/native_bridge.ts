/**
 * Globals exposed for the Android WebView / native shell.
 * Single implementation — do not redefine on window elsewhere.
 */
import { showToast } from './utils.js';
import { switchTab, switchUserProfileTab } from './nav_bridge.js';

let _loadUserNotifications: ((filter?: string) => void) | null = null;
let _openSession: ((sessionId: string) => Promise<void>) | null = null;

export interface HyveNativeBridgeDeps {
    loadUserNotifications?: (filter?: string) => void;
    openSession?: (sessionId: string) => Promise<void>;
}

export function installHyveNativeBridge(deps: HyveNativeBridgeDeps = {}): void {
    const { loadUserNotifications, openSession } = deps;
    if (typeof loadUserNotifications === 'function') {
        _loadUserNotifications = loadUserNotifications;
    }
    if (typeof openSession === 'function') {
        _openSession = openSession;
    }

    window.__hyveShowNotification = (title: string, message: string, sessionId?: string) => {
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
        window.__hyveShowNotification?.(pending.title, pending.message, pending.sessionId);
    }
}
