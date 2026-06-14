import { authToken, clearAuthToken, suppressLogout } from './api.js';
import { showToast, debounce, showConfirm, showSourcesModal } from './utils.js';
import { handleLogin, loadUserProfile, restoreRememberedCredentials, tryAutoLogin } from './auth.js';
import { initSetupWizard, showSetupWizard, fetchSetupStatus } from './setup.js';
import { setTheme, loadThemeSelector, toggleSidebar, closeSidebar, isSidebarOpen, switchTab, switchConfigTab, openConfigSection, closeConfigSection, startLogStream, initSidebarGestures, getStoredThemeId } from './ui.js';
import { initI18n, setLanguage, t, loadComponentTranslations } from './lang/index.js';
import { applyDashboardEditAccess } from './dashboard/edit_access.js';
import { sendMessage, stopStreaming, currentSessionId, addAttachedImage, addAttachedDocument, applyInitialGreeting, handleSlashInput, handleSlashKeydown } from './chat.js';
import { initThinkingModeSelector, setThinkingMode } from './thinking_mode.js';
import { initChatEventBindings } from './chat/event_bindings.js';
import { initPlannerEventBindings } from './planner/event_bindings.js';
import { initUserEventBindings } from './user/event_bindings.js';
import { initSkillsEventBindings } from './skills/event_bindings.js';
import { initConfigEventBindings } from './config/event_bindings.js';
import { initMemoryEventBindings } from './memory/event_bindings.js';
import { initSmarthomeEventBindings } from './smarthome/event_bindings.js';
import { initShellEventBindings } from './shell/event_bindings.js';
import { initIntegrationEventBindings } from './integrations/event_bindings.js';
import { initHyColorPickerBindings } from './light_controls.js';
import { toggleModelSelector, closeModelSelector } from './chat/model_selector.js';
import { setUserProfileContext, loadUserProfilePage, switchUserProfileTab, saveUserProfileGeneral, saveUserProfileSecurity } from './user_profile.js';
import { initNotifications, loadUserNotifications, switchUserNotificationFilter, toggleUserNotificationFilterMenu, markUserNotificationRead, archiveUserNotification, deleteUserNotification, clearAllUserNotifications, changeUserNotificationsPage, loadNotificationCounts, updateNotificationBadge, navigateNotification } from './notifications.js';
import { startStartupStatusPolling, showHubStartupLoadingAfterRestart } from './startup_status.js';
import { importWithCacheBust } from './asset_version.js';
import { setIsAdmin, setNotificationTimer } from './user_context.js';
import {
    showProfileEditor,
    closeProfileEditor,
    saveProfile,
    moveProfileOrder,
    openProfileCardMenu,
    closeProfileCardMenu,
    onProfileProviderChange,
    onProfileSubProviderChange,
    syncVisionCapabilityCheckbox,
    testWhisperConnection,
    testPiperConnection,
    activateProfile,
} from './features_config.js';
import {
    switchIntegrationSubtab,
    syncConfiguredIntegration,
    syncIntegrationEntities,
    navigateToSmartHomeSource,
    controlIntegrationEntity,
    openIntegrationEntityCard,
    openIntegrationDeviceModal,
    renameIntegrationDevice,
} from './features_integrations_settings.js';

// Expose sendMessage globally so other modules (e.g. voice input in features.js) can call it
window.sendMessage = sendMessage;
import { 
    saveConfig, restartServer, syncHA, loadSmarthome,
    toggleSelection, toggleAllAI, loadMemory, filterDevices, changeMemPage, 
    deleteMemBulk, filterMemory, toggleAllMem, updateMemBulkCount,
    openAliasModal, addAliasInput, closeAliasModal, saveAliasesFromModal, closeRowActionsModal, handleHaRowClick,
    resetSmarthomeFilters, copyEntityIdFromRowActions, toggleSmarthomeFilters, toggleSmarthomePicker, selectSmarthomePickerOption,
    setDevicesPage, setDevicesPageSize, sortDevicesBy, controlDeviceEntity, openAliasModalFromDetail, closeEntityDetailModal,
    openEntityDetail, closeEntityDetail, openDeviceDetail, closeDeviceDetail, filterEntityCategory,
    closeDevicePrimaryModal, selectDevicePrimaryEntity,
    loadSessionsList, openSession, newChatSession, deleteSession, confirmDeleteSession, cancelDeleteSession, clearSessionContext,
    copyWebhook, openIntegrationConfigModal, closeIntegrationConfigModal, refreshIntegrationsSettingsView, loadAdminUsers, createUser, deleteUser, unlinkUserPhone,
    loadModelProfiles,
    loadSkills, openSkillEdit, closeSkillEditModal, saveSkillEdit, deleteSkill,
    toggleSkillDesc, toggleSkillDisabled,
    loadMemoryEvents, memLogPrevPage, memLogNextPage, toggleMemLogDetails, clearMemoryLog, runConsolidationNow,
    switchIntelligenceTab,
    addExtractionExample, removeExtractionExample,
    loadReminders, loadAutomations, deleteReminder, deleteAutomation, openMementoEdit, closeMementoEdit, saveMementoEdit, updateMementoBulkCount, toggleAllMemento, deleteMementoBulk,
    openAutomationEditor, closeAutomationEditor, saveAutomationEditor, validateAutomationEditor, toggleAutomationDefinition, runAutomationDefinition, testAutomationEditor, exportAutomationYaml, importAutomationYaml,
    toggleAutoMenu, closeAutoMenu, showAutoDotTooltip, hideAutoDotTooltip,
    autoSyncAutomationId, markAutomationIdManual,
    openBlueprintPicker, closeBlueprintPicker, loadBlueprints, importBlueprintYaml, backToBlueprintList, instantiateCurrentBlueprint, deleteCurrentBlueprint,
    openBlueprintCreator, addBlueprintCreatorInput, removeBlueprintCreatorInput, changeBlueprintCreatorInputType, insertBlueprintCreatorPlaceholder, updateBlueprintCreatorYaml, saveCreatedBlueprint,
    switchAutomationEditorMode, addAutomationBuilderAction, removeAutomationBuilderAction, addAutomationBuilderTrigger, removeAutomationBuilderTrigger, addAutomationBuilderCondition, removeAutomationBuilderCondition, syncAutomationYamlFromBuilder, loadAutomationEditorHistory, updateAutomationStructuredServiceData,
    loadNotificationPrefs, saveNotificationSettings, selectNotifTransport, selectNotifChannel, testWsNotification, testFcmNotification, testNotification, refreshNotifWsNativeStatus,
    switchMemorySubtab,     checkAddonUpdates, updateAllAddons, updateSingleAddon, closeAddonConfigModal, refreshUpdatesHeaderBadge, checkAddonHealth,
    loadBackupPanel, createBackup, verifyBackup, restoreBackup, rollbackBackup,
    saveBackupSettings, deleteBackupArchive, testBackupRemote,
    loadRemoteBackupArchives, pullRemoteBackup, restoreRemoteBackup,
    downloadBackupArchive, pickBackupUpload, uploadBackupArchive,
    installAddon, uninstallAddon, toggleAddon, openAddonConfigModal, saveAddonConfig as saveAddonConfigModal,
} from './features.js';
import {
    loadDashboard,
    initDashboardSidebarNav,
    withDashboardTimeout,
} from './dashboard.js';

