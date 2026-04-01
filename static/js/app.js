import { authToken, clearAuthToken } from './api.js';
import { showToast, debounce, showConfirm } from './utils.js';
import { handleLogin, loadUserProfile, restoreRememberedCredentials, tryAutoLogin } from './auth.js';
import { setTheme, loadThemeSelector, toggleSidebar, switchTab, switchConfigTab, openConfigSection, closeConfigSection, startLogStream, initSidebarGestures, getStoredThemeId } from './ui.js';
import { initI18n, setLanguage, t } from './lang/index.js';
import { sendMessage, stopStreaming, initNotifications, currentSessionId, addAttachedImage, addAttachedDocument, applyInitialGreeting, handleSlashInput, handleSlashKeydown } from './chat.js';
import { initConference } from './conference.js';

// Expose conference init for ui.js switchTab
window._confInit = initConference;

// Expose sendMessage globally so other modules (e.g. voice input in features.js) can call it
window.sendMessage = sendMessage;
import { 
    saveConfig, restartServer, syncHA, toggleDevice, 
    toggleSelection, toggleAllAI, loadMemory, filterDevices, changeMemPage, 
    deleteMemBulk, filterMemory, toggleAllHA, updateHABulkCount, 
    deleteHABulk, deleteHASingle, saveAliases, toggleAllMem, updateMemBulkCount,
    filterHAByDomain, toggleHABulkMode,
    openAliasModal, addAliasInput, closeAliasModal, saveAliasesFromModal, openRowActionsModal, closeRowActionsModal, handleHaRowClick,
    openAddDevicesModal, closeAddDevicesModal, confirmAddDevices, toggleAvailableDevice, toggleAllAvailableDevices, filterAvailableDevices,
    loadSessionsList, openSession, newChatSession, deleteSession, confirmDeleteSession, cancelDeleteSession, clearSessionContext,
    copyWebhook, openIntegrationConfigModal, closeIntegrationConfigModal, copyAssistOllamaUserUrl, copyAssistKey, regenerateAssistKey, loadAdminUsers, createUser, deleteUser, unlinkUserPhone,
    loadModelProfiles,
    loadSkills, openSkillEdit, closeSkillEditModal, saveSkillEdit, deleteSkill,
    toggleSkillDesc, toggleSkillDisabled,
    loadMemoryEvents, memLogPrevPage, memLogNextPage, toggleMemLogDetails, clearMemoryLog, runConsolidationNow,
    switchIntelligenceTab,
    addExtractionExample, removeExtractionExample,
    loadReminders, loadAutomations, deleteReminder, deleteAutomation, openMementoEdit, closeMementoEdit, saveMementoEdit, updateMementoBulkCount, toggleAllMemento, deleteMementoBulk,
    openAutomationEditor, closeAutomationEditor, saveAutomationEditor, validateAutomationEditor, toggleAutomationDefinition, runAutomationDefinition,
    switchAutomationEditorMode, addAutomationBuilderAction, removeAutomationBuilderAction, addAutomationBuilderTrigger, removeAutomationBuilderTrigger, addAutomationBuilderCondition, removeAutomationBuilderCondition, syncAutomationYamlFromBuilder, syncAutomationBuilderFromYaml, loadAutomationEditorHistory, refreshAutomationEntityOptions, setAutomationEntityPickerTarget, pickAutomationEntity, filterAutomationEntityPicker, setAutomationServicePickerTarget, pickAutomationService, filterAutomationServicePicker, updateAutomationStructuredServiceData,
    loadNotificationPrefs, saveNotificationSettings, selectNotifTransport, selectNotifChannel, testWsNotification, testFcmNotification, testNotification, refreshNotifWsNativeStatus,
} from './features.js';
import {
    loadPlanner, plannerCreateList, plannerDeleteList, plannerSelectList,
    plannerOpenDrawer, plannerCloseDrawer, plannerSetTab, plannerSetFilter,
    plannerCalPrev, plannerCalNext, plannerCalToday, plannerSetCalView, plannerSelectDay,
    plannerCalClickDay, plannerCalClickHour,
    plannerEventDragStart, plannerEventDragOver, plannerEventDragEnd, plannerEventDropDay, plannerEventDropHour,
    plannerCreateEntry, plannerOpenAdd, plannerCloseAdd,
    plannerToggleDone, plannerDeleteEntry, plannerCycleType, plannerEntryActions,
    plannerDragStart, plannerDragOver, plannerDrop, plannerDragEnd
} from './planner.js';
import {
    loadApps, appAction, openAppLogModal, closeAppLogModal, refreshAppLogs,
    openAppDetail, closeAppDetail,
    installApp, uninstallApp, toggleApp, closeInstallLogModal, runPreflight
} from './features_apps.js';

// Logout disponibil imediat (înainte de orice async), ca butonul să funcționeze mereu
async function doLogout() {
    // Show confirmation dialog
    const confirmMessage = (typeof t === 'function') ? t('header.logout_confirm') : 'Ești sigur că vrei să te deconectezi?';
    if (!(await showConfirm(confirmMessage))) {
        return;
    }

    const token = localStorage.getItem('memini_token');

    const finalizeLogout = () => {
    try {
        if (window.__clearNativeAuthToken) {
            window.__clearNativeAuthToken();
        }
    } catch (e) {}
    try { clearAuthToken(); } catch (e) {}
    try {
        localStorage.removeItem('memini_token');
        localStorage.removeItem('memini_session_id');
        localStorage.removeItem('memini_remember');
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
        if (!window.__MEMINI_NATIVE_APP) return;

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
        setTheme(localStorage.getItem('memini_theme') || 'obsidian');
    }, 300);
}

