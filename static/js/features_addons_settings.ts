/**
 * Settings → Add-ons list + Updates hub (install/enable/update add-ons).
 */
export {
    loadAddons,
    installAddon,
    uninstallAddon,
    toggleAddon,
    openAddonConfigModal,
    closeAddonConfigModal,
    saveAddonConfig,
    checkAddonHealth,
} from './addons_settings/list.js';

export {
    updateHeaderUpdatesBadge,
    refreshUpdatesHeaderBadge,
    loadUpdatesAddons,
    checkAddonUpdates,
    applyHyveUpdate,
    updateAllAddons,
    updateSingleAddon,
    toggleUpdatesIntervalDropdown,
    setUpdatesInterval,
    syncUpdatesIntervalDropdown,
} from './addons_settings/updates.js';

export {
    loadBackupPanel,
    createBackup,
    verifyBackup,
    restoreBackup,
    rollbackBackup,
    saveBackupSettings,
    deleteBackupArchive,
    setBackupScheduleInterval,
    syncBackupScheduleDropdown,
    testBackupRemote,
    loadRemoteBackupArchives,
    pullRemoteBackup,
    restoreRemoteBackup,
} from './addons_settings/backup.js';
