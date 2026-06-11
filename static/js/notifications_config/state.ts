/**
 * Notifications settings — shared types and state.
 */

export type NotifChannel = 'app' | 'whatsapp';
export type NotifTransport = 'websocket' | 'firebase' | 'off';

export const notifState = {
    wsStatusTimer: null as ReturnType<typeof setInterval> | null,
    settingsHydrating: false,
    autoSaveBound: false,
    autoSaveTimer: null as ReturnType<typeof setTimeout> | null,
};