function populateAppTab() {
    const cfg = window.__MEMINI_NATIVE_CONFIG;
    if (!cfg) return;

    const el = (id) => document.getElementById(id);
    const urlExt = el('app-url-external');
    const urlLocal = el('app-url-local');
    const wifi = el('app-wifi-ssid');
    const modeLabel = el('app-mode-label');
    const ssidLabel = el('app-current-ssid');
    const bioToggle = el('app-biometric-toggle');
    const bioRow = el('app-biometric-row');
    const bioHint = el('app-biometric-hint');

    if (urlExt) urlExt.value = cfg.externalUrl || '';
    if (urlLocal) urlLocal.value = cfg.localUrl || '';
    if (wifi) wifi.value = cfg.homeWifi || '';
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

    // Refresh live WS service status when App tab opens
    refreshWsServiceStatus();
}

let _wsStatusPollTimer = null;

function _setWsStatusBadge(state) {
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
    if (!window.__MEMINI_NATIVE_APP) {
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
                clearInterval(_wsStatusPollTimer);
                _wsStatusPollTimer = null;
                return;
            }
            try {
                const isRunning = window.__getNativeWsServiceStatus();
                _setWsStatusBadge(typeof isRunning === 'boolean' ? isRunning : null);
            } catch (_) {
                _setWsStatusBadge(null);
            }
        }, 5000);
    }
}

function updateBiometricToggle(on) {
    const btn = document.getElementById('app-biometric-toggle');
    if (!btn) return;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.setAttribute('data-on', on ? 'true' : 'false');
    btn.__biometricOn = on;
}

function toggleAppBiometric() {
    const btn = document.getElementById('app-biometric-toggle');
    const newState = !(btn?.__biometricOn ?? false);
    updateBiometricToggle(newState);
}

function saveAppConfig() {
    if (typeof window.__saveNativeServerConfig !== 'function') {
        // Not in native app — nothing to save
        return;
    }
    const bioBtn = document.getElementById('app-biometric-toggle');
    const config = {
        externalUrl: document.getElementById('app-url-external')?.value?.trim() || '',
        localUrl: document.getElementById('app-url-local')?.value?.trim() || '',
        homeWifi: document.getElementById('app-wifi-ssid')?.value?.trim() || '',
        biometricEnabled: bioBtn?.__biometricOn ?? false
    };
    window.__saveNativeServerConfig(config);
}

function detectAppWifi() {
    const input = document.getElementById('app-wifi-ssid');
    if (!input) return;

    // Ask native to refresh the SSID and return it
    if (typeof window.__getNativeWifiSsid === 'function') {
        const ssid = window.__getNativeWifiSsid();
        if (ssid) {
            input.value = ssid;
            showToast(`WiFi detectat: ${ssid}`, 'success');
            return;
        }
    }

    // Fallback: use the config snapshot
    const cfg = window.__MEMINI_NATIVE_CONFIG;
    if (cfg?.currentSsid) {
        input.value = cfg.currentSsid;
        showToast(`WiFi detectat: ${cfg.currentSsid}`, 'success');
    } else {
        showToast('Nu s-a putut detecta rețeaua WiFi.', 'error');
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
        const token = localStorage.getItem('memini_token');
        const remember = localStorage.getItem('memini_remember');
        localStorage.clear();
        if (token) localStorage.setItem('memini_token', token);
        if (remember) localStorage.setItem('memini_remember', remember);
        cleared = true;
    } catch (e) {}

    if (cleared) {
        showToast('Cache-ul a fost șters.', 'success');
    } else {
        showToast('Eroare la ștergerea cache-ului.', 'error');
    }
}

window.saveAppConfig = saveAppConfig;
window.detectAppWifi = detectAppWifi;
window.clearAppCache = clearAppCache;
window.populateAppTab = populateAppTab;
window.toggleAppBiometric = toggleAppBiometric;
window.refreshWsServiceStatus = refreshWsServiceStatus;

// ── Permissions management ───────────────────────────────────────────

function updatePermissionBadge(badgeId, btnId, state) {
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
    return !!window.__MEMINI_NATIVE_APP && typeof window.__checkNativePermission === 'function';
}

/**
 * Global callback invoked by native Android when a permission request completes.
 * The native side calls: window.__onNativePermissionResult('camera', true/false)
 */
