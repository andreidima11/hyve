/**
 * Smart home modals — facade.
 */
export {
    openAliasModal,
    addAliasInput,
    closeAliasModal,
    saveAliasesFromModal,
    saveAliases,
} from './modal_alias.js';

export {
    handleHaRowClick,
    openRowActionsModal,
    controlDeviceEntity,
    openAliasModalFromDetail,
    closeEntityDetailModal,
    closeRowActionsModal,
} from './modal_detail.js';

export {
    openAddDevicesModal,
    closeAddDevicesModal,
    toggleAvailableDevice,
    toggleAllAvailableDevices,
    filterAvailableDevices,
    confirmAddDevices,
} from './modal_add_devices.js';
