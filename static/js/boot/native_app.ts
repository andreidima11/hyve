/** Native Android app bridge — config tab, permissions, WS status. */

import { showToast } from '../utils.js';
import { setTheme } from '../ui.js';
import { t } from '../lang/index.js';
import { _appEl } from './helpers.js';
import type { AppConfigSaveOptions, BiometricToggleElement, NativePermissionName, PermissionState } from '../types/app.js';

// ── Native App Bridge ────────────────────────────────────────────────
function initNativeAppBridge() {
    // Wait a tick so the Android injectNativeBridge() JS has time to run
    setTimeout(() => {
        if (!window.__HYVE_NATIVE_APP) return;

        // Mark document for native-app-specific CSS (if not already set by early UA detection)
        document.documentElement.classList.add('is-native-app');

        // Reveal all config-native-app-only elements
        document.querySelectorAll('.config-native-app-only').forEach(el => {
            el.classList.remove('hidden');
            el.classList.remove('config-native-app-only');
        });

        // Show camera button (only in native app)
        document.querySelectorAll('.chat-attach-camera-native-only').forEach(el => {
            el.classList.remove('hidden');
        });

        // Reveal login page server-settings link
        const loginLink = document.getElementById('native-app-settings-login');
        if (loginLink) loginLink.classList.remove('hidden');

        // Re-apply the saved theme now that the native bridge is ready.
        // This makes startup follow the exact same path as manual theme selection.
        setTheme(localStorage.getItem('hyve_theme') || 'canvas');
    }, 300);
}

function populateAppTab() {
    const cfg = window.__HYVE_NATIVE_CONFIG;
    if (!cfg) return;

    const el = (id: string) => _appEl(id);
    const urlExt = el('app-url-external');
    const urlLocal = el('app-url-local');
    const wifi = el('app-wifi-ssid');
    const modeLabel = el('app-mode-label');
    const ssidLabel = el('app-current-ssid');
    const bioToggle = el('app-biometric-toggle');
    const bioRow = el('app-biometric-row');
    const bioHint = el('app-biometric-hint');

    _appAutosaveHydrating = true;
    if (urlExt) urlExt.value = cfg.externalUrl || '';
    if (urlLocal) urlLocal.value = cfg.localUrl || '';
    if (wifi) wifi.value = cfg.homeWifi || '';
    _appAutosaveHydrating = false;
    if (modeLabel) modeLabel.textContent = cfg.serverMode || '—';
    if (ssidLabel) ssidLabel.textContent = cfg.currentSsid ? `WiFi: ${cfg.currentSsid}` : '';

    // Update biometric toggle visual
    if (bioToggle) updateBiometricToggle(!!cfg.biometricEnabled);

    // Disable biometric row if hardware not available
    if (bioRow && !cfg.biometricAvailable) {
        bioRow.style.opacity = '0.4';
        bioRow.style.pointerEvents = 'none';
        if (bioHint) bioHint.textContent = t('config.app_biometric_unavailable');
    }

    // Check and show permission states
    checkPermissions();

    bindAppConfigAutosave();

    // Refresh live WS service status when App tab opens
    refreshWsServiceStatus();
}

let _wsStatusPollTimer: ReturnType<typeof setInterval> | null = null;
let _appAutosaveTimer: ReturnType<typeof setTimeout> | null = null;
let _appAutosaveBound = false;
let _appAutosaveHydrating = false;
let _lastSavedAppConfigJson = '';

function _readAppConfigForm() {
    const bioBtn = document.getElementById('app-biometric-toggle');
    return {
        externalUrl: _appEl('app-url-external')?.value?.trim() || '',
        localUrl: _appEl('app-url-local')?.value?.trim() || '',
        homeWifi: _appEl('app-wifi-ssid')?.value?.trim() || '',
        biometricEnabled: (bioBtn as BiometricToggleElement | null)?.__biometricOn ?? false,
    };
}

function bindAppConfigAutosave() {
    if (_appAutosaveBound) return;
    _appAutosaveBound = true;
    ['app-url-external', 'app-url-local', 'app-wifi-ssid'].forEach((id) => {
        const input = document.getElementById(id);
        if (!input) return;
        input.addEventListener('input', () => scheduleAppConfigAutosave());
        input.addEventListener('change', () => saveAppConfig({ silent: true }));
        input.addEventListener('blur', () => saveAppConfig({ silent: true }));
    });
}