window.__onNativePermissionResult = function(name, granted) {
    console.log('[PERMS] Native permission result:', name, granted);
    const state = granted ? 'granted' : 'denied';
    const mapping = {
        microphone: { badge: 'app-perm-mic-status', btn: 'app-perm-mic-btn', toast: granted ? 'config.app_perm_mic_granted' : 'config.app_perm_mic_denied_toast' },
        camera:     { badge: 'app-perm-camera-status', btn: 'app-perm-camera-btn', toast: granted ? 'config.app_perm_camera_granted' : 'config.app_perm_camera_denied_toast' },
        location:   { badge: 'app-perm-location-status', btn: 'app-perm-location-btn', toast: granted ? 'config.app_perm_location_granted' : 'config.app_perm_location_denied_toast' },
        storage:    { badge: 'app-perm-storage-status', btn: 'app-perm-storage-btn', toast: granted ? 'config.app_perm_storage_granted' : 'config.app_perm_storage_denied_toast' },
    };
    const m = mapping[name];
    if (m) {
        updatePermissionBadge(m.badge, m.btn, state);
        showToast(t(m.toast) || (granted ? 'Permission granted' : 'Permission denied'), granted ? 'success' : 'error');
    }
};

async function checkPermissions() {
    console.log('[PERMS] checkPermissions called, native:', _isNativeApp());

    if (_isNativeApp()) {
        // Use native Android bridge to check all permissions
        const perms = ['microphone', 'camera', 'location', 'storage'];
        const badgeMap = {
            microphone: { badge: 'app-perm-mic-status', btn: 'app-perm-mic-btn' },
            camera:     { badge: 'app-perm-camera-status', btn: 'app-perm-camera-btn' },
            location:   { badge: 'app-perm-location-status', btn: 'app-perm-location-btn' },
            storage:    { badge: 'app-perm-storage-status', btn: 'app-perm-storage-btn' },
        };
        for (const p of perms) {
            try {
                const state = window.__checkNativePermission(p);
                console.log('[PERMS] Native check', p, '=', state);
                updatePermissionBadge(badgeMap[p].badge, badgeMap[p].btn, state);
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
    if (_isNativeApp()) { window.__requestNativePermission('microphone'); return; }
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
    if (_isNativeApp()) { window.__requestNativePermission('camera'); return; }
    showToast('Camera permissions are managed in the Android app', 'info');
}

function requestLocationPermission() {
    if (_isNativeApp()) { window.__requestNativePermission('location'); return; }
    // Browser fallback
    if (!navigator.geolocation) {
        showToast('Location not available', 'error');
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
    if (_isNativeApp()) { window.__requestNativePermission('storage'); return; }
    showToast('Storage permissions are managed in the Android app', 'info');
}

// ── Conference Settings ──────────────────────────────────────────

async function loadConferenceSettings() {
    try {
        const res = await fetch('/api/config', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('memini_token') }
        });
        if (!res.ok) return;
        const cfg = await res.json();
        const conf = cfg.conference || {};

        // Enabled toggle
        const confCheckbox = document.getElementById('conf_enabled');
        const confNavBtn = document.getElementById('nav-conference');
        if (confCheckbox) confCheckbox.checked = !!conf.enabled;
        if (confNavBtn) confNavBtn.classList.toggle('hidden', !conf.enabled);
        toggleConfSettingsVisibility();

        // Turns
        const minEl = document.getElementById('conf_min_turns');
        const maxEl = document.getElementById('conf_max_turns');
        if (minEl) minEl.value = conf.min_turns ?? 4;
        if (maxEl) maxEl.value = conf.max_turns ?? 15;

        // Orchestrator model profile
        const orchSelect = document.getElementById('conf_orchestrator_model');
        if (orchSelect) {
            // Populate options from model profiles
            const profilesRes = await fetch('/api/model-profiles', {
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('memini_token') }
            });
            if (profilesRes.ok) {
                const profilesData = await profilesRes.json();
                const profiles = profilesData.profiles || [];
                orchSelect.innerHTML = '<option value="">Auto (preferă local)</option>' +
                    profiles.map(p => `<option value="${p.id}" ${conf.orchestrator_model_profile_id === p.id ? 'selected' : ''}>${p.name || ''} (${p.model_name || ''})</option>`).join('');
            }
        }

        // Synthesis enabled
        const synthEl = document.getElementById('conf_synthesis_enabled');
        if (synthEl) synthEl.checked = conf.synthesis_enabled !== false;

        // Expert Memory enabled
        const memEl = document.getElementById('conf_expert_memory_enabled');
        if (memEl) memEl.checked = conf.expert_memory_enabled !== false;

        // Custom prompts — pre-fill with defaults if not customized
        let defaults = {};
        try {
            const defRes = await fetch('/api/conference/default-prompts', {
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('memini_token') }
            });
            if (defRes.ok) defaults = await defRes.json();
        } catch (_) {}

        const ciEl = document.getElementById('conf_conversation_instruction');
        if (ciEl) ciEl.value = conf.conversation_instruction || defaults.conversation_instruction || '';
        const opEl = document.getElementById('conf_orchestrator_prompt');
        if (opEl) opEl.value = conf.orchestrator_system_prompt || defaults.orchestrator_system_prompt || '';
        const spEl = document.getElementById('conf_summary_prompt');
        if (spEl) spEl.value = conf.summary_system_prompt || defaults.summary_system_prompt || '';
        const apEl = document.getElementById('conf_artifact_prompt');
        if (apEl) apEl.value = conf.artifact_system_prompt || defaults.artifact_system_prompt || '';

        // Conference modes — dynamic list
        await renderConfModesList();

    } catch (e) {
        console.warn('Failed to load conference settings', e);
    }
}

