/**
 * Notifications settings — channel, transport, WS status, test sends.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { getNotificationTimer } from '../user_context.js';
import { showToast } from '../utils.js';
import { notifState } from './state.js';
function _applyNotifRuntimeTransport(transport) {
    const wsEnabled = transport === 'websocket';
    try {
        const timer = getNotificationTimer();
        if (timer && typeof timer.setEnabled === 'function') {
            timer.setEnabled(wsEnabled);
        }
    }
    catch (_) { }
    if (window.__HYVE_NATIVE_APP && typeof window.__setNativeWsServiceEnabled === 'function') {
        try {
            window.__setNativeWsServiceEnabled(wsEnabled);
        }
        catch (_) { }
    }
}
function _getSelectedChannel() {
    const appRadio = document.querySelector('input[name="notif_channel"][value="app"]');
    return appRadio && appRadio.checked ? 'app' : 'whatsapp';
}
function _queueNotificationSettingsAutoSave() {
    if (notifState.settingsHydrating)
        return;
    if (notifState.autoSaveTimer)
        clearTimeout(notifState.autoSaveTimer);
    notifState.autoSaveTimer = setTimeout(() => {
        notifState.autoSaveTimer = null;
        saveNotificationSettings({ silent: true });
    }, 220);
}
export function bindNotificationSettingsAutoSave() {
    if (notifState.autoSaveBound)
        return;
    notifState.autoSaveBound = true;
    const bindInput = (id, eventName = 'input') => {
        const el = document.getElementById(id);
        if (!el)
            return;
        el.addEventListener(eventName, _queueNotificationSettingsAutoSave);
    };
    bindInput('fcm_project_id', 'input');
    bindInput('fcm_service_account_path', 'input');
    const channelRadios = document.querySelectorAll('input[name="notif_channel"]');
    channelRadios.forEach((el) => el.addEventListener('change', _queueNotificationSettingsAutoSave));
    const transportRadios = document.querySelectorAll('input[name="notif_transport"]');
    transportRadios.forEach((el) => el.addEventListener('change', _queueNotificationSettingsAutoSave));
}
/** Select notification channel: 'app' (Hyve) or 'whatsapp'. */
export function selectNotifChannel(channel, opts = {}) {
    const persist = opts.persist !== false;
    const cards = {
        app: document.getElementById('notif-card-app'),
        whatsapp: document.getElementById('notif-card-whatsapp'),
    };
    const appGroup = document.getElementById('notif-app-settings-group');
    const waSection = document.getElementById('notif-whatsapp-section');
    for (const [key, card] of Object.entries(cards)) {
        if (!card)
            continue;
        const radio = card.querySelector('input[type="radio"]');
        if (key === channel) {
            card.classList.remove('border-white/10', 'bg-transparent');
            card.classList.add(key === 'app' ? 'border-blue-500/40' : 'border-emerald-500/40', key === 'app' ? 'bg-blue-500/5' : 'bg-emerald-500/5');
            if (radio)
                radio.checked = true;
        }
        else {
            card.classList.remove('border-blue-500/40', 'border-emerald-500/40', 'bg-blue-500/5', 'bg-emerald-500/5');
            card.classList.add('border-white/10', 'bg-transparent');
            if (radio)
                radio.checked = false;
        }
    }
    const appOn = channel === 'app';
    if (appGroup)
        appGroup.classList.toggle('hidden', !appOn);
    if (waSection)
        waSection.classList.toggle('hidden', appOn);
    if (!appOn) {
        _applyNotifRuntimeTransport('off');
        _stopNotifWsStatusPolling();
    }
    if (persist) {
        _queueNotificationSettingsAutoSave();
    }
}
/** Highlight the selected transport card and show/hide settings sections. */
export function selectNotifTransport(transport, opts = {}) {
    const persist = opts.persist !== false;
    const cards = {
        websocket: document.getElementById('notif-card-websocket'),
        firebase: document.getElementById('notif-card-firebase'),
    };
    const sections = {
        websocket: document.getElementById('notif-ws-settings'),
        firebase: document.getElementById('notif-fcm-settings'),
    };
    for (const [key, card] of Object.entries(cards)) {
        if (!card)
            continue;
        const radio = card.querySelector('input[type="radio"]');
        if (key === transport) {
            card.classList.remove('border-white/10', 'bg-transparent');
            card.classList.add(key === 'websocket' ? 'border-emerald-500/40' : 'border-orange-500/40', key === 'websocket' ? 'bg-emerald-500/5' : 'bg-orange-500/5');
            if (radio)
                radio.checked = true;
        }
        else {
            card.classList.remove('border-emerald-500/40', 'border-orange-500/40', 'bg-emerald-500/5', 'bg-orange-500/5');
            card.classList.add('border-white/10', 'bg-transparent');
            if (radio)
                radio.checked = false;
        }
    }
    for (const [key, sec] of Object.entries(sections)) {
        if (sec)
            sec.classList.toggle('hidden', key !== transport);
    }
    if (transport === 'websocket') {
        _refreshNotifWsStatus();
        _startNotifWsStatusPolling();
    }
    else {
        _stopNotifWsStatusPolling();
    }
    _applyNotifRuntimeTransport(transport);
    refreshNotifWsNativeStatus();
    setTimeout(refreshNotifWsNativeStatus, 1200);
    if (persist) {
        _queueNotificationSettingsAutoSave();
    }
}
function _startNotifWsStatusPolling() {
    _stopNotifWsStatusPolling();
    notifState.wsStatusTimer = setInterval(() => {
        const tab = document.getElementById('cfg-tab-notifications');
        if (!tab || tab.classList.contains('hidden')) {
            _stopNotifWsStatusPolling();
            return;
        }
        _refreshNotifWsStatus();
    }, 5000);
}
function _stopNotifWsStatusPolling() {
    if (notifState.wsStatusTimer) {
        clearInterval(notifState.wsStatusTimer);
        notifState.wsStatusTimer = null;
    }
}
async function _refreshNotifWsStatus() {
    const badge = document.getElementById('notif-ws-status-badge');
    const countEl = document.getElementById('notif-ws-conn-count');
    try {
        const res = await apiCall('/api/notifications/ws-status');
        if (res.ok) {
            const data = await res.json();
            if (badge) {
                badge.classList.remove('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10', 'border-red-500/30', 'text-red-400', 'bg-red-500/10', 'border-slate-500/30', 'text-slate-400', 'bg-slate-500/10');
                if (data.connected) {
                    badge.textContent = t('common.connected');
                    badge.classList.add('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10');
                }
                else {
                    badge.textContent = t('common.disconnected');
                    badge.classList.add('border-red-500/30', 'text-red-400', 'bg-red-500/10');
                }
            }
            if (countEl)
                countEl.textContent = String(data.connection_count || 0);
        }
    }
    catch (_) {
        if (badge) {
            badge.textContent = t('common.error');
            badge.className = 'text-[10px] font-bold px-2.5 py-1 rounded-full border border-red-500/30 text-red-400 bg-red-500/10';
        }
    }
}
/** Refresh the native Android WS service status badge. */
export function refreshNotifWsNativeStatus() {
    const badge = document.getElementById('notif-ws-native-status');
    if (!badge)
        return;
    badge.classList.remove('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10', 'border-red-500/30', 'text-red-400', 'bg-red-500/10', 'border-slate-500/30', 'text-slate-400', 'bg-slate-500/10');
    if (!window.__HYVE_NATIVE_APP || typeof window.__getNativeWsServiceStatus !== 'function') {
        badge.textContent = t('common.na');
        badge.classList.add('border-slate-500/30', 'text-slate-400', 'bg-slate-500/10');
        return;
    }
    try {
        const running = window.__getNativeWsServiceStatus();
        if (running === true) {
            badge.textContent = t('common.running');
            badge.classList.add('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10');
        }
        else if (running === false) {
            badge.textContent = t('common.stopped');
            badge.classList.add('border-red-500/30', 'text-red-400', 'bg-red-500/10');
        }
        else {
            badge.textContent = t('common.unknown');
            badge.classList.add('border-slate-500/30', 'text-slate-400', 'bg-slate-500/10');
        }
    }
    catch (_) {
        badge.textContent = t('common.error');
        badge.classList.add('border-red-500/30', 'text-red-400', 'bg-red-500/10');
    }
}
/** Send a test notification on the currently selected transport. */
export async function testNotification() {
    const wsRadio = document.querySelector('input[name="notif_transport"][value="websocket"]');
    const transport = wsRadio && wsRadio.checked ? 'websocket' : 'firebase';
    const label = transport === 'websocket' ? t('config.notif_test_transport_ws') : t('config.notif_test_transport_fcm');
    try {
        const res = await apiCall('/api/notifications/test-channel', {
            method: 'POST',
            body: { transport }
        });
        if (!res.ok) {
            showToast(t('config.notif_test_error', { transport: label }), 'error');
            return;
        }
        const data = await res.json();
        if (data.delivered) {
            const count = data.sent_count || 0;
            const extra = count
                ? t(count === 1 ? 'config.notif_test_devices_one' : 'config.notif_test_devices_many', { count })
                : '';
            showToast(t('config.notif_test_success', { transport: label, extra }), 'success');
        }
        else if (data.detail === 'no_ws_connection') {
            showToast(t('hy.no_ws_connection'), 'warning');
        }
        else if (data.detail === 'fcm_disabled') {
            showToast(t('hy.fcm_inactive'), 'warning');
        }
        else if (data.detail === 'no_devices') {
            showToast(t('hy.fcm_no_devices'), 'warning');
        }
        else {
            showToast(t('config.notif_test_no_delivery', { transport: label }), 'warning');
        }
    }
    catch (_) {
        showToast(t('config.notif_test_error', { transport: label }), 'error');
    }
}
export async function testWsNotification() {
    return testNotification();
}
export async function testFcmNotification() {
    return testNotification();
}