function scheduleAppConfigAutosave() {
    if (_appAutosaveHydrating) return;
    if (_appAutosaveTimer != null) window.clearTimeout(_appAutosaveTimer);
    _appAutosaveTimer = window.setTimeout(() => saveAppConfig({ silent: true }), 550);
}

function _setWsStatusBadge(state: boolean | null) {
    const badge = document.getElementById('app-ws-service-status');
    if (!badge) return;

    badge.classList.remove(
        'border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10',
        'border-red-500/30', 'text-red-400', 'bg-red-500/10',
        'border-slate-500/30', 'text-slate-400', 'bg-slate-500/10'
    );

    if (state === true) {
        badge.textContent = t('config.fcm_ws_service_running') || 'Running';
        badge.classList.add('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10');
    } else if (state === false) {
        badge.textContent = t('config.fcm_ws_service_stopped') || 'Stopped';
        badge.classList.add('border-red-500/30', 'text-red-400', 'bg-red-500/10');
    } else {
        badge.textContent = t('config.fcm_ws_service_unknown') || 'Unknown';
        badge.classList.add('border-slate-500/30', 'text-slate-400', 'bg-slate-500/10');
    }
}

function refreshWsServiceStatus() {
    if (!window.__HYVE_NATIVE_APP) {
        _setWsStatusBadge(null);
        return;
    }
    if (typeof window.__getNativeWsServiceStatus !== 'function') {
        _setWsStatusBadge(null);
        return;
    }
    try {
        const running = window.__getNativeWsServiceStatus();
        _setWsStatusBadge(typeof running === 'boolean' ? running : null);
    } catch (e) {
        _setWsStatusBadge(null);
    }

    // Start lightweight polling while App tab is visible
    const appTab = document.getElementById('cfg-tab-app');
    if (appTab && !appTab.classList.contains('hidden') && !_wsStatusPollTimer) {
        _wsStatusPollTimer = setInterval(() => {
            const currentTab = document.getElementById('cfg-tab-app');
            if (!currentTab || currentTab.classList.contains('hidden')) {
                if (_wsStatusPollTimer != null) clearInterval(_wsStatusPollTimer);
                _wsStatusPollTimer = null;
                return;
            }
            try {
                const isRunning = window.__getNativeWsServiceStatus?.();
                _setWsStatusBadge(typeof isRunning === 'boolean' ? isRunning : null);
            } catch (_) {
                _setWsStatusBadge(null);
            }
        }, 5000);
    }
}

function updateBiometricToggle(on: boolean) {
    const btn = document.getElementById('app-biometric-toggle');
    if (!btn) return;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.setAttribute('data-on', on ? 'true' : 'false');
    (btn as BiometricToggleElement).__biometricOn = on;
}

function toggleAppBiometric() {
    const btn = document.getElementById('app-biometric-toggle');
    const newState = !((btn as BiometricToggleElement | null)?.__biometricOn ?? false);
    updateBiometricToggle(newState);
    saveAppConfig({ silent: true });
}

function saveAppConfig(options: AppConfigSaveOptions = {}) {
    if (_appAutosaveHydrating) return;
    if (typeof window.__saveNativeServerConfig !== 'function') {
        return;
    }
    const config = _readAppConfigForm();
    const json = JSON.stringify(config);
    if (json === _lastSavedAppConfigJson) return;
    _lastSavedAppConfigJson = json;
    window.__saveNativeServerConfig(config);
    window.__HYVE_NATIVE_CONFIG = { ...(window.__HYVE_NATIVE_CONFIG || {}), ...config };
    if (!options.silent) showToast(t('config.save_success') || 'Settings saved.', 'success');
}

function detectAppWifi() {
    const input = _appEl('app-wifi-ssid');
    if (!input) return;

    // Ask native to refresh the SSID and return it
    if (typeof window.__getNativeWifiSsid === 'function') {
        const ssid = window.__getNativeWifiSsid();
        if (ssid) {
            input.value = ssid;
            saveAppConfig({ silent: true });
            showToast(t('app.wifi_detected', { ssid }), 'success');
            return;
        }
    }

    // Fallback: use the config snapshot
    const cfg = window.__HYVE_NATIVE_CONFIG;
    if (cfg?.currentSsid) {
        input.value = cfg.currentSsid;
        saveAppConfig({ silent: true });
        showToast(t('app.wifi_detected', { ssid: cfg.currentSsid }), 'success');
    } else {
        showToast(t('app.wifi_detect_failed'), 'error');
    }
}