import type { ConfigFormElement } from './types/features_config.js';
import type {
    AppConfigSaveOptions,
    BiometricToggleElement,
    DelegatedHandler,
    HyveNativeConfig,
    HyveSetupStatus,
    LazyModuleLoader,
    LazyModuleRecord,
    NativePermissionName,
    PermissionState,
} from './types/app.js';
import type { UserProfileResponse } from './types/dashboard.js';
import type { DelegatedEventHandlers } from './types/integration.js';

function _errMsg(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err ?? '');
}

function _appEl(id: string): ConfigFormElement | null {
    return document.getElementById(id) as ConfigFormElement | null;
}

function _bindHandler<A extends unknown[]>(fn: (...args: A) => unknown): DelegatedHandler {
    return (...args: unknown[]) => fn(...(args as A));
}

function _str(v: unknown): string {
    return v == null ? '' : String(v);
}

function _num(v: unknown, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

const _lazyModulePromises = new Map<string, Promise<LazyModuleRecord>>();

function _lazyModule(key: string, importer: LazyModuleLoader): Promise<LazyModuleRecord> {
    if (!_lazyModulePromises.has(key)) {
        _lazyModulePromises.set(key, importer());
    }
    return _lazyModulePromises.get(key)!;
}

function _lazyAction(moduleLoader: LazyModuleLoader, exportName: string) {
    return async (...args: unknown[]) => {
        try {
            const module = await moduleLoader();
            const action = module[exportName];
            if (typeof action !== 'function') {
                throw new Error(`Missing lazy export: ${exportName}`);
            }
            return await (action as (...a: unknown[]) => unknown)(...args);
        } catch (err) {
            console.warn(`${exportName} lazy load failed`, err);
            showToast(t('app.function_load_error'), 'error');
            return undefined;
        }
    };
}

const _loadDerivedModule = () => _lazyModule('derived', () => importWithCacheBust('./features_derived.js') as Promise<LazyModuleRecord>);
const _loadPlannerModule = () => _lazyModule('planner', () => importWithCacheBust('./planner.js') as Promise<LazyModuleRecord>);
const _loadAppsModule = () => _lazyModule('apps', () => importWithCacheBust('./features_apps.js') as Promise<LazyModuleRecord>);
const _loadScenesModule = () => _lazyModule('scenes', () => importWithCacheBust('./features_scenes.js') as Promise<LazyModuleRecord>);
const _loadAreasModule = () => _lazyModule('areas', () => importWithCacheBust('./features_areas.js') as Promise<LazyModuleRecord>);

import { registerNavBridge } from './nav_bridge.js';

// Logout disponibil imediat (înainte de orice async), ca butonul să funcționeze mereu
async function doLogout() {
    // Show confirmation dialog
    const confirmMessage = t('header.logout_confirm');
    if (!(await showConfirm(confirmMessage))) {
        return;
    }

    const token = localStorage.getItem('hyve_token');

    const finalizeLogout = () => {
    try {
        if (window.__clearNativeAuthToken) {
            window.__clearNativeAuthToken();
        }
    } catch (e) {}
    try { clearAuthToken(); } catch (e) {}
    try {
        localStorage.removeItem('hyve_token');
        localStorage.removeItem('hyve_session_id');
        localStorage.removeItem('hyve_remember');
        sessionStorage.clear();
    } catch (e) {}

    const overlay = document.getElementById('login-overlay');
    if (overlay) overlay.classList.remove('hidden');

    // Force a fresh page load (bypass Cloudflare / browser cache)
    const logoutUrl = '/?_logout=' + Date.now();
    window.location.replace(logoutUrl);
    setTimeout(() => {
        if (!window.location.search.includes('_logout=')) {
            window.location.href = logoutUrl;
        }
    }, 250);
    };

    if (!token) {
        finalizeLogout();
        return;
    }

    const logoutRequest = fetch('/api/logout', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        keepalive: true,
    }).catch(() => {});

    Promise.race([
        logoutRequest,
        new Promise(resolve => setTimeout(resolve, 300)),
    ]).finally(finalizeLogout);
}
window.doLogout = doLogout;

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

    badge.classList.remove(
        'border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10',
        'border-red-500/30', 'text-red-400', 'bg-red-500/10',
        'border-amber-500/30', 'text-amber-400', 'bg-amber-500/10',
        'border-slate-500/30', 'text-slate-500'
    );

    if (state === 'granted') {
        badge.textContent = t('config.app_perm_granted') || 'Granted';
        badge.classList.add('border-emerald-500/30', 'text-emerald-400', 'bg-emerald-500/10');
        if (btn) btn.classList.add('hidden');
    } else if (state === 'denied') {
        badge.textContent = t('config.app_perm_denied') || 'Denied';
        badge.classList.add('border-red-500/30', 'text-red-400', 'bg-red-500/10');
        if (btn) {
            btn.classList.remove('hidden');
            btn.innerHTML = '<i class="fas fa-external-link-alt mr-1"></i>' + (t('config.app_perm_open_settings') || 'Settings');
        }
    } else if (state === 'prompt') {
        badge.textContent = t('config.app_perm_not_set') || 'Not set';
        badge.classList.add('border-amber-500/30', 'text-amber-400', 'bg-amber-500/10');
        if (btn) {
            btn.classList.remove('hidden');
            btn.innerHTML = '<i class="fas fa-check mr-1"></i>' + (t('config.app_perm_grant') || 'Allow');
        }
    } else {
        badge.textContent = '—';
        badge.classList.add('border-slate-500/30', 'text-slate-500');
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
// ─────────────────────────────────────────────────────────────────────

let notificationInterval: ReturnType<typeof setInterval> | null = null;

// ─── Boot state machine ──────────────────────────────────────────────
// Single, deterministic startup flow. Boot overlay is shown from the
// server (visible by default in HTML) and we only fade it out once the
// app is in a known terminal state: ready (dashboard) or login_required.

function hideBootOverlay() {
    const overlay = document.getElementById('boot-overlay');
    if (!overlay) return;
    overlay.classList.add('is-hidden');
}

function setBootMessage(message: string) {
    if (typeof message !== 'string' || !message.trim()) return;
    const text = document.getElementById('boot-overlay-text');
    if (text) text.textContent = message.trim();
}

function showLoginScreen() {
    const overlay = document.getElementById('login-overlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        overlay.classList.add('flex');
    }
    try { restoreRememberedCredentials(); } catch (e) {}
    hideBootOverlay();
}

function hideLoginScreen() {
    const overlay = document.getElementById('login-overlay');
    if (!overlay) return;
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
}

async function loadAuthenticatedSession() {
    const profile = await loadUserProfile();
    if (!profile || !profile.username) {
        return null;
    }
    return profile;
}

async function syncUiLanguageFromConfig() {
    try {
        const res = await fetch('/api/config', {
            headers: { Authorization: 'Bearer ' + (localStorage.getItem('hyve_token') || '') },
        });
        if (!res.ok) return;
        const cfg = await res.json();
        const lang = cfg?.ui?.language;
        if (lang === 'ro' || lang === 'en') setLanguage(lang);
        await loadComponentTranslations(lang === 'ro' || lang === 'en' ? lang : undefined);
    } catch (_) {}
}

function applyProfileFlags(profile: UserProfileResponse & { id?: string | number }) {
    setIsAdmin(!!profile.is_admin);
    setUserProfileContext(profile);
    try { applyDashboardEditAccess(); } catch (_) {}
    if (profile.is_admin) {
        const navAdmin = document.getElementById('nav-admin');
        if (navAdmin) navAdmin.classList.remove('hidden');
    }
}

function startBackgroundLoaders(profile: UserProfileResponse & { id?: string | number }) {
    // Fire-and-forget secondary loaders. They must NOT block the boot.
    Promise.resolve().then(() => {
        loadSessionsList().catch(e => console.warn('Sessions list load failed', e));
        if (profile.is_admin) { try { startLogStream(); } catch (e) { console.warn('Log stream failed', e); } }
        try {
            setNotificationTimer(initNotifications());
        } catch (e) { console.warn('Notifications init failed', e); }
        loadModelProfiles().catch(e => console.warn('Model profiles load failed', e));
        try { startStartupStatusPolling(); } catch (e) { console.warn('Startup status polling failed', e); }
        // Voice button visibility (cheap config probe)
        fetch('/api/integrations/catalog', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('hyve_token') }
        }).then(r => r.ok ? r.json() : null).then(data => {
            if (!data?.integrations) return;
            const whisper = data.integrations.find((i: { slug?: string }) => i.slug === 'whisper');
            const voiceBtn = document.getElementById('btn-voice');
            if (voiceBtn && whisper) voiceBtn.classList.toggle('hidden', !whisper.enabled);
        }).catch(e => console.warn('Whisper status check failed', e));
    });
}

