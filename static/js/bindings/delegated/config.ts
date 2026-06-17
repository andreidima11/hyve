/** Delegated bindings — config. */

/** Delegated event bindings — maps data-action handlers to feature modules. */
import { authToken, clearAuthToken, suppressLogout } from '../../api.js';
import { showToast, debounce, showConfirm, showSourcesModal } from '../../utils.js';
import { handleLogin, loadUserProfile, restoreRememberedCredentials, tryAutoLogin } from '../../auth.js';
import { initSetupWizard, showSetupWizard, fetchSetupStatus } from '../../setup.js';
import { setTheme, loadThemeSelector, toggleSidebar, closeSidebar, isSidebarOpen, switchTab, switchConfigTab, openConfigSection, closeConfigSection, navigateConfigBack, startLogStream, initSidebarGestures, getStoredThemeId } from '../../ui.js';
import { initI18n, setLanguage, t, loadComponentTranslations } from '../../lang/index.js';
import { applyDashboardEditAccess } from '../../dashboard/edit_access.js';
import { sendMessage, stopStreaming, currentSessionId, addAttachedImage, addAttachedDocument, applyInitialGreeting, handleSlashInput, handleSlashKeydown } from '../../chat.js';
import { initThinkingModeSelector, setThinkingMode } from '../../thinking_mode.js';
import { initChatEventBindings } from '../../chat/event_bindings.js';
import { initPlannerEventBindings } from '../../planner/event_bindings.js';
import { initUserEventBindings } from '../../user/event_bindings.js';
import { initSkillsEventBindings } from '../../skills/event_bindings.js';
import { initConfigEventBindings } from '../../config/event_bindings.js';
import { initMemoryEventBindings } from '../../memory/event_bindings.js';
import { initSmarthomeEventBindings } from '../../smarthome/event_bindings.js';
import { initShellEventBindings } from '../../shell/event_bindings.js';
import { initIntegrationEventBindings } from '../../integrations/event_bindings.js';
import { toggleModelSelector, closeModelSelector } from '../../chat/model_selector.js';
import { setUserProfileContext, loadUserProfilePage, switchUserProfileTab, saveUserProfileGeneral, saveUserProfileSecurity } from '../../user_profile.js';
import { initNotifications, loadUserNotifications, switchUserNotificationFilter, toggleUserNotificationFilterMenu, markUserNotificationRead, archiveUserNotification, deleteUserNotification, clearAllUserNotifications, changeUserNotificationsPage, loadNotificationCounts, updateNotificationBadge, navigateNotification } from '../../notifications.js';
import { startStartupStatusPolling, showHubStartupLoadingAfterRestart } from '../../startup_status.js';
import { completeBootProgress, refreshBootProgress, resetBootProgress } from '../../boot_progress.js';
import { importWithCacheBust } from '../../asset_version.js';
import { setIsAdmin, setNotificationTimer } from '../../user_context.js';
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
} from '../../features_config.js';
import {
    switchIntegrationSubtab,
    syncConfiguredIntegration,
    syncIntegrationEntities,
    navigateToSmartHomeSource,
    controlIntegrationEntity,
    openIntegrationEntityCard,
    openIntegrationDeviceModal,
    renameIntegrationDevice,
} from '../../features_integrations_settings.js';
// Expose sendMessage globally so other modules (e.g. voice input in features.js) can call it
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
    switchMemorySubtab,     checkAddonUpdates, applyHyveUpdate, showUpdateReleaseNotes, hideUpdateReleaseNotes, updateAllAddons, updateSingleAddon, closeAddonConfigModal, refreshUpdatesHeaderBadge, checkAddonHealth,
    loadBackupPanel, createBackup, verifyBackup, restoreBackup, rollbackBackup,
    saveBackupSettings, deleteBackupArchive, testBackupRemote,
    loadRemoteBackupArchives, pullRemoteBackup, restoreRemoteBackup,
    downloadBackupArchive, pickBackupUpload, uploadBackupArchive,
    showBackupEncryptionKey, downloadBackupEncryptionKey, downloadBackupEncryptionKeyFromModal,
    copyBackupEncryptionKey, hideBackupEncryptionKeyModal,
    installAddon, uninstallAddon, toggleAddon, openAddonConfigModal, saveAddonConfig as saveAddonConfigModal,
} from '../../features.js';
import {
    loadDashboard,
    initDashboardSidebarNav,
    withDashboardTimeout,
} from '../../dashboard.js';
import type { ConfigFormElement } from '../../types/features_config.js';
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
} from '../../types/app.js';
import type { UserProfileResponse } from '../../types/dashboard.js';
import type { DelegatedEventHandlers } from '../../types/integration.js';
import {
    _appEl,
    _errMsg,
    _lazyAction,
    _loadAppsModule,
    _loadAreasModule,
    _loadDerivedModule,
    _loadPlannerModule,
    _loadScenesModule,
    _num,
    _str,
    clearAppCache,
    detectAppWifi,
    populateAppTab,
    doLogout,
    requestCameraPermission,
    requestLocationPermission,
    requestMicPermission,
    requestStoragePermission,
    toggleAppBiometric,
} from '../../boot/index.js';

