/**
 * Integration catalog state and slug/definition lookups.
 */
import type { IntegrationCatalogEntry } from '../types/features_integrations_settings.js';
import { t } from '../lang/index.js';

let _integrationCatalog: IntegrationCatalogEntry[] = [];

export function getIntegrationCatalog(): IntegrationCatalogEntry[] {
    return _integrationCatalog;
}

export function setIntegrationCatalog(entries: IntegrationCatalogEntry[]): void {
    _integrationCatalog = entries;
}

export function updateIntegrationCatalogEnabled(slug: string, enabled: boolean): void {
    const row = _integrationCatalog.find((entry) => String(entry.slug || '') === slug);
    if (row) row.enabled = !!enabled;
}

export function normalizeIntegrationIcon(icon: unknown): string {
    const raw = String(icon || '').trim();
    if (!raw) return 'fa-plug';
    if (raw.includes(' ')) return raw; // already a full FontAwesome class string
    if (raw.startsWith('fa-')) return raw;
    return `fa-${raw}`;
}

export function integrationCatalogSlug(integrationId: string) {
    const def = integrationDefinition(integrationId);
    return String(def?.slug || integrationId || '').trim();
}

export function integrationEntitySourceSlug(integrationId: string) {
    return integrationCatalogSlug(integrationId);
}

export function integrationIdForSourceSlug(sourceSlug: string) {
    const target = String(sourceSlug || '').trim();
    if (!target) return '';
    const hit = _integrationCatalog.find((entry) => {
        const slug = String(entry.slug || '').trim();
        const configKey = String(entry.config_key || slug).trim();
        return slug === target || configKey === target;
    });
    return String(hit?.slug || hit?.config_key || target).trim();
}

export function integrationDefinition(integrationId: string): IntegrationCatalogEntry | null {
    const target = String(integrationId || '').trim();
    if (!target) return null;
    return _integrationCatalog.find((entry) => {
        const slug = String(entry.slug || '').trim();
        const configKey = String(entry.config_key || slug).trim();
        const panelId = String(entry.config_panel_id || slug).trim();
        return slug === target
            || configKey === target
            || panelId === target;
    }) || null;
}

export function supportsIntegrationEntitySync(sourceSlug: string) {
    const def = integrationDefinition(sourceSlug);
    return !!def?.supports_sync;
}

export function integrationLabel(entry: IntegrationCatalogEntry | null | undefined) {
    if (!entry) return '';
    const titleKey = String(entry.title_key || '').trim();
    if (titleKey) {
        const translated = t(titleKey);
        if (translated && translated !== titleKey) return translated;
    }
    return entry.label || entry.slug || '';
}

export function integrationDescription(entry: IntegrationCatalogEntry | null | undefined) {
    if (!entry) return '';
    const descKey = String(entry.description_key || '').trim();
    if (descKey) {
        const translated = t(descKey);
        if (translated && translated !== descKey) return translated;
    }
    return String(entry.description || '').trim();
}
