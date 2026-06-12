/**
 * Navigation context when opening device/entity detail from outside Devices tab.
 */
import { switchTab, openConfigSection } from '../nav_bridge.js';
import { openIntegrationConfigModal } from '../integrations/config_modal.js';

export type ThingsReturnContext = {
    kind: 'integrations';
    integrationId: string;
    catalogSlug: string;
};

let _returnTo: ThingsReturnContext | null = null;

export function getThingsReturnContext(): ThingsReturnContext | null {
    return _returnTo;
}

export function setThingsReturnContext(ctx: ThingsReturnContext | null): void {
    _returnTo = ctx;
}

export function clearThingsReturnContext(): void {
    _returnTo = null;
}

/** Restore the view the user came from (e.g. Integrations config). Returns true if handled. */
export async function restoreThingsReturnContext(): Promise<boolean> {
    const ctx = _returnTo;
    clearThingsReturnContext();
    if (!ctx || ctx.kind !== 'integrations') return false;

    switchTab('config');
    openConfigSection('integrations');
    await openIntegrationConfigModal(ctx.integrationId);
    return true;
}
