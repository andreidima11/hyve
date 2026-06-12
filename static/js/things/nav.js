/**
 * Navigation context when opening device/entity detail from outside Devices tab.
 */
import { switchTab, openConfigSection } from '../nav_bridge.js';
import { openIntegrationConfigModal } from '../integrations/config_modal.js';
let _returnTo = null;
export function getThingsReturnContext() {
    return _returnTo;
}
export function setThingsReturnContext(ctx) {
    _returnTo = ctx;
}
export function clearThingsReturnContext() {
    _returnTo = null;
}
/** Restore the view the user came from (e.g. Integrations config). Returns true if handled. */
export async function restoreThingsReturnContext() {
    const ctx = _returnTo;
    clearThingsReturnContext();
    if (!ctx || ctx.kind !== 'integrations')
        return false;
    switchTab('config');
    openConfigSection('integrations');
    await openIntegrationConfigModal(ctx.integrationId);
    return true;
}
