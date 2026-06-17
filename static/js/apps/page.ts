/**
 * Apps page facade.
 */
export { loadApps, openAppDetail, closeAppDetail, resetAppsDetailView, appAction } from './core.js';
export { openAppLogModal, closeAppLogModal, refreshAppLogs } from './logs.js';
export {
    runPreflight,
    installApp,
    closeInstallLogModal,
    goToAddonUpdates,
    uninstallApp,
    toggleApp,
    toggleAddonWatchdog,
    detectAddonSerialPorts,
    saveAddonConfig,
    testAddonHealth,
    closeAddonWebUI,
    openAddonWebUI,
} from './lifecycle.js';
