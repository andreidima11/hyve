/** Delegated bindings — memory. */

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

const debouncedFilterMemory = debounce(() => filterMemory(), 200);

export function initMemoryDelegatedBindings(): void {
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
    syncAutomationYamlFromBuilder: (opts) => syncAutomationYamlFromBuilder((opts || {}) as import('../../types/features_automations.js').SyncAutomationOptions),
    updateBlueprintCreatorYaml: () => updateBlueprintCreatorYaml(),
    updateMemBulkCount: () => updateMemBulkCount(),
});
}
