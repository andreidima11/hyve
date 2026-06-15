/** Delegated bindings — user. */

/** Delegated event bindings — maps data-action handlers to feature modules. */
import { authToken, clearAuthToken, suppressLogout } from '../../api.js';
import { showToast, debounce, showConfirm, showSourcesModal } from '../../utils.js';
import { handleLogin, loadUserProfile, restoreRememberedCredentials, tryAutoLogin } from '../../auth.js';
import { initSetupWizard, showSetupWizard, fetchSetupStatus } from '../../setup.js';
import { setTheme, loadThemeSelector, toggleSidebar, closeSidebar, isSidebarOpen, switchTab, switchConfigTab, openConfigSection, closeConfigSection, startLogStream, initSidebarGestures, getStoredThemeId } from '../../ui.js';
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
    doLogout,
    requestCameraPermission,
    requestLocationPermission,
    requestMicPermission,
    requestStoragePermission,
    toggleAppBiometric,
} from '../../boot/index.js';

export function initUserDelegatedBindings(): void {
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
}
