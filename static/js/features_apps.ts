/**
 * Apps page facade (addon process management + lifecycle).
 */
export {
    loadApps,
    openAppDetail,
    closeAppDetail,
    appAction,
    openAppLogModal,
    closeAppLogModal,
    refreshAppLogs,
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
} from './apps/page.js';