function clearAppCache() {
    let cleared = false;

    // Native cache clear via JS bridge (no navigation)
    if (typeof window.__clearNativeCache === 'function') {
        try { window.__clearNativeCache(); cleared = true; } catch (e) {}
    }

    // Clear web Cache API
    try {
        if ('caches' in window) {
            caches.keys().then(names => names.forEach(n => caches.delete(n)));
            cleared = true;
        }
    } catch (e) {}

    // Clear localStorage session data (but keep auth token)
    try {
        const token = localStorage.getItem('hyve_token');
        const remember = localStorage.getItem('hyve_remember');
        localStorage.clear();
        if (token) localStorage.setItem('hyve_token', token);
        if (remember) localStorage.setItem('hyve_remember', remember);
        cleared = true;
    } catch (e) {}

    if (cleared) {
        showToast(t('app.cache_cleared'), 'success');
    } else {
        showToast(t('app.cache_clear_error'), 'error');
    }
}

window.saveAppConfig = saveAppConfig;
window.detectAppWifi = detectAppWifi;
window.clearAppCache = clearAppCache;
window.toggleAppBiometric = toggleAppBiometric;
window.refreshWsServiceStatus = refreshWsServiceStatus;

// ── Permissions management ───────────────────────────────────────────

function updatePermissionBadge(badgeId: string, btnId: string, state: PermissionState) {
    const badge = document.getElementById(badgeId);
    const btn = document.getElementById(btnId);
    if (!badge) return;

    badge.classList.remove('hyd-row-badge--ok', 'hyd-row-badge--warn', 'hyd-row-badge--err', 'hyd-row-badge--muted');

    if (state === 'granted') {
        badge.textContent = t('config.app_perm_granted') || 'Granted';
        badge.classList.add('hyd-row-badge--ok');
        if (btn) btn.classList.add('hidden');
    } else if (state === 'denied') {
        badge.textContent = t('config.app_perm_denied') || 'Denied';
        badge.classList.add('hyd-row-badge--err');
        if (btn) {
            btn.classList.remove('hidden');
            btn.innerHTML = '<i class="fas fa-external-link-alt" aria-hidden="true"></i><span>' + (t('config.app_perm_open_settings') || 'Settings') + '</span>';
        }
    } else if (state === 'prompt') {
        badge.textContent = t('config.app_perm_not_set') || 'Not set';
        badge.classList.add('hyd-row-badge--warn');
        if (btn) {
            btn.classList.remove('hidden');
            btn.innerHTML = '<i class="fas fa-check" aria-hidden="true"></i><span>' + (t('config.app_perm_grant') || 'Allow') + '</span>';
        }
    } else {
        badge.textContent = '—';
        badge.classList.add('hyd-row-badge--muted');
        if (btn) btn.classList.add('hidden');
    }
}

/** Check if running inside the native Android app */
function _isNativeApp() {
    return !!window.__HYVE_NATIVE_APP && typeof window.__checkNativePermission === 'function';
}

/**
 * Global callback invoked by native Android when a permission request completes.
 * The native side calls: window.__onNativePermissionResult('camera', true/false)
 */
window.__onNativePermissionResult = function(name: string, granted: boolean) {
    console.log('[PERMS] Native permission result:', name, granted);
    const state = granted ? 'granted' : 'denied';
    const mapping: Record<NativePermissionName, { badge: string; btn: string; toast: string }> = {
        microphone: { badge: 'app-perm-mic-status', btn: 'app-perm-mic-btn', toast: granted ? 'config.app_perm_mic_granted' : 'config.app_perm_mic_denied_toast' },
        camera:     { badge: 'app-perm-camera-status', btn: 'app-perm-camera-btn', toast: granted ? 'config.app_perm_camera_granted' : 'config.app_perm_camera_denied_toast' },
        location:   { badge: 'app-perm-location-status', btn: 'app-perm-location-btn', toast: granted ? 'config.app_perm_location_granted' : 'config.app_perm_location_denied_toast' },
        storage:    { badge: 'app-perm-storage-status', btn: 'app-perm-storage-btn', toast: granted ? 'config.app_perm_storage_granted' : 'config.app_perm_storage_denied_toast' },
    };
    const m = mapping[name as NativePermissionName];
    if (m) {
        updatePermissionBadge(m.badge, m.btn, state);
        showToast(t(m.toast) || (granted ? 'Permission granted' : 'Permission denied'), granted ? 'success' : 'error');
    }
};