async function bootHyve() {
    // Always start with overlay visible. CSS transition handles the fade.
    const overlay = document.getElementById('boot-overlay');
    if (overlay) overlay.classList.remove('is-hidden');
    setBootMessage('Se încarcă...');

    suppressLogout(true);
    let setupStatus: HyveSetupStatus | null = null;
    try {
        setupStatus = await withDashboardTimeout(
            fetchSetupStatus() as Promise<HyveSetupStatus>,
            10000,
            'Setup status timeout',
        );
    } catch (e) {
        console.warn('setup status check failed', e);
        setupStatus = { complete: false } as HyveSetupStatus;
    }
    if (!setupStatus?.complete) {
        clearAuthToken();
        try { localStorage.removeItem('hyve_remember'); } catch { /* ignore */ }
        suppressLogout(false);
        hideLoginScreen();
        showSetupWizard(setupStatus);
        hideBootOverlay();
        return;
    }
    suppressLogout(false);

    // Step 1: ensure we have a valid token (existing → autologin → fail)
    const stored = localStorage.getItem('hyve_token');
    let hasToken = stored && stored !== 'null' && stored !== 'undefined';
    let profile: (UserProfileResponse & { id?: string | number }) | null = null;

    if (hasToken) {
        try {
            profile = await loadAuthenticatedSession();
        } catch (e) {
            profile = null;
        }
    }

    if (!profile) {
        // Token missing or invalid — try silent auto-login from remembered creds
        clearAuthToken();
        let recovered = false;
        try { recovered = await tryAutoLogin(); } catch (e) { recovered = false; }
        if (recovered) {
            try {
                profile = await loadAuthenticatedSession();
            } catch (e) {
                profile = null;
            }
        }
    }

    if (!profile) {
        showLoginScreen();
        return;
    }

    // Step 2: profile loaded. Respect deep links before the dashboard default.
    applyProfileFlags(profile);
    await syncUiLanguageFromConfig();
    try { initDashboardSidebarNav(); } catch (_) {}
    hideLoginScreen();
    if (routeHashToView()) {
        hideBootOverlay();
        startBackgroundLoaders(profile);
        return;
    }

    // No deep link: switch to dashboard FIRST (cheap), then reveal.
    try { switchTab('dashboard'); } catch (e) { console.warn('switchTab failed', e); }

    // Step 2b: wait for the dashboard's first paint (entities + render).
    // switchTab() already kicked off loadDashboard(); the in-flight dedup
    // means this just awaits the same promise instead of double-fetching.
    try {
        await withDashboardTimeout(loadDashboard(), 20000, 'Dashboard boot timeout');
    } catch (e) {
        console.warn('Dashboard initial load failed', e);
    }

    // Step 3: reveal app — dashboard is already populated. Heavy loaders run in background.
    hideBootOverlay();
    startBackgroundLoaders(profile);
}

window.bootHyve = bootHyve;