async function saveConferenceSettings() {
    const confCheckbox = document.getElementById('conf_enabled');
    const enabled = confCheckbox ? confCheckbox.checked : true;
    const confNavBtn = document.getElementById('nav-conference');
    if (confNavBtn) confNavBtn.classList.toggle('hidden', !enabled);

    const minEl = document.getElementById('conf_min_turns');
    const maxEl = document.getElementById('conf_max_turns');
    const orchEl = document.getElementById('conf_orchestrator_model');
    const synthEl = document.getElementById('conf_synthesis_enabled');
    const memEl = document.getElementById('conf_expert_memory_enabled');

    const payload = {
        conference: {
            enabled,
            min_turns: parseInt(minEl?.value) || 4,
            max_turns: parseInt(maxEl?.value) || 15,
            orchestrator_model_profile_id: orchEl?.value || '',
            synthesis_enabled: synthEl ? synthEl.checked : true,
            expert_memory_enabled: memEl ? memEl.checked : true,
            conversation_instruction: document.getElementById('conf_conversation_instruction')?.value?.trim() || '',
            orchestrator_system_prompt: document.getElementById('conf_orchestrator_prompt')?.value?.trim() || '',
            summary_system_prompt: document.getElementById('conf_summary_prompt')?.value?.trim() || '',
            artifact_system_prompt: document.getElementById('conf_artifact_prompt')?.value?.trim() || '',
        }
    };

    try {
        const res = await fetch('/api/config', {
            method: 'PATCH',
            headers: {
                'Authorization': 'Bearer ' + localStorage.getItem('memini_token'),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            showToast(t('config.saved') || 'Settings saved', 'success');
        } else {
            showToast(t('config.save_error') || 'Failed to save settings', 'error');
        }
    } catch (e) {
        console.warn('Failed to save conference settings', e);
        showToast(t('config.save_error') || 'Failed to save settings', 'error');
    }
}

async function resetConferencePrompt(type) {
    try {
        const res = await fetch('/api/conference/default-prompts', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('memini_token') }
        });
        if (!res.ok) { showToast('Eroare la încărcarea prompt-urilor implicite', 'error'); return; }
        const defaults = await res.json();

        const map = {
            conversation_instruction: { id: 'conf_conversation_instruction', key: 'conversation_instruction' },
            orchestrator_prompt: { id: 'conf_orchestrator_prompt', key: 'orchestrator_system_prompt' },
            summary_prompt: { id: 'conf_summary_prompt', key: 'summary_system_prompt' },
            artifact_prompt: { id: 'conf_artifact_prompt', key: 'artifact_system_prompt' },
        };
        const entry = map[type];
        if (!entry) return;
        const el = document.getElementById(entry.id);
        if (el) el.value = defaults[entry.key] || '';
        await saveConferenceSettings();
    } catch (e) {
        console.warn('resetConferencePrompt error', e);
    }
}

// ── Conference Modes CRUD ──────────────────────────────────────────────
const _MODE_ICONS = [
    'fa-lightbulb','fa-comments','fa-search','fa-calendar','fa-code','fa-flask',
    'fa-brain','fa-shield','fa-rocket','fa-chess-knight','fa-scale-balanced',
    'fa-paintbrush','fa-chart-line','fa-gavel','fa-wrench','fa-fire',
    'fa-bolt','fa-gem','fa-globe','fa-compass','fa-crown','fa-eye',
    'fa-graduation-cap','fa-palette','fa-seedling','fa-feather','fa-microscope',
    'fa-book','fa-wand-magic-sparkles','fa-star',
];
const _MODE_COLORS = [
    '#f59e0b','#ef4444','#10b981','#3b82f6','#8b5cf6','#ec4899',
    '#06b6d4','#f97316','#84cc16','#14b8a6','#6366f1','#e11d48',
    '#0ea5e9','#d946ef','#a3e635','#fbbf24','#f43f5e','#22d3ee',
];

function _escHtml(s) {
    const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

async function renderConfModesList() {
    const container = document.getElementById('conf_modes_list');
    if (!container) return;
    try {
        const res = await fetch('/api/conference/modes', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('memini_token') }
        });
        if (!res.ok) return;
        const modes = await res.json();
        container.innerHTML = modes.map(m => `
            <div class="conf-mode-card flex items-start gap-3 p-3 rounded-xl bg-slate-900/50 border border-white/5 hover:border-white/10 transition-all group">
                <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style="background: ${m.color}22; color: ${m.color}">
                    <i class="fas ${m.icon} text-sm"></i>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <span class="text-sm font-semibold text-slate-200">${_escHtml(m.name)}</span>
                        ${m.builtin ? '<span class="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/20 text-violet-400 font-bold">BUILT-IN</span>' : ''}
                    </div>
                    <p class="text-[10px] text-slate-500 mt-0.5 line-clamp-2 font-mono">${_escHtml((m.prompt || '').substring(0, 120))}${(m.prompt || '').length > 120 ? '…' : ''}</p>
                </div>
                <div class="flex items-center gap-1 flex-shrink-0 opacity-50 group-hover:opacity-100 transition-opacity">
                    <button type="button" onclick="openConfModeModal('${m.id}')" class="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-violet-400 transition-colors cursor-pointer" title="Editează">
                        <i class="fas fa-pen text-[10px]"></i>
                    </button>
                    ${!m.builtin ? `<button type="button" onclick="deleteConfMode('${m.id}')" class="p-1.5 rounded-lg hover:bg-white/5 text-slate-400 hover:text-red-400 transition-colors cursor-pointer" title="Șterge">
                        <i class="fas fa-trash text-[10px]"></i>
                    </button>` : ''}
                </div>
            </div>
        `).join('');
    } catch (e) {
        console.warn('renderConfModesList error', e);
    }
}

