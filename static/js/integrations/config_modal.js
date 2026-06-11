/**
 * Integration config modal — catalog metadata + schema-driven config entries.
 */
import { openSubPage, closeSubPage } from '../utils.js';
import { integrationDefinition, integrationCatalogSlug, integrationLabel, integrationDescription, normalizeIntegrationIcon, supportsIntegrationEntitySync, } from './catalog_meta.js';
import { loadIntegrationCatalog, syncConfiguredIntegration } from './catalog.js';
import { loadIntegrationExposedEntities } from './exposed_devices.js';
import { loadIntegrationConfigEntries, integrationHasConfigSchema } from './config_entries.js';
export function slugForId(s) {
    if (!s || typeof s !== 'string')
        return '';
    return s.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || '';
}
function integrationIconClass(meta) {
    const raw = normalizeIntegrationIcon(meta?.icon || 'fa-plug');
    return raw.includes(' ') ? raw : `fas ${raw}`;
}
function _showGenericPanel(meta, catalogSlug) {
    const generic = document.getElementById('integration-panel-generic');
    if (!generic)
        return;
    generic.classList.remove('hidden');
    const descEl = document.getElementById('integration-generic-description');
    if (descEl) {
        const desc = integrationDescription(meta);
        descEl.textContent = desc;
        descEl.classList.toggle('hidden', !desc);
    }
    const syncBtn = document.getElementById('integration-generic-sync-btn');
    if (syncBtn) {
        const supportsSync = !!meta?.supports_sync;
        syncBtn.classList.toggle('hidden', !supportsSync);
        if (supportsSync) {
            syncBtn.classList.add('flex');
            syncBtn.onclick = async () => {
                await syncConfiguredIntegration(catalogSlug, syncBtn);
                try {
                    await loadIntegrationExposedEntities(catalogSlug);
                }
                catch (_) { }
            };
        }
        else {
            syncBtn.classList.remove('flex');
            syncBtn.onclick = null;
        }
    }
}
export async function openIntegrationConfigModal(integrationId) {
    const modal = document.getElementById('integration-config-modal');
    const titleEl = document.getElementById('integration-config-modal-title');
    const iconEl = document.getElementById('integration-config-modal-icon');
    const logoEl = document.getElementById('integration-config-modal-logo');
    if (!modal || !titleEl)
        return;
    const generic = document.getElementById('integration-panel-generic');
    if (generic)
        generic.classList.add('hidden');
    const exposedSection = document.getElementById('integration-exposed-entities-section');
    if (exposedSection)
        exposedSection.classList.add('hidden');
    const entriesSection = document.getElementById('integration-entries-section');
    if (entriesSection)
        entriesSection.classList.add('hidden');
    try {
        await loadIntegrationCatalog(false);
    }
    catch (_) { }
    const meta = integrationDefinition(integrationId) || null;
    const catalogSlug = integrationCatalogSlug(integrationId);
    const resolvedTitle = integrationLabel(meta) || integrationId;
    const icon = integrationIconClass(meta);
    const logo = String(meta?.image || '').trim();
    titleEl.textContent = resolvedTitle;
    if (logoEl) {
        logoEl.classList.toggle('hidden', !logo);
        logoEl.style.display = logo ? '' : 'none';
        logoEl.src = logo || '';
        logoEl.alt = logo ? resolvedTitle : '';
        logoEl.onerror = () => {
            logoEl.classList.add('hidden');
            logoEl.style.display = 'none';
            if (iconEl)
                iconEl.classList.remove('hidden');
            if (iconEl)
                iconEl.style.display = '';
        };
    }
    if (iconEl) {
        iconEl.className = icon;
        iconEl.classList.toggle('hidden', !!logo);
        iconEl.style.display = logo ? 'none' : '';
    }
    openSubPage('integration-config-modal');
    if (integrationHasConfigSchema(catalogSlug)) {
        try {
            await loadIntegrationConfigEntries(catalogSlug);
        }
        catch (_) { }
    }
    else {
        _showGenericPanel(meta, catalogSlug);
    }
    if (supportsIntegrationEntitySync(catalogSlug)) {
        try {
            await loadIntegrationExposedEntities(catalogSlug);
        }
        catch (_) { }
    }
}
export function closeIntegrationConfigModal() {
    closeSubPage('integration-config-modal');
}