function routeHashToView() {
    const raw = String(window.location.hash || '').replace(/^#\/?/, '').split(/[/?]/)[0].trim().toLowerCase();
    if (!raw) return false;
    const currentTab = ['dashboard', 'chat', 'config', 'memory', 'planner', 'smarthome', 'skills', 'user']
        .find(tab => {
            const view = document.getElementById(`view-${tab}`);
            return !!view && !view.classList.contains('hidden');
        }) || '';

    if (raw === 'devices' || raw === 'smarthome') {
        if (currentTab !== 'smarthome') switchTab('smarthome', { syncHash: false });
        return true;
    }
    if (raw === 'dashboard' || raw === 'home') {
        if (currentTab !== 'dashboard') switchTab('dashboard', { syncHash: false });
        return true;
    }
    if (raw === 'chat' || raw === 'planner' || raw === 'config' || raw === 'memory' || raw === 'skills' || raw === 'user') {
        if (currentTab !== raw) switchTab(raw, { syncHash: false });
        return true;
    }
    return false;
}


window.addEventListener('DOMContentLoaded', () => {
    // 0. Inițializăm limba UI
    initI18n();
    try {
        const expired = new URLSearchParams(window.location.search).has('_expired');
        if (expired) {
            showToast(t('login.session_expired'), 'warning');
            const clean = new URL(window.location.href);
            clean.searchParams.delete('_expired');
            window.history.replaceState(null, '', clean.pathname + clean.hash);
        }
    } catch (_) {}
    initThinkingModeSelector();
    initChatEventBindings({
        toggleModelSelector: () => toggleModelSelector(),
        selectThinkingMode: (mode) => setThinkingMode(_str(mode) as import('./types/dashboard.js').ThinkingMode),
        openSession: (id) => openSession(_str(id)),
        deleteSession: (id, event) => deleteSession(_str(id), event as Event),
        confirmDeleteSession: (id) => confirmDeleteSession(_str(id)),
        cancelDeleteSession: (id) => cancelDeleteSession(_str(id)),
        activateProfile: (id) => activateProfile(_str(id)),
        closeModelSelector: () => closeModelSelector(),
        showSourcesModal: (groupId) => showSourcesModal(_str(groupId)),
    });
    initPlannerEventBindings({
        closeDrawer: _lazyAction(_loadPlannerModule, 'plannerCloseDrawer'),
        openDrawer: _lazyAction(_loadPlannerModule, 'plannerOpenDrawer'),
        createList: _lazyAction(_loadPlannerModule, 'plannerCreateList'),
        setTab: (tab) => _lazyAction(_loadPlannerModule, 'plannerSetTab')(tab),
        setFilter: (filter) => _lazyAction(_loadPlannerModule, 'plannerSetFilter')(filter),
        openAdd: _lazyAction(_loadPlannerModule, 'plannerOpenAdd'),
        closeAdd: _lazyAction(_loadPlannerModule, 'plannerCloseAdd'),
        createEntry: _lazyAction(_loadPlannerModule, 'plannerCreateEntry'),
        clearActionEntity: _lazyAction(_loadPlannerModule, 'plannerClearActionEntity'),
        selectList: (id) => _lazyAction(_loadPlannerModule, 'plannerSelectList')(id),
        requestDeleteList: (id) => _lazyAction(_loadPlannerModule, 'plannerRequestDeleteList')(id),
        deleteList: (id) => _lazyAction(_loadPlannerModule, 'plannerDeleteList')(id),
        cancelDeleteList: (id) => _lazyAction(_loadPlannerModule, 'plannerCancelDeleteList')(id),
        toggleDone: (id) => _lazyAction(_loadPlannerModule, 'plannerToggleDone')(id),
        entryActions: (id) => _lazyAction(_loadPlannerModule, 'plannerEntryActions')(id),
        calPrev: _lazyAction(_loadPlannerModule, 'plannerCalPrev'),
        calNext: _lazyAction(_loadPlannerModule, 'plannerCalNext'),
        calToday: _lazyAction(_loadPlannerModule, 'plannerCalToday'),
        setCalView: (view) => _lazyAction(_loadPlannerModule, 'plannerSetCalView')(view),
        calClickDay: (day) => _lazyAction(_loadPlannerModule, 'plannerCalClickDay')(day),
        calClickHour: (day, hour) => _lazyAction(_loadPlannerModule, 'plannerCalClickHour')(day, hour),
        taskDragStart: (event, id) => _lazyAction(_loadPlannerModule, 'plannerDragStart')(event, id),
        taskDragOver: (event) => _lazyAction(_loadPlannerModule, 'plannerDragOver')(event),
        taskDrop: (event, id) => _lazyAction(_loadPlannerModule, 'plannerDrop')(event, id),
        taskDragEnd: (event) => _lazyAction(_loadPlannerModule, 'plannerDragEnd')(event),
        eventDragStart: (event, id) => _lazyAction(_loadPlannerModule, 'plannerEventDragStart')(event, id),
        eventDragOver: (event) => _lazyAction(_loadPlannerModule, 'plannerEventDragOver')(event),
        eventDragEnd: (event) => _lazyAction(_loadPlannerModule, 'plannerEventDragEnd')(event),
        eventDropDay: (event, day) => _lazyAction(_loadPlannerModule, 'plannerEventDropDay')(event, day),
        eventDropHour: (event, day, hour) => _lazyAction(_loadPlannerModule, 'plannerEventDropHour')(event, day, hour),
    });
    initSkillsEventBindings({
        backToConfig: () => switchTab('config'),
        closeModal: () => closeSkillEditModal(),
        saveEdit: () => saveSkillEdit(),
        toggleDesc: (name) => toggleSkillDesc(_str(name)),
        toggleDisabled: (name) => toggleSkillDisabled(_str(name)),
        openEdit: (name) => openSkillEdit(_str(name)),
        deleteSkill: (name) => deleteSkill(_str(name)),
    });
    initUserEventBindings({
        logout: () => doLogout(),
        switchTab: (tab) => switchUserProfileTab(_str(tab)),
        toggleFilterMenu: () => toggleUserNotificationFilterMenu(),
        switchNotificationFilter: (filter) => switchUserNotificationFilter(_str(filter)),
        saveGeneral: () => saveUserProfileGeneral(),
        saveSecurity: () => saveUserProfileSecurity(),
        notifClearAll: () => clearAllUserNotifications(),
        changeNotificationsPage: (delta) => changeUserNotificationsPage(_num(delta)),
        markNotificationRead: (id) => markUserNotificationRead(_str(id)),
        archiveNotification: (id) => archiveUserNotification(_str(id)),
        deleteNotification: (id) => deleteUserNotification(_str(id)),
        navigateNotification: (url, id) => navigateNotification(_str(url), _str(id)),
    });
    initConfigEventBindings({
        saveConfig: (event) => saveConfig(event as import('./types/features_config.js').SaveConfigOptions | Event),
        setTheme: (themeId) => setTheme(_str(themeId)),
        openSection: (section) => openConfigSection(_str(section)),
        closeSection: () => closeConfigSection(),
        switchTab: (tab) => switchConfigTab(_str(tab)),
        restartServer: () => restartServer(),
        showProfileEditor: () => showProfileEditor(),
        closeProfileCardMenu: () => closeProfileCardMenu(),
        closeProfileEditor: () => closeProfileEditor(),
        saveProfile: (event) => saveProfile(event as Event),
        switchIntegrationSubtab: (tab) => switchIntegrationSubtab(_str(tab)),
        addExtractionExample: () => addExtractionExample(),
        runConsolidationNow: () => runConsolidationNow(),
        selectNotifChannel: (channel) => selectNotifChannel(_str(channel) as 'app' | 'whatsapp'),
        selectNotifTransport: (transport) => selectNotifTransport(_str(transport) as 'websocket' | 'firebase' | 'off'),
        testNotification: () => testNotification(),
        refreshNotifWsNativeStatus: () => refreshNotifWsNativeStatus(),
        detectAppWifi: () => detectAppWifi(),
        toggleAppBiometric: () => toggleAppBiometric(),
        requestMicPermission: () => requestMicPermission(),
        requestCameraPermission: () => requestCameraPermission(),
        requestLocationPermission: () => requestLocationPermission(),
        requestStoragePermission: () => requestStoragePermission(),
        clearAppCache: () => clearAppCache(),
        checkAddonUpdates: () => checkAddonUpdates(),
        updateAllAddons: () => updateAllAddons(),
        createBackup: () => createBackup(),
        verifyBackup: (_event, el) => verifyBackup((el as HTMLElement).dataset.configPath || ''),
        restoreBackup: (_event, el) => restoreBackup((el as HTMLElement).dataset.configPath || ''),
        rollbackBackup: (_event, el) => rollbackBackup((el as HTMLElement).dataset.configPath || ''),
        saveBackupSettings: () => saveBackupSettings(),
        deleteBackupArchive: (_event, el) => deleteBackupArchive((el as HTMLElement).dataset.configPath || ''),
        testBackupRemote: () => testBackupRemote(),
        loadRemoteBackupArchives: () => loadRemoteBackupArchives(),
        pullRemoteBackup: (_event, el) => pullRemoteBackup((el as HTMLElement).dataset.configName || ''),
        restoreRemoteBackup: (_event, el) => restoreRemoteBackup((el as HTMLElement).dataset.configName || ''),
        downloadBackupArchive: (_event, el) => downloadBackupArchive((el as HTMLElement).dataset.configPath || ''),
        pickBackupUpload: () => pickBackupUpload(),
        closeAddonConfigModal: () => closeAddonConfigModal(),
        checkAddonHealth: () => checkAddonHealth(),
        copyWebhook: () => copyWebhook(),
        closeIntegrationConfigModal: () => closeIntegrationConfigModal(),
        testWhisperConnection: () => testWhisperConnection(),
        testPiperConnection: () => testPiperConnection(),
        closeAppLogModal: _lazyAction(_loadAppsModule, 'closeAppLogModal'),
        refreshAppLogs: _lazyAction(_loadAppsModule, 'refreshAppLogs'),
        closeInstallLogModal: _lazyAction(_loadAppsModule, 'closeInstallLogModal'),
        closeSceneEditor: _lazyAction(_loadScenesModule, 'closeSceneEditor'),
        addSceneEntry: _lazyAction(_loadScenesModule, 'addSceneEntry'),
        deleteSceneFromEditor: _lazyAction(_loadScenesModule, 'deleteSceneFromEditor'),
        saveScene: _lazyAction(_loadScenesModule, 'saveScene'),
        closeSceneEntityPicker: _lazyAction(_loadScenesModule, 'closeSceneEntityPicker'),
        openCreateAreaModal: _lazyAction(_loadAreasModule, 'openCreateAreaModal'),
        closeAreaEditor: _lazyAction(_loadAreasModule, 'closeAreaEditor'),
        openAreaEntityPicker: _lazyAction(_loadAreasModule, 'openAreaEntityPicker'),
        deleteAreaFromEditor: _lazyAction(_loadAreasModule, 'deleteAreaFromEditor'),
        saveAreaFromEditor: _lazyAction(_loadAreasModule, 'saveAreaFromEditor'),
        closeAreaEntityPicker: _lazyAction(_loadAreasModule, 'closeAreaEntityPicker'),
        confirmAreaEntityPicker: _lazyAction(_loadAreasModule, 'confirmAreaEntityPicker'),
        filterSceneEntityPicker: _lazyAction(_loadScenesModule, 'filterSceneEntityPicker'),
        filterAreaEntityPicker: (value) => _lazyAction(_loadAreasModule, 'filterAreaEntityPicker')(value),
        onProfileProviderChange: () => onProfileProviderChange(),
        onProfileSubProviderChange: (type) => onProfileSubProviderChange(_str(type)),
        syncVisionCapabilityCheckbox: () => syncVisionCapabilityCheckbox(),
        syncConfiguredIntegration: (slug, btn) => syncConfiguredIntegration(_str(slug), btn as HTMLButtonElement),
        openIntegrationConfigModal: (slug) => openIntegrationConfigModal(_str(slug)),
        syncIntegrationEntities: (slug) => syncIntegrationEntities(_str(slug)),
        navigateToSmartHomeSource: (slug) => navigateToSmartHomeSource(_str(slug)),
        openSmarthomeTab: () => switchTab('smarthome'),
        unlinkUserPhone: (phone) => unlinkUserPhone(_str(phone)),
        moveProfileOrder: (profileId, direction) => moveProfileOrder(_str(profileId), _str(direction) as 'up' | 'down'),
        openProfileCardMenu: (profileId, event) => openProfileCardMenu(_str(profileId), event as MouseEvent),
        openAddonConfigModal: (slug) => openAddonConfigModal(_str(slug)),
        toggleAddon: (slug, enabled) => toggleAddon(_str(slug), Boolean(enabled)),
        uninstallAddon: (slug) => uninstallAddon(_str(slug)),
        installAddon: (slug) => installAddon(_str(slug)),
        updateSingleAddon: (slug) => updateSingleAddon(_str(slug)),
        deleteUser: (id) => deleteUser(_str(id)),
        deleteArea: (id) => _lazyAction(_loadAreasModule, 'deleteArea')(id),
        editArea: (id) => _lazyAction(_loadAreasModule, 'editArea')(id),
        removeAreaEditorEntity: (entityId) => _lazyAction(_loadAreasModule, 'removeAreaEditorEntity')(entityId),
        toggleAreaPickerEntity: (entityId, checked) => _lazyAction(_loadAreasModule, 'toggleAreaPickerEntity')(entityId, checked),
        openSceneEntityPicker: (index) => _lazyAction(_loadScenesModule, 'openSceneEntityPicker')(index),
        removeSceneEntry: (index) => _lazyAction(_loadScenesModule, 'removeSceneEntry')(index),
        activateScene: (sceneId) => _lazyAction(_loadScenesModule, 'activateScene')(sceneId),
        deleteScene: (sceneId) => _lazyAction(_loadScenesModule, 'deleteScene')(sceneId),
        pickSceneEntity: (entityId) => _lazyAction(_loadScenesModule, 'pickSceneEntity')(entityId),
        detectAddonSerialPorts: (key) => _lazyAction(_loadAppsModule, 'detectAddonSerialPorts')(key),
        openAppDetail: (slug) => _lazyAction(_loadAppsModule, 'openAppDetail')(slug),
        runPreflight: (slug) => _lazyAction(_loadAppsModule, 'runPreflight')(slug),
        installApp: (slug) => _lazyAction(_loadAppsModule, 'installApp')(slug),
        toggleApp: (slug, enabled) => _lazyAction(_loadAppsModule, 'toggleApp')(slug, enabled),
        goToAddonUpdates: () => _lazyAction(_loadAppsModule, 'goToAddonUpdates')(),
        uninstallApp: (slug) => _lazyAction(_loadAppsModule, 'uninstallApp')(slug),
        closeAppDetail: () => _lazyAction(_loadAppsModule, 'closeAppDetail')(),
        appAction: (slug, action) => _lazyAction(_loadAppsModule, 'appAction')(slug, action),
        openAppLogModal: (slug, name) => _lazyAction(_loadAppsModule, 'openAppLogModal')(slug, name),
        openAddonWebUI: (slug) => _lazyAction(_loadAppsModule, 'openAddonWebUI')(slug),
        closeAddonWebUI: () => _lazyAction(_loadAppsModule, 'closeAddonWebUI')(),
        testAddonHealth: (slug) => _lazyAction(_loadAppsModule, 'testAddonHealth')(slug),
        saveAddonConfig: (slug) => {
            const s = _str(slug);
            const modal = document.getElementById('addon-config-modal');
            const modalOpen = modal && !modal.classList.contains('hidden');
            if (modalOpen || !s) return saveAddonConfigModal();
            return _lazyAction(_loadAppsModule, 'saveAddonConfig')(s);
        },
        copyPreflightFix: (text) => { const s = _str(text); if (s) navigator.clipboard.writeText(s).catch(() => {}); },
        toggleAddonWatchdog: (slug, enabled) => _lazyAction(_loadAppsModule, 'toggleAddonWatchdog')(slug, enabled),
    });
    const debouncedFilterMemory = debounce(() => filterMemory(), 200);
    initMemoryEventBindings({
        switchIntelligenceTab: (tab) => switchIntelligenceTab(_str(tab)),
        switchMemorySubtab: (tab) => switchMemorySubtab(_str(tab)),
        loadMemory: () => loadMemory(),
        changeMemPage: (delta) => changeMemPage(_num(delta)),
        loadMemoryEvents: (offset) => loadMemoryEvents(_num(offset)),
        memLogPrevPage: () => memLogPrevPage(),
        memLogNextPage: () => memLogNextPage(),
        clearMemoryLog: () => clearMemoryLog(),
        openAutomationEditor: (defId) => openAutomationEditor(defId == null ? null : _str(defId)),
        openBlueprintPicker: () => openBlueprintPicker(),
        loadAutomations: () => loadAutomations(),
        closeAutomationEditor: () => closeAutomationEditor(),
        switchAutomationEditorMode: (mode) => switchAutomationEditorMode(_str(mode)),
        addAutomationBuilderTrigger: (kind) => addAutomationBuilderTrigger(_str(kind)),
        addAutomationBuilderCondition: (kind) => addAutomationBuilderCondition(_str(kind)),
        addAutomationBuilderAction: (kind) => addAutomationBuilderAction(_str(kind)),
        removeAutomationBuilderTrigger: (idx) => removeAutomationBuilderTrigger(_num(idx)),
        removeAutomationBuilderCondition: (idx) => removeAutomationBuilderCondition(_num(idx)),
        removeAutomationBuilderAction: (idx) => removeAutomationBuilderAction(_num(idx)),
        updateAutomationStructuredServiceData: (idx) => updateAutomationStructuredServiceData(_num(idx)),
        runAutomationDefinition: (defId) => runAutomationDefinition(_str(defId)),
        toggleAutomationDefinition: (defId, enabled, revision) => toggleAutomationDefinition(_str(defId), Boolean(enabled), _str(revision)),
        deleteAutomation: (defId) => deleteAutomation(_str(defId)),
        toggleAutoMenu: (event, defId, el) => toggleAutoMenu(event as MouseEvent, _str(defId), el as HTMLElement),
        closeAutoMenu: () => closeAutoMenu(),
        showAutoDotTooltip: (event, el) => showAutoDotTooltip(event as MouseEvent, el as HTMLElement),
        hideAutoDotTooltip: () => hideAutoDotTooltip(),
        toggleMemLogDetails: (id) => toggleMemLogDetails(_str(id)),
        removeExtractionExample: (idx) => removeExtractionExample(_num(idx)),
        deleteMemBulk: (ids) => { if (Array.isArray(ids) && ids.length) return deleteMemBulk(ids); return deleteMemBulk(); },
        removeBlueprintCreatorInput: (idx) => removeBlueprintCreatorInput(_num(idx)),
        changeBlueprintCreatorInputType: (idx, type) => changeBlueprintCreatorInputType(_num(idx), _str(type)),
        insertBlueprintCreatorPlaceholder: (inputId, slugify) => insertBlueprintCreatorPlaceholder(_str(inputId), Boolean(slugify)),
        loadAutomationEditorHistory: () => loadAutomationEditorHistory(),
        validateAutomationEditor: () => validateAutomationEditor(),
        testAutomationEditor: () => testAutomationEditor(),
        importAutomationYaml: () => importAutomationYaml(),
        exportAutomationYaml: () => exportAutomationYaml(),
        saveAutomationEditor: () => saveAutomationEditor(),
        closeBlueprintPicker: () => closeBlueprintPicker(),
        openBlueprintCreator: () => openBlueprintCreator(),
        importBlueprintYaml: () => importBlueprintYaml(),
        loadBlueprints: () => loadBlueprints(),
        backToBlueprintList: () => backToBlueprintList(),
        saveCreatedBlueprint: () => saveCreatedBlueprint(),
        deleteCurrentBlueprint: () => deleteCurrentBlueprint(),
        instantiateCurrentBlueprint: () => instantiateCurrentBlueprint(),
        addBlueprintCreatorInput: () => addBlueprintCreatorInput(),
        filterMemory: () => debouncedFilterMemory(),
        toggleAllMem: (checked) => toggleAllMem(Boolean(checked)),
        autoSyncAutomationId: () => autoSyncAutomationId(),
        markAutomationIdManual: () => markAutomationIdManual(),
        syncAutomationYamlFromBuilder: (opts) => syncAutomationYamlFromBuilder((opts || {}) as import('./types/features_automations.js').SyncAutomationOptions),
        updateBlueprintCreatorYaml: () => updateBlueprintCreatorYaml(),
        updateMemBulkCount: () => updateMemBulkCount(),
    });
    initShellEventBindings({
        toggleSidebar: () => toggleSidebar(),
        switchTab: (tab) => switchTab(_str(tab)),
        newChatSession: () => newChatSession(),
        clearSessionContext: () => clearSessionContext(),
    });
    initSmarthomeEventBindings({
        openConfigHub: () => {
            window.location.hash = '#/config';
            switchTab('config');
        },
        openIntegrations: () => {
            window.location.hash = '#/config';
            switchTab('config');
            openConfigSection('integrations');
        },
        syncSmartHome: () => { void syncHA(); },
        openDerivedModal: (entityId) => _lazyAction(_loadDerivedModule, 'openDerivedModal')(entityId || undefined),
        toggleSmarthomeFilters: () => toggleSmarthomeFilters(),
        resetSmarthomeFilters: () => resetSmarthomeFilters(),
        sortDevicesBy: (sortBy) => sortDevicesBy(_str(sortBy)),
        handleHaRowClick: (event) => handleHaRowClick(event as MouseEvent),
        openAliasModal: (entityId) => openAliasModal(_str(entityId)),
        setDevicesPage: (page) => setDevicesPage(_num(page)),
        setDevicesPageSize: (value) => setDevicesPageSize(_num(value)),
        toggleSmarthomePicker: (event) => toggleSmarthomePicker(event as MouseEvent),
        selectSmarthomePickerOption: (event) => selectSmarthomePickerOption(event as Event),
        toggleSelection: (entityId, checked) => toggleSelection(_str(entityId), Boolean(checked)),
        toggleDerivedSelection: (entityId, checked) => _lazyAction(_loadDerivedModule, 'toggleDerivedSelection')(entityId, checked),
        toggleAllAIVisible: (checked) => toggleAllAI(Boolean(checked)),
        openAliasModalFromDetail: (entityId) => openAliasModalFromDetail(_str(entityId)),
        controlDeviceEntity: (source, entityId, action, btn, data) => controlDeviceEntity(
            _str(source), _str(entityId), _str(action), btn as HTMLElement, (data && typeof data === 'object' ? data : {}) as Record<string, unknown>,
        ),
        closeEntityDetailModal: () => closeEntityDetailModal(),
        closeDerivedModal: _lazyAction(_loadDerivedModule, 'closeDerivedModal'),
        deleteDerivedFromModal: _lazyAction(_loadDerivedModule, 'deleteDerivedFromModal'),
        switchDerivedView: (view) => _lazyAction(_loadDerivedModule, 'switchDerivedView')(view),
        switchDerivedBuilder: (builder) => _lazyAction(_loadDerivedModule, 'switchDerivedBuilder')(builder),
        insertDerivedExpressionEntity: _lazyAction(_loadDerivedModule, 'insertDerivedExpressionEntity'),
        reloadDerivedYaml: _lazyAction(_loadDerivedModule, 'reloadDerivedYaml'),
        saveDerived: _lazyAction(_loadDerivedModule, 'saveDerived'),
        closeRowActionsModal: () => closeRowActionsModal(),
        copyEntityIdFromRowActions: () => copyEntityIdFromRowActions(),
        closeAliasModal: () => closeAliasModal(),
        addAliasInput: () => addAliasInput(),
        saveAliasesFromModal: () => saveAliasesFromModal(),
        filterDerivedCandidates: () => _lazyAction(_loadDerivedModule, 'filterDerivedCandidates')(),
        toggleDerivedInput: (el) => _lazyAction(_loadDerivedModule, 'toggleDerivedInput')(el),
        openDeviceDetail: (deviceKey) => openDeviceDetail(_str(deviceKey)),
        closeDeviceDetail: () => closeDeviceDetail(),
        openEntityDetail: (entityId) => openEntityDetail(_str(entityId)),
        closeEntityDetail: () => closeEntityDetail(),
        renameDeviceDetail: (_event, el) => {
            if (!(el instanceof HTMLElement)) return;
            void renameIntegrationDevice(
                el.dataset.smarthomeSourceSlug || '',
                el.dataset.smarthomeDeviceId || '',
                el.dataset.smarthomeDeviceName || '',
            );
        },
        closeDevicePrimaryModal: () => closeDevicePrimaryModal(),
        selectDevicePrimaryEntity: (deviceKey, entityId) => selectDevicePrimaryEntity(_str(deviceKey), entityId ? _str(entityId) : null),
        filterEntityCategory: (category) => filterEntityCategory(_str(category)),
    });
    initIntegrationEventBindings({
        controlIntegrationEntity: (...args) => controlIntegrationEntity(...args),
        openIntegrationEntityCard: (encoded) => openIntegrationEntityCard(encoded),
        openIntegrationDeviceModal: (idx, slug) => openIntegrationDeviceModal(idx, slug),
        renameIntegrationDevice: (...args) => renameIntegrationDevice(...args),
    });
    initHyColorPickerBindings();
    try { initDashboardSidebarNav(); } catch (_) {}
    applyInitialGreeting();

    // 0.1 Sidebar gestures (mobile): swipe right from edge to open,
    // swipe left on sidebar to close.
    initSidebarGestures();

    // 1. Aplicăm tema salvată
    setTheme(getStoredThemeId());
    loadThemeSelector();

    // 1.1 Reveal native-app-only elements if running inside the Hyve Android app
    initNativeAppBridge();
    
    // 2. Bind la formularele principale (FastAPI form-data format)
    const loginForm = document.getElementById('login-form');
    if (loginForm) loginForm.onsubmit = handleLogin;
    initSetupWizard();

    // 3. Auth + app boot — single deterministic state machine.
    bootHyve().catch(err => {
        console.error('bootHyve failed', err);
        try { clearAuthToken(); } catch (_) {}
        showLoginScreen();
    });
    window.addEventListener('hashchange', routeHashToView);

    // 4. Bind evenimente Chat
    const btnSend = document.getElementById('btn-send');
    if (btnSend) btnSend.onclick = () => {
        if (btnSend.classList.contains('streaming')) stopStreaming();
        else sendMessage();
    };

    const btnAttach = document.getElementById('btn-attach');
    const balloon = document.getElementById('chat-attach-balloon');
    const imageInput = document.getElementById('chat-image-input') as HTMLInputElement | null;
    const cameraInput = document.getElementById('chat-camera-input') as HTMLInputElement | null;
    const documentInput = document.getElementById('chat-document-input') as HTMLInputElement | null;
    if (btnAttach && balloon) {
        btnAttach.title = t('chat.attach_image');
        btnAttach.setAttribute('aria-label', t('chat.attach_image'));
        btnAttach.onclick = (e) => {
            e.stopPropagation();
            const singleAttach = btnAttach.getAttribute('data-single-attach');
            if (singleAttach === 'document') {
                if (documentInput) documentInput.click();
                return;
            }
            if (singleAttach === 'image') {
                if (imageInput) imageInput.click();
                return;
            }
            const isOpen = !balloon.classList.contains('hidden');
            balloon.classList.toggle('hidden', isOpen);
            btnAttach.setAttribute('aria-expanded', String(!isOpen));
            if (!isOpen) closeModelSelector();
        };
        document.addEventListener('click', () => {
            balloon.classList.add('hidden');
            btnAttach.setAttribute('aria-expanded', 'false');
        });
        balloon.addEventListener('click', (e) => e.stopPropagation());
    }
    if (balloon) {
        // Camera button starts hidden (HTML has .hidden class), shown only in native app

        balloon.querySelectorAll('.chat-attach-balloon-item[data-attach="image"]').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('[ATTACH] Image button clicked');
                if (imageInput) {
                    console.log('[ATTACH] Triggering imageInput.click()');
                    imageInput.click();
                } else {
                    console.warn('[ATTACH] imageInput not found');
                }
                balloon.classList.add('hidden');
                if (btnAttach) btnAttach.setAttribute('aria-expanded', 'false');
            };
        });
        balloon.querySelectorAll('.chat-attach-balloon-item[data-attach="camera"]').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('[ATTACH] Camera button clicked');
                if (cameraInput) {
                    console.log('[ATTACH] Triggering cameraInput.click()');
                    cameraInput.click();
                } else {
                    console.warn('[ATTACH] cameraInput not found');
                }
                balloon.classList.add('hidden');
                if (btnAttach) btnAttach.setAttribute('aria-expanded', 'false');
            };
        });
        balloon.querySelectorAll('.chat-attach-balloon-item[data-attach="document"]').forEach(btn => {
            (btn as HTMLElement).onclick = (e: MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('[ATTACH] Document button clicked');
                if (documentInput) {
                    console.log('[ATTACH] Triggering documentInput.click()');
                    documentInput.click();
                } else {
                    console.warn('[ATTACH] documentInput not found');
                }
                balloon.classList.add('hidden');
                if (btnAttach) btnAttach.setAttribute('aria-expanded', 'false');
            };
        });
    }
    if (imageInput) {
        imageInput.onchange = () => {
            console.log('[ATTACH] imageInput.onchange fired');
            const file = imageInput.files?.[0];
            console.log('[ATTACH] File:', file?.name, file?.type);
            if (!file || !file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = () => { if (typeof reader.result === 'string') addAttachedImage(reader.result); };
            reader.readAsDataURL(file);
            imageInput.value = '';
        };
    }
    if (cameraInput) {
        cameraInput.onchange = () => {
            console.log('[ATTACH] cameraInput.onchange fired');
            const file = cameraInput.files?.[0];
            console.log('[ATTACH] File:', file?.name, file?.type);
            if (!file || !file.type.startsWith('image/')) return;
            const reader = new FileReader();
            reader.onload = () => { if (typeof reader.result === 'string') addAttachedImage(reader.result); };
            reader.readAsDataURL(file);
            cameraInput.value = '';
        };
    }
    if (documentInput) {
        documentInput.onchange = async () => {
            const file = documentInput.files?.[0];
            if (!file) return;
            const name = (file.name || '').toLowerCase();
            try {
                if (name.endsWith('.txt')) {
                    const text = await file.text();
                    addAttachedDocument(text, file.name);
                } else {
                    const formData = new FormData();
                    formData.append('file', file);
                    const token = localStorage.getItem('hyve_token') || authToken;
                    const res = await fetch('/api/extract-document', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${token}` },
                        body: formData
                    });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err.detail || res.statusText);
                    }
                    const data = await res.json();
                    addAttachedDocument(data.text || '', file.name);
                }
            } catch (err) {
                showToast(_errMsg(err) || t('chat.error_document') || 'Document error', 'error');
            }
            documentInput.value = '';
        };
    }

    const input = document.getElementById('user-input') as HTMLTextAreaElement | null;
    if (input) {
        input.onkeydown = (e) => {
            // Let slash autocomplete handle arrow/tab/enter/esc first
            if (handleSlashKeydown(e)) return;
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        };
        input.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 160) + 'px';
            handleSlashInput(input.value);
        });
        // Paste image from clipboard (Ctrl+V / Cmd+V with image)
        input.addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const blob = item.getAsFile();
                    if (!blob) continue;
                    const reader = new FileReader();
                    reader.onload = () => { const r = reader.result; if (typeof r === 'string') addAttachedImage(r); };
                    reader.readAsDataURL(blob);
                    return; // only first image
                }
            }
        });
        input.onfocus = () => {
            if (!currentSessionId) newChatSession();
        };
        input.onblur = () => {
            // Nav visibility managed centrally by _onKeyboardChange / __onAndroidKeyboard
        };
    }

    // Handle virtual keyboard — works both from Android native callback and visualViewport API.
    // ── Drag & drop image onto chat area ──────────────────────────
    const chatWrapper = document.querySelector('.chat-messages-wrapper') || document.getElementById('chat-container');
    if (chatWrapper) {
        chatWrapper.addEventListener('dragover', (e: Event) => { const de = e as DragEvent; de.preventDefault(); if (de.dataTransfer) de.dataTransfer.dropEffect = 'copy'; });
        chatWrapper.addEventListener('drop', (e: Event) => { const de = e as DragEvent;
            de.preventDefault();
            const file = [...(de.dataTransfer?.files || [])].find(f => f.type.startsWith('image/'));
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => { if (typeof reader.result === 'string') addAttachedImage(reader.result); };
            reader.readAsDataURL(file);
        });
    }

    const _onKeyboardChange = (kbHeight: number) => {
        const isOpen = kbHeight > 80;
        // Hide bottom nav when keyboard is up
        const nav = document.getElementById('mobile-nav');
        if (nav) nav.style.display = isOpen ? 'none' : '';

        const wrapper = document.querySelector('.chat-messages-wrapper');
        const container = document.getElementById('chat-container');
        const emptyState = document.getElementById('chat-empty-state');

        if (isOpen) {
            if (container && container.children.length > 0) {
                // Chat has messages → scroll last message into view above keyboard
                requestAnimationFrame(() => {
                    if (wrapper) wrapper.scrollTop = wrapper.scrollHeight;
                });
            } else {
                // Chat is empty → keep logo centered in the reduced space
                if (emptyState) {
                    emptyState.style.paddingBottom = '0';
                    emptyState.style.justifyContent = 'center';
                }
            }
        } else {
            // Keyboard closed → restore empty state
            if (emptyState) {
                emptyState.style.paddingBottom = '';
                emptyState.style.justifyContent = '';
            }
        }
    };

    // Android WebView — called by MainActivity via evaluateJavascript
    window.__onAndroidKeyboard = _onKeyboardChange;

    // Fallback: visualViewport API for browsers
    if (window.visualViewport) {
        let _lastVVHeight = window.visualViewport.height;
        window.visualViewport.addEventListener('resize', () => {
            const vv = window.visualViewport;
            if (!vv) return;
            const delta = _lastVVHeight - vv.height;
            _lastVVHeight = vv.height;
            _onKeyboardChange(delta > 80 ? delta : 0);
        });
    }

    // 5. Form creare user (admin)
    const adminForm = document.getElementById('admin-create-user-form');
    if (adminForm) {
        adminForm.onsubmit = async (e) => {
            e.preventDefault();
            const username = _appEl('admin-username')?.value?.trim();
            const password = _appEl('admin-password')?.value || '';
            const fullName = _appEl('admin-full-name')?.value?.trim();
            if (!username || !password) return;
            try {
                await createUser(username, password, fullName || '');
                const u = _appEl('admin-username'); const p = _appEl('admin-password'); const f = _appEl('admin-full-name');
                if (u) u.value = '';
                if (p) p.value = '';
                if (f) f.value = '';
                await loadAdminUsers();
                showToast(t('admin.created'), 'success');
            } catch (err) {
                showToast(_errMsg(err) || t('admin.error_create'), 'error');
            }
        };
    }
});

// --- Section loaders + nav bridge (replaces lazy window.* globals) ---
registerNavBridge({
    switchTab,
    closeSidebar,
    toggleSidebar,
    isSidebarOpen,
    openConfigSection,
    switchUserProfileTab,
    loadUserProfilePage,
    populateAppTab,
    loadSessionsList,
    initDashboardSidebarNav,
    loadPlanner: _lazyAction(_loadPlannerModule, 'loadPlanner'),
    loadApps: _lazyAction(_loadAppsModule, 'loadApps'),
    loadScenes: _lazyAction(_loadScenesModule, 'loadScenes'),
    loadAreas: _lazyAction(_loadAreasModule, 'loadAreas'),
    closeAddonWebUI: () => _lazyAction(_loadAppsModule, 'closeAddonWebUI')(),
} as DelegatedEventHandlers);