let _confModesCache = [];

async function openConfModeModal(editId) {
    // Populate icon & color pickers
    const iconGrid = document.getElementById('conf_mode_icon_grid');
    const colorRow = document.getElementById('conf_mode_color_row');
    const nameEl = document.getElementById('conf_mode_edit_name');
    const idEl = document.getElementById('conf_mode_edit_id');
    const iconEl = document.getElementById('conf_mode_edit_icon');
    const colorEl = document.getElementById('conf_mode_edit_color');
    const promptEl = document.getElementById('conf_mode_edit_prompt');
    const titleEl = document.getElementById('conf_mode_modal_title');

    // Load modes for editing
    try {
        const res = await fetch('/api/conference/modes', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('memini_token') }
        });
        if (res.ok) _confModesCache = await res.json();
    } catch (_) {}

    let mode = null;
    if (editId) {
        mode = _confModesCache.find(m => m.id === editId);
    }

    titleEl.textContent = mode ? `Editează: ${mode.name}` : 'Mod nou';
    idEl.value = editId || '';
    nameEl.value = mode ? mode.name : '';
    nameEl.disabled = !!(mode && mode.builtin);
    promptEl.value = mode ? (mode.prompt || '') : '';

    const selIcon = mode ? mode.icon : 'fa-circle';
    const selColor = mode ? mode.color : '#8b5cf6';
    iconEl.value = selIcon;
    colorEl.value = selColor;

    // Render icon grid
    iconGrid.innerHTML = _MODE_ICONS.map(ic => `
        <button type="button" class="w-8 h-8 rounded-lg flex items-center justify-center border transition-all cursor-pointer
            ${ic === selIcon ? 'border-violet-500 bg-violet-500/20 text-violet-300' : 'border-white/5 bg-slate-800 text-slate-400 hover:border-white/10'}"
            onclick="pickConfModeIcon('${ic}')">
            <i class="fas ${ic} text-xs"></i>
        </button>
    `).join('');

    // Render color row
    colorRow.innerHTML = _MODE_COLORS.map(c => `
        <button type="button" class="w-7 h-7 rounded-full border-2 transition-all cursor-pointer
            ${c === selColor ? 'border-white scale-110' : 'border-transparent hover:border-white/30'}"
            style="background: ${c}"
            onclick="pickConfModeColor('${c}')">
        </button>
    `).join('');

    // Show modal
    const modal = document.getElementById('conf_mode_modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.onclick = (e) => { if (e.target === modal) closeConfModeModal(); };
}

function pickConfModeIcon(icon) {
    document.getElementById('conf_mode_edit_icon').value = icon;
    document.querySelectorAll('#conf_mode_icon_grid button').forEach(btn => {
        const ic = btn.querySelector('i')?.className?.replace('fas ', '') || '';
        if (ic === icon) {
            btn.classList.add('border-violet-500', 'bg-violet-500/20', 'text-violet-300');
            btn.classList.remove('border-white/5', 'bg-slate-800', 'text-slate-400');
        } else {
            btn.classList.remove('border-violet-500', 'bg-violet-500/20', 'text-violet-300');
            btn.classList.add('border-white/5', 'bg-slate-800', 'text-slate-400');
        }
    });
}

function pickConfModeColor(color) {
    document.getElementById('conf_mode_edit_color').value = color;
    document.querySelectorAll('#conf_mode_color_row button').forEach(btn => {
        if (btn.style.background === color || btn.style.backgroundColor === color) {
            btn.classList.add('border-white', 'scale-110');
            btn.classList.remove('border-transparent');
        } else {
            btn.classList.remove('border-white', 'scale-110');
            btn.classList.add('border-transparent');
        }
    });
}

function closeConfModeModal() {
    const modal = document.getElementById('conf_mode_modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function saveConfMode() {
    const idEl = document.getElementById('conf_mode_edit_id');
    const nameEl = document.getElementById('conf_mode_edit_name');
    const iconEl = document.getElementById('conf_mode_edit_icon');
    const colorEl = document.getElementById('conf_mode_edit_color');
    const promptEl = document.getElementById('conf_mode_edit_prompt');

    const editId = idEl.value.trim();
    const name = nameEl.value.trim();
    const icon = iconEl.value;
    const color = colorEl.value;
    const prompt = promptEl.value.trim();

    if (!editId && !name) {
        showToast('Numele modului este obligatoriu', 'warning');
        return;
    }

    const headers = {
        'Authorization': 'Bearer ' + localStorage.getItem('memini_token'),
        'Content-Type': 'application/json'
    };

    try {
        let res;
        const existing = editId ? _confModesCache.find(m => m.id === editId) : null;
        if (existing && existing.builtin) {
            // For built-in modes, just save the prompt via config API
            const modePrompts = {};
            modePrompts[editId] = prompt;
            res = await fetch('/api/config', {
                method: 'PATCH', headers,
                body: JSON.stringify({ conference: { mode_prompts: modePrompts } })
            });
        } else if (editId) {
            res = await fetch(`/api/conference/modes/${editId}`, {
                method: 'PUT', headers,
                body: JSON.stringify({ name, icon, color, prompt })
            });
        } else {
            res = await fetch('/api/conference/modes', {
                method: 'POST', headers,
                body: JSON.stringify({ name, icon, color, prompt })
            });
        }
        if (res.ok) {
            showToast('Mod salvat', 'success');
            closeConfModeModal();
            await renderConfModesList();
        } else {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || 'Eroare la salvare', 'error');
        }
    } catch (e) {
        console.warn('saveConfMode error', e);
        showToast('Eroare la salvare', 'error');
    }
}

