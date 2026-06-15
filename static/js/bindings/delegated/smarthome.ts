/** Delegated bindings — smarthome. */

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

export function initSmarthomeDelegatedBindings(): void {
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
}
