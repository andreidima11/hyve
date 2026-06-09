// @ts-nocheck — Phase 5 TS shell; tighten types incrementally.
/**
 * Config hub / settings event delegation.
 */
/** @type {Record<string, (...args: unknown[]) => unknown> | null} */
let _handlers = null;
let _bound = false;
function _inConfigScope(el) {
    return !!el?.closest('#view-config');
}
function _run(action, el, event) {
    if (!_handlers)
        return;
    if (action === 'closeAddonWebUI') {
        _handlers.closeAddonWebUI?.(event, el);
        return;
    }
    if (!_inConfigScope(el))
        return;
    if (el.dataset.configBackdropDismiss === 'true' && event.target !== el)
        return;
    switch (action) {
        case 'openSection':
            _handlers.openSection?.(el.dataset.configSection || '', event, el);
            return;
        case 'switchTab':
            _handlers.switchTab?.(el.dataset.configTab || '', event, el);
            return;
        case 'switchIntegrationSubtab':
            _handlers.switchIntegrationSubtab?.(el.dataset.configSubtab || '', event, el);
            return;
        case 'selectNotifChannel':
            _handlers.selectNotifChannel?.(el.dataset.configChannel || '', event, el);
            return;
        case 'selectNotifTransport':
            _handlers.selectNotifTransport?.(el.dataset.configTransport || '', event, el);
            return;
        case 'closeIntegrationEntryModal':
            document.getElementById('integration-entry-modal')?.classList.add('hidden');
            return;
        case 'syncConfiguredIntegration':
            _handlers.syncConfiguredIntegration?.(el.dataset.configSlug || '', el, event);
            return;
        case 'openIntegrationConfigModal':
            _handlers.openIntegrationConfigModal?.(el.dataset.configSlug || '', event, el);
            return;
        case 'syncIntegrationEntities':
            _handlers.syncIntegrationEntities?.(el.dataset.configSlug || '', event, el);
            return;
        case 'navigateToSmartHomeSource':
            _handlers.navigateToSmartHomeSource?.(el.dataset.configSlug || '', event, el);
            return;
        case 'openSmarthomeTab':
            _handlers.openSmarthomeTab?.(event, el);
            return;
        case 'unlinkUserPhone':
            _handlers.unlinkUserPhone?.(el.dataset.configPhone || '', event, el);
            return;
        case 'moveProfileOrder':
            event.stopPropagation();
            _handlers.moveProfileOrder?.(el.dataset.configProfileId || '', el.dataset.configDirection || '', event, el);
            return;
        case 'openProfileCardMenu':
            _handlers.openProfileCardMenu?.(el.dataset.configProfileId || '', event, el);
            return;
        case 'openAddonConfigModal':
            _handlers.openAddonConfigModal?.(el.dataset.configSlug || '', event, el);
            return;
        case 'toggleAddon':
            _handlers.toggleAddon?.(el.dataset.configSlug || '', el.dataset.configEnabled === 'true', event, el);
            return;
        case 'uninstallAddon':
            _handlers.uninstallAddon?.(el.dataset.configSlug || '', event, el);
            return;
        case 'installAddon':
            _handlers.installAddon?.(el.dataset.configSlug || '', event, el);
            return;
        case 'updateSingleAddon':
            _handlers.updateSingleAddon?.(el.dataset.configSlug || '', event, el);
            return;
        case 'deleteUser':
            _handlers.deleteUser?.(Number(el.dataset.configUserId || 0), event, el);
            return;
        case 'deleteArea':
            _handlers.deleteArea?.(el.dataset.configAreaId || '', event, el);
            return;
        case 'editArea':
            _handlers.editArea?.(el.dataset.configAreaId || '', event, el);
            return;
        case 'removeAreaEditorEntity':
            _handlers.removeAreaEditorEntity?.(el.dataset.configEntityId || '', event, el);
            return;
        case 'toggleAreaPickerEntity':
            _handlers.toggleAreaPickerEntity?.(el.dataset.configEntityId || '', el.checked, event, el);
            return;
        case 'openSceneEntityPicker':
            _handlers.openSceneEntityPicker?.(Number(el.dataset.configIndex ?? -1), event, el);
            return;
        case 'removeSceneEntry':
            _handlers.removeSceneEntry?.(Number(el.dataset.configIndex ?? -1), event, el);
            return;
        case 'openSceneEditor': {
            const sceneId = el.dataset.configSceneId || '';
            _handlers.openSceneEditor?.(sceneId || undefined, event, el);
            return;
        }
        case 'activateScene':
            _handlers.activateScene?.(el.dataset.configSceneId || '', event, el);
            return;
        case 'deleteScene':
            _handlers.deleteScene?.(el.dataset.configSceneId || '', event, el);
            return;
        case 'pickSceneEntity':
            _handlers.pickSceneEntity?.(el.dataset.configEntityId || '', event, el);
            return;
        case 'detectAddonSerialPorts':
            _handlers.detectAddonSerialPorts?.(el.dataset.configKey || '', event, el);
            return;
        case 'openAppDetail':
            _handlers.openAppDetail?.(el.dataset.configSlug || '', event, el);
            return;
        case 'runPreflight':
            _handlers.runPreflight?.(el.dataset.configSlug || '', event, el);
            return;
        case 'installApp':
            _handlers.installApp?.(el.dataset.configSlug || '', event, el);
            return;
        case 'toggleApp':
            _handlers.toggleApp?.(el.dataset.configSlug || '', el.dataset.configEnabled === 'true', event, el);
            return;
        case 'goToAddonUpdates':
            _handlers.goToAddonUpdates?.(event, el);
            return;
        case 'uninstallApp':
            _handlers.uninstallApp?.(el.dataset.configSlug || '', event, el);
            return;
        case 'closeAppDetail':
            _handlers.closeAppDetail?.(event, el);
            return;
        case 'appAction':
            _handlers.appAction?.(el.dataset.configSlug || '', el.dataset.configAppAction || '', event, el);
            return;
        case 'openAppLogModal':
            _handlers.openAppLogModal?.(el.dataset.configSlug || '', el.dataset.configAppName || '', event, el);
            return;
        case 'copyPreflightFix':
            _handlers.copyPreflightFix?.(el.dataset.configCopyText || '', event, el);
            return;
        case 'openAddonWebUI':
            _handlers.openAddonWebUI?.(el.dataset.configSlug || '', event, el);
            return;
        case 'closeAddonWebUI':
            _handlers.closeAddonWebUI?.(event, el);
            return;
        case 'testAddonHealth':
            _handlers.testAddonHealth?.(el.dataset.configSlug || '', event, el);
            return;
        case 'saveAddonConfig':
            _handlers.saveAddonConfig?.(el.dataset.configSlug || '', event, el);
            return;
        case 'setTheme':
            _handlers.setTheme?.(el.dataset.configThemeId || '', event, el);
            return;
        case 'saveConfig':
            _handlers.saveConfig?.(event, el);
            return;
        default: {
            const fn = _handlers[action];
            if (typeof fn === 'function')
                fn(event, el);
        }
    }
}
function _onClick(event) {
    const el = event.target.closest('[data-config-action]');
    if (!el)
        return;
    _run(el.dataset.configAction, el, event);
}
function _onInput(event) {
    const el = event.target.closest('[data-config-input]');
    if (!el || !_inConfigScope(el))
        return;
    const kind = el.dataset.configInput;
    if (!kind || !_handlers)
        return;
    if (kind === 'filterSceneEntityPicker')
        _handlers.filterSceneEntityPicker?.(event, el);
    else if (kind === 'filterAreaEntityPicker')
        _handlers.filterAreaEntityPicker?.(el.value, event, el);
}
function _onChange(event) {
    const el = event.target.closest('[data-config-input]');
    if (!el || !_inConfigScope(el))
        return;
    const kind = el.dataset.configInput;
    if (!kind || !_handlers)
        return;
    if (kind === 'onProfileProviderChange')
        _handlers.onProfileProviderChange?.(event, el);
    else if (kind === 'onProfileSubProviderChange') {
        _handlers.onProfileSubProviderChange?.(el.dataset.configProfileType || '', event, el);
    }
    else if (kind === 'toggleProfileSection') {
        const targetId = el.dataset.configTarget || '';
        if (targetId)
            document.getElementById(targetId)?.classList.toggle('hidden', !el.checked);
        if (el.id === 'profile-vision-enabled')
            _handlers.syncVisionCapabilityCheckbox?.(event, el);
    }
    else if (kind === 'uploadComfyUIWorkflow')
        _handlers.uploadComfyUIWorkflow?.(el, event);
    else if (kind === 'toggleAreaPickerEntity') {
        _handlers.toggleAreaPickerEntity?.(el.dataset.configEntityId || '', el.checked, event, el);
    }
    else if (kind === 'toggleAddonWatchdog') {
        _handlers.toggleAddonWatchdog?.(el.dataset.configSlug || '', el.checked, event, el);
    }
}
/**
 * @param {Record<string, (...args: unknown[]) => unknown>} handlers
 */
export function initConfigEventBindings(handlers) {
    _handlers = handlers || {};
    if (_bound)
        return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
    document.addEventListener('input', _onInput, false);
    document.addEventListener('change', _onChange, false);
}
