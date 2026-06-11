/**
 * Notifications settings — load/save prefs.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { showToast } from '../utils.js';
import { notifState } from './state.js';
import { selectNotifChannel, selectNotifTransport } from './ui.js';
export async function loadNotificationPrefs() {
    try {
        notifState.settingsHydrating = true;
        const [userRes, cfgRes] = await Promise.all([
            apiCall('/api/users/me'),
            apiCall('/api/config')
        ]);
        let cfg = {};
        if (cfgRes.ok) {
            cfg = await cfgRes.json();
        }
        const fcm = (cfg.fcm || {});
        let transport = String(fcm.transport_mode || 'websocket').toLowerCase();
        if (transport === 'hybrid')
            transport = 'websocket';
        const fcmProject = document.getElementById('fcm_project_id');
        const fcmSaPath = document.getElementById('fcm_service_account_path');
        if (fcmProject)
            fcmProject.value = String(fcm.project_id || '');
        if (fcmSaPath)
            fcmSaPath.value = String(fcm.service_account_path || '');
        selectNotifTransport(transport === 'firebase' ? 'firebase' : 'websocket', { persist: false });
        let channel = 'app';
        if (userRes.ok) {
            const user = await userRes.json();
            const prefs = user.notification_prefs || { app: true, whatsapp: false };
            channel = prefs.whatsapp && !prefs.app ? 'whatsapp' : 'app';
        }
        const wahaOn = !!(cfg.waha && cfg.waha.enabled);
        const waCard = document.getElementById('notif-card-whatsapp');
        if (!wahaOn) {
            channel = 'app';
            if (waCard)
                waCard.classList.add('hidden');
        }
        else {
            if (waCard)
                waCard.classList.remove('hidden');
        }
        selectNotifChannel(channel, { persist: false });
    }
    catch (e) {
        console.warn('Failed to load notification settings:', e);
    }
    finally {
        notifState.settingsHydrating = false;
        bindNotificationSettingsAutoSave();
    }
}
/** Save notification settings from the Notifications tab. */
export async function saveNotificationSettings(options = {}) {
    const silent = options.silent === true;
    const wsRadio = document.querySelector('input[name="notif_transport"][value="websocket"]');
    const transport = wsRadio && wsRadio.checked ? 'websocket' : 'firebase';
    try {
        const newFcm = {
            enabled: transport === 'firebase',
            transport_mode: transport,
            websocket_enabled: transport === 'websocket',
            project_id: document.getElementById('fcm_project_id')?.value.trim() || '',
            service_account_path: document.getElementById('fcm_service_account_path')?.value.trim() || '',
            send_when_ws_disconnected: true,
        };
        const saveRes = await apiCall('/api/config', {
            method: 'POST',
            body: { fcm: newFcm }
        });
        if (!saveRes.ok) {
            if (!silent)
                showToast(t('hy.config_save_error'), 'error');
            return;
        }
    }
    catch (_) {
        if (!silent)
            showToast(t('hy.config_save_error'), 'error');
        return;
    }
    const channel = _getSelectedChannel();
    const appOn = channel === 'app';
    try {
        await apiCall('/api/users/me', {
            method: 'PATCH',
            body: { notification_prefs: { app: appOn, whatsapp: !appOn } }
        });
    }
    catch (_) { }
    if (appOn) {
        _applyNotifRuntimeTransport(transport);
    }
    else {
        _applyNotifRuntimeTransport('off');
    }
}