async function deleteConfMode(modeId) {
    if (!confirm('Sigur vrei să ștergi acest mod?')) return;
    try {
        const res = await fetch(`/api/conference/modes/${modeId}`, {
            method: 'DELETE',
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('memini_token') }
        });
        if (res.ok) {
            showToast('Mod șters', 'success');
            await renderConfModesList();
        } else {
            showToast('Eroare la ștergere', 'error');
        }
    } catch (e) {
        showToast('Eroare la ștergere', 'error');
    }
}

function toggleConfSettingsVisibility() {
    const enabled = document.getElementById('conf_enabled')?.checked;
    const body = document.getElementById('conf_settings_body');
    if (body) {
        body.style.opacity = enabled ? '1' : '0.35';
        body.style.pointerEvents = enabled ? '' : 'none';
    }
}

window.toggleConfSettingsVisibility = toggleConfSettingsVisibility;
window.resetConferencePrompt = resetConferencePrompt;
window.renderConfModesList = renderConfModesList;
window.openConfModeModal = openConfModeModal;
window.closeConfModeModal = closeConfModeModal;
window.saveConfMode = saveConfMode;
window.deleteConfMode = deleteConfMode;
window.pickConfModeIcon = pickConfModeIcon;
window.pickConfModeColor = pickConfModeColor;
window.requestMicPermission = requestMicPermission;
window.requestLocationPermission = requestLocationPermission;
window.requestCameraPermission = requestCameraPermission;
window.requestStoragePermission = requestStoragePermission;
window.checkPermissions = checkPermissions;
// ─────────────────────────────────────────────────────────────────────

let notificationInterval = null;

async function initializeApp() {
    const profile = await loadUserProfile();
    if (!profile || !profile.username) {
        clearAuthToken();
        document.getElementById('login-overlay')?.classList.remove('hidden');
        return;
    }
    document.getElementById('login-overlay').classList.add('hidden');
    window.__isAdmin = !!profile.is_admin;
    if (profile.is_admin) {
        const navAdmin = document.getElementById('nav-admin');
        if (navAdmin) navAdmin.classList.remove('hidden');
    }
    switchTab('chat');
    try {
        await loadSessionsList();
    } catch (e) {
        console.warn("Sessions list load failed", e);
    }
    try {
        await loadConferenceSettings();
    } catch (e) {
        console.warn("Conference settings load failed", e);
    }
    try {
        startLogStream();
    } catch (e) {
        console.warn("Log stream failed", e);
    }
    if (window.notificationTimer?.stop) window.notificationTimer.stop();
    const unifiedId = `user_${profile.id}`;
    window.notificationTimer = initNotifications(unifiedId);
    // Load model profiles for chat selector
    try { await loadModelProfiles(); } catch (e) { console.warn('Model profiles load failed', e); }



    // Show/hide voice button based on whisper config (without full loadConfig)
    try {
        const cfgRes = await fetch('/api/config', {
            headers: { 'Authorization': 'Bearer ' + localStorage.getItem('memini_token') }
        });
        if (cfgRes.ok) {
            const cfg = await cfgRes.json();
            const voiceBtn = document.getElementById('btn-voice');
            const whisperEl = document.getElementById('whisper_enabled');
            const whisperOn = !!(cfg.whisper && cfg.whisper.enabled);
            if (whisperEl) whisperEl.checked = whisperOn;
            if (voiceBtn) voiceBtn.classList.toggle('hidden', !whisperOn);
        }
    } catch (e) { console.warn('Whisper status check failed', e); }
}