export function initConfigDelegatedBindings(): void {
initConfigEventBindings({
    saveConfig: (event) => saveConfig(event as import('../../types/features_config.js').SaveConfigOptions | Event),
    setTheme: (themeId) => setTheme(_str(themeId)),
    openSection: (section) => openConfigSection(_str(section)),
    closeSection: () => navigateConfigBack(),
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
    refreshAppTab: () => populateAppTab(),
    refreshIntegrationsSettings: () => refreshIntegrationsSettingsView('auto'),
    loadApps: _lazyAction(_loadAppsModule, 'loadApps'),
    loadScenes: _lazyAction(_loadScenesModule, 'loadScenes'),
    loadAreas: _lazyAction(_loadAreasModule, 'loadAreas'),
    loadAdminUsers: () => loadAdminUsers(),
    toggleAppBiometric: () => toggleAppBiometric(),
    requestMicPermission: () => requestMicPermission(),
    requestCameraPermission: () => requestCameraPermission(),
    requestLocationPermission: () => requestLocationPermission(),
    requestStoragePermission: () => requestStoragePermission(),
    clearAppCache: () => clearAppCache(),
    checkAddonUpdates: () => checkAddonUpdates(),
    loadBackupPanel: () => loadBackupPanel(),
    refreshLogs: () => startLogStream(),
    applyHyveUpdate: () => applyHyveUpdate(),
    showUpdateReleaseNotes: (target) => showUpdateReleaseNotes(_str(target) || 'hyve'),
    closeUpdateReleaseNotes: () => hideUpdateReleaseNotes(),
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
    showBackupEncryptionKey: () => showBackupEncryptionKey(),
    downloadBackupEncryptionKey: () => downloadBackupEncryptionKey(),
    downloadBackupEncryptionKeyFromModal: () => downloadBackupEncryptionKeyFromModal(),
    copyBackupEncryptionKey: () => copyBackupEncryptionKey(),
    closeBackupEncryptionKeyModal: () => hideBackupEncryptionKeyModal(),
    closeAddonConfigModal: () => closeAddonConfigModal(),
    checkAddonHealth: () => checkAddonHealth(),
    copyWebhook: () => copyWebhook(),
    closeIntegrationConfigModal: () => closeIntegrationConfigModal(),
    testWhisperConnection: () => testWhisperConnection(),
    testPiperConnection: () => testPiperConnection(),
    closeAppLogModal: _lazyAction(_loadAppsModule, 'closeAppLogModal'),
    refreshAppLogs: _lazyAction(_loadAppsModule, 'refreshAppLogs'),
    closeInstallLogModal: _lazyAction(_loadAppsModule, 'closeInstallLogModal'),
    openSceneEditor: (sceneId) => _lazyAction(_loadScenesModule, 'openSceneEditor')(sceneId ? _str(sceneId) : null),
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
        const modalOpen = !!modal?.classList.contains('open');
        if (modalOpen) return saveAddonConfigModal();
        if (s) return _lazyAction(_loadAppsModule, 'saveAddonConfig')(s);
        return saveAddonConfigModal();
    },
    copyPreflightFix: (text) => { const s = _str(text); if (s) navigator.clipboard.writeText(s).catch(() => {}); },
    toggleAddonWatchdog: (slug, enabled) => _lazyAction(_loadAppsModule, 'toggleAddonWatchdog')(slug, enabled),
});

const debouncedFilterMemory = debounce(() => filterMemory(), 200);
}