async function checkPermissions() {
    console.log('[PERMS] checkPermissions called, native:', _isNativeApp());

    if (_isNativeApp()) {
        // Use native Android bridge to check all permissions
        const perms: NativePermissionName[] = ['microphone', 'camera', 'location', 'storage'];
        const badgeMap: Record<NativePermissionName, { badge: string; btn: string }> = {
            microphone: { badge: 'app-perm-mic-status', btn: 'app-perm-mic-btn' },
            camera:     { badge: 'app-perm-camera-status', btn: 'app-perm-camera-btn' },
            location:   { badge: 'app-perm-location-status', btn: 'app-perm-location-btn' },
            storage:    { badge: 'app-perm-storage-status', btn: 'app-perm-storage-btn' },
        };
        for (const p of perms) {
            try {
                const state = window.__checkNativePermission!(p);
                console.log('[PERMS] Native check', p, '=', state);
                updatePermissionBadge(badgeMap[p as NativePermissionName].badge, badgeMap[p as NativePermissionName].btn, state);
            } catch (e) {
                console.warn('[PERMS] Native check error for', p, e);
            }
        }
        return;
    }

    // Fallback: browser-based permission checks (mic + location only)
    let micState = 'prompt';
    try {
        if (navigator.permissions && navigator.permissions.query) {
            const mic = await navigator.permissions.query({ name: 'microphone' });
            micState = mic.state;
            mic.onchange = () => updatePermissionBadge('app-perm-mic-status', 'app-perm-mic-btn', mic.state);
        }
    } catch (e) { console.warn('[PERMS] mic query error:', e); }
    updatePermissionBadge('app-perm-mic-status', 'app-perm-mic-btn', micState);

    let locState = 'prompt';
    try {
        if (navigator.permissions && navigator.permissions.query) {
            const loc = await navigator.permissions.query({ name: 'geolocation' });
            locState = loc.state;
            loc.onchange = () => updatePermissionBadge('app-perm-location-status', 'app-perm-location-btn', loc.state);
        }
    } catch (e) { console.warn('[PERMS] location query error:', e); }
    updatePermissionBadge('app-perm-location-status', 'app-perm-location-btn', locState);
}

function requestMicPermission() {
    if (_isNativeApp()) { window.__requestNativePermission!('microphone'); return; }
    // Browser fallback
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showToast(t('voice.mic_unavailable') || 'Microphone not available', 'error');
        return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => { stream.getTracks().forEach(tr => tr.stop()); updatePermissionBadge('app-perm-mic-status', 'app-perm-mic-btn', 'granted'); showToast(t('config.app_perm_mic_granted') || 'Microphone access granted', 'success'); })
        .catch(() => { updatePermissionBadge('app-perm-mic-status', 'app-perm-mic-btn', 'denied'); showToast(t('config.app_perm_mic_denied_toast') || 'Microphone access denied', 'error'); });
}

function requestCameraPermission() {
    if (_isNativeApp()) { window.__requestNativePermission!('camera'); return; }
    showToast(t('app.perm_camera_native'), 'info');
}

function requestLocationPermission() {
    if (_isNativeApp()) { window.__requestNativePermission!('location'); return; }
    // Browser fallback
    if (!navigator.geolocation) {
        showToast(t('app.perm_location_unavailable'), 'error');
        return;
    }
    navigator.geolocation.getCurrentPosition(
        () => { updatePermissionBadge('app-perm-location-status', 'app-perm-location-btn', 'granted'); showToast(t('config.app_perm_location_granted') || 'Location access granted', 'success'); },
        (err) => {
            if (err.code === 1) { updatePermissionBadge('app-perm-location-status', 'app-perm-location-btn', 'denied'); showToast(t('config.app_perm_location_denied_toast') || 'Location access denied', 'error'); }
            else { updatePermissionBadge('app-perm-location-status', 'app-perm-location-btn', 'granted'); showToast(t('config.app_perm_location_granted') || 'Location access granted', 'success'); }
        },
        { timeout: 10000 }
    );
}

function requestStoragePermission() {
    if (_isNativeApp()) { window.__requestNativePermission!('storage'); return; }
    showToast(t('app.perm_storage_native'), 'info');
}

window.requestMicPermission = requestMicPermission;
window.requestLocationPermission = requestLocationPermission;
window.requestCameraPermission = requestCameraPermission;
window.requestStoragePermission = requestStoragePermission;
window.checkPermissions = checkPermissions;

export {
    initNativeAppBridge,
    populateAppTab,
    saveAppConfig,
    detectAppWifi,
    clearAppCache,
    toggleAppBiometric,
    refreshWsServiceStatus,
    checkPermissions,
    requestMicPermission,
    requestCameraPermission,
    requestLocationPermission,
    requestStoragePermission,
};