window.addEventListener('DOMContentLoaded', () => {
    // 0. Inițializăm limba UI
    initI18n();
    applyInitialGreeting();

    // 0.1 Sidebar gestures (mobile): swipe right from edge to open,
    // swipe left on sidebar to close.
    initSidebarGestures();

    // 1. Aplicăm tema salvată
    setTheme(getStoredThemeId());
    loadThemeSelector();

    // 1.1 Reveal native-app-only elements if running inside Memini Bridge
    initNativeAppBridge();
    
    // 2. Bind la formularele principale (FastAPI form-data format)
    const loginForm = document.getElementById('login-form');
    if (loginForm) loginForm.onsubmit = handleLogin;

    // 3. Auth: try existing token, then auto-login from saved credentials
    const token = localStorage.getItem('memini_token');
    if (token && token !== "null" && token !== "undefined") {
        initializeApp().catch(async () => {
            clearAuthToken();
            if (await tryAutoLogin()) {
                initializeApp().catch(() => {
                    document.getElementById('login-overlay')?.classList.remove('hidden');
                    restoreRememberedCredentials();
                });
            } else {
                document.getElementById('login-overlay')?.classList.remove('hidden');
                restoreRememberedCredentials();
            }
        });
    } else {
        (async () => {
            if (await tryAutoLogin()) {
                initializeApp().catch(() => {
                    document.getElementById('login-overlay')?.classList.remove('hidden');
                    restoreRememberedCredentials();
                });
            } else {
                document.getElementById('login-overlay')?.classList.remove('hidden');
                restoreRememberedCredentials();
            }
        })();
    }

    // 4. Bind evenimente Chat
    const btnSend = document.getElementById('btn-send');
    if (btnSend) btnSend.onclick = () => {
        if (btnSend.classList.contains('streaming')) stopStreaming();
        else sendMessage();
    };

    const btnAttach = document.getElementById('btn-attach');
    const balloon = document.getElementById('chat-attach-balloon');
    const imageInput = document.getElementById('chat-image-input');
    const cameraInput = document.getElementById('chat-camera-input');
    const documentInput = document.getElementById('chat-document-input');
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
            btnAttach.setAttribute('aria-expanded', !isOpen);
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
            btn.onclick = (e) => {
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
            btn.onclick = (e) => {
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
            btn.onclick = (e) => {
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
            reader.onload = () => { addAttachedImage(reader.result); };
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
            reader.onload = () => { addAttachedImage(reader.result); };
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
                    const token = localStorage.getItem('memini_token') || authToken;
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
                showToast(err.message || t('chat.error_document') || 'Document error', 'error');
            }
            documentInput.value = '';
        };
    }

    const input = document.getElementById('user-input');
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
                    reader.onload = () => { addAttachedImage(reader.result); };
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
        chatWrapper.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
        chatWrapper.addEventListener('drop', (e) => {
            e.preventDefault();
            const file = [...(e.dataTransfer.files || [])].find(f => f.type.startsWith('image/'));
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => { addAttachedImage(reader.result); };
            reader.readAsDataURL(file);
        });
    }

    const _onKeyboardChange = (kbHeight) => {
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
            const username = document.getElementById('admin-username')?.value?.trim();
            const password = document.getElementById('admin-password')?.value || '';
            const fullName = document.getElementById('admin-full-name')?.value?.trim();
            if (!username || !password) return;
            try {
                await createUser(username, password, fullName);
                document.getElementById('admin-username').value = '';
                document.getElementById('admin-password').value = '';
                document.getElementById('admin-full-name').value = '';
                await loadAdminUsers();
                showToast(t('admin.created'), 'success');
            } catch (err) {
                showToast(err.message || t('admin.error_create'), 'error');
            }
        };
    }
});

// --- EXPORTURI GLOBALE (Pentru acces din onclick/onkeyup în HTML) ---
window.setTheme = setTheme;
window.switchTab = switchTab;
window.switchConfigTab = switchConfigTab;
window.openConfigSection = openConfigSection;
window.closeConfigSection = closeConfigSection;
window.toggleSidebar = toggleSidebar;
window.saveConfig = saveConfig;
window.restartServer = restartServer;
window.saveNotificationSettings = saveNotificationSettings;
window.loadNotificationPrefs = loadNotificationPrefs;
window.selectNotifTransport = selectNotifTransport;
window.selectNotifChannel = selectNotifChannel;
window.testWsNotification = testWsNotification;
window.testFcmNotification = testFcmNotification;
window.testNotification = testNotification;
window.refreshNotifWsNativeStatus = refreshNotifWsNativeStatus;
window.syncHA = syncHA;
window.toggleDevice = toggleDevice;
window.toggleSelection = toggleSelection;
window.toggleAllAI = toggleAllAI;
window.loadMemory = loadMemory;
window.filterDevices = debounce(filterDevices, 200);
window.changeMemPage = changeMemPage;
window.deleteMemBulk = deleteMemBulk;
window.filterMemory = debounce(filterMemory, 200);
window.toggleAllHA = toggleAllHA;
window.updateHABulkCount = updateHABulkCount;
window.deleteHABulk = deleteHABulk;
window.toggleHABulkMode = toggleHABulkMode;
window.deleteHASingle = deleteHASingle;
window.saveAliases = saveAliases;
window.filterHAByDomain = filterHAByDomain;
window.openAliasModal = openAliasModal;
window.addAliasInput = addAliasInput;
window.closeAliasModal = closeAliasModal;
window.saveAliasesFromModal = saveAliasesFromModal;
window.openRowActionsModal = openRowActionsModal;
window.closeRowActionsModal = closeRowActionsModal;
window.handleHaRowClick = handleHaRowClick;
window.openAddDevicesModal = openAddDevicesModal;
window.closeAddDevicesModal = closeAddDevicesModal;
window.confirmAddDevices = confirmAddDevices;
window.toggleAvailableDevice = toggleAvailableDevice;
window.toggleAllAvailableDevices = toggleAllAvailableDevices;
window.filterAvailableDevices = debounce(filterAvailableDevices, 200);
window.toggleAllMem = toggleAllMem;
window.updateMemBulkCount = updateMemBulkCount;
window.loadPlanner = loadPlanner;
window.plannerCreateList = plannerCreateList;
window.plannerDeleteList = plannerDeleteList;
window.plannerSelectList = plannerSelectList;
window.plannerOpenDrawer = plannerOpenDrawer;
window.plannerCloseDrawer = plannerCloseDrawer;
window.plannerSetTab = plannerSetTab;
window.plannerSetFilter = plannerSetFilter;
window.plannerCalPrev = plannerCalPrev;
window.plannerCalNext = plannerCalNext;
window.plannerCalToday = plannerCalToday;
window.plannerSetCalView = plannerSetCalView;
window.plannerSelectDay = plannerSelectDay;
window.plannerCalClickDay = plannerCalClickDay;
window.plannerCalClickHour = plannerCalClickHour;
window.plannerEventDragStart = plannerEventDragStart;
window.plannerEventDragOver = plannerEventDragOver;
window.plannerEventDragEnd = plannerEventDragEnd;
window.plannerEventDropDay = plannerEventDropDay;
window.plannerEventDropHour = plannerEventDropHour;
window.plannerCreateEntry = plannerCreateEntry;
window.plannerOpenAdd = plannerOpenAdd;
window.plannerCloseAdd = plannerCloseAdd;
window.plannerToggleDone = plannerToggleDone;
window.plannerDeleteEntry = plannerDeleteEntry;
window.plannerCycleType = plannerCycleType;
window.plannerEntryActions = plannerEntryActions;
window.plannerDragStart = plannerDragStart;
window.plannerDragOver = plannerDragOver;
window.plannerDrop = plannerDrop;
window.plannerDragEnd = plannerDragEnd;

window.loadMemoryEvents = loadMemoryEvents;
window.memLogPrevPage = memLogPrevPage;
window.memLogNextPage = memLogNextPage;
window.toggleMemLogDetails = toggleMemLogDetails;
window.clearMemoryLog = clearMemoryLog;
window.runConsolidationNow = runConsolidationNow;
window.addExtractionExample = addExtractionExample;
window.removeExtractionExample = removeExtractionExample;
window.switchIntelligenceTab = switchIntelligenceTab;
// Automation editor
window.loadAutomations = loadAutomations;
window.deleteAutomation = deleteAutomation;
window.openAutomationEditor = openAutomationEditor;
window.closeAutomationEditor = closeAutomationEditor;
window.saveAutomationEditor = saveAutomationEditor;
window.validateAutomationEditor = validateAutomationEditor;
window.toggleAutomationDefinition = toggleAutomationDefinition;
window.runAutomationDefinition = runAutomationDefinition;
window.switchAutomationEditorMode = switchAutomationEditorMode;
window.addAutomationBuilderAction = addAutomationBuilderAction;
window.removeAutomationBuilderAction = removeAutomationBuilderAction;
window.addAutomationBuilderTrigger = addAutomationBuilderTrigger;
window.removeAutomationBuilderTrigger = removeAutomationBuilderTrigger;
window.addAutomationBuilderCondition = addAutomationBuilderCondition;
window.removeAutomationBuilderCondition = removeAutomationBuilderCondition;
window.syncAutomationYamlFromBuilder = syncAutomationYamlFromBuilder;
window.syncAutomationBuilderFromYaml = syncAutomationBuilderFromYaml;
window.loadAutomationEditorHistory = loadAutomationEditorHistory;
window.refreshAutomationEntityOptions = refreshAutomationEntityOptions;
// doLogout e deja pe window (definit la început)
// Multi-chat: expunem în window acțiunile pentru sesiuni
window.newChatSession = newChatSession;
window.openSession = openSession;
window.deleteSession = deleteSession;
window.confirmDeleteSession = confirmDeleteSession;
window.cancelDeleteSession = cancelDeleteSession;
window.clearSessionContext = clearSessionContext;
window.copyWebhook = copyWebhook;
window.openIntegrationConfigModal = openIntegrationConfigModal;
window.closeIntegrationConfigModal = closeIntegrationConfigModal;
window.copyAssistOllamaUserUrl = copyAssistOllamaUserUrl;
window.copyAssistKey = copyAssistKey;
window.regenerateAssistKey = regenerateAssistKey;
window.deleteUser = deleteUser;
window.unlinkUserPhone = unlinkUserPhone;
window.loadSkills = loadSkills;
window.openSkillEdit = openSkillEdit;
window.loadConferenceSettings = loadConferenceSettings;
window.saveConferenceSettings = saveConferenceSettings;
window.closeSkillEditModal = closeSkillEditModal;
window.saveSkillEdit = saveSkillEdit;
window.deleteSkill = deleteSkill;
window.toggleSkillDesc = toggleSkillDesc;
window.toggleSkillDisabled = toggleSkillDisabled;
window.loadApps = loadApps;
window.appAction = appAction;
window.openAppLogModal = openAppLogModal;
window.closeAppLogModal = closeAppLogModal;
window.refreshAppLogs = refreshAppLogs;
window.openAppDetail = openAppDetail;
window.closeAppDetail = closeAppDetail;
window.installApp = installApp;
window.uninstallApp = uninstallApp;
window.toggleApp = toggleApp;
window.closeInstallLogModal = closeInstallLogModal;
window.runPreflight = runPreflight;