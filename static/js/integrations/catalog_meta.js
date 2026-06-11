import { t } from '../lang/index.js';
let _integrationCatalog = [];
export function getIntegrationCatalog() {
    return _integrationCatalog;
}
export function setIntegrationCatalog(entries) {
    _integrationCatalog = entries;
}
export function updateIntegrationCatalogEnabled(slug, enabled) {
    const row = _integrationCatalog.find((entry) => String(entry.slug || '') === slug);
    if (row)
        row.enabled = !!enabled;
}
export function normalizeIntegrationIcon(icon) {
    const raw = String(icon || '').trim();
    if (!raw)
        return 'fa-plug';
    if (raw.includes(' '))
        return raw; // already a full FontAwesome class string
    if (raw.startsWith('fa-'))
        return raw;
    return `fa-${raw}`;
}
export function integrationCatalogSlug(integrationId) {
    const def = integrationDefinition(integrationId);
    return String(def?.slug || integrationId || '').trim();
}
export function integrationEntitySourceSlug(integrationId) {
    return integrationCatalogSlug(integrationId);
}
export function integrationIdForSourceSlug(sourceSlug) {
    const target = String(sourceSlug || '').trim();
    if (!target)
        return '';
    const hit = _integrationCatalog.find((entry) => {
        const slug = String(entry.slug || '').trim();
        const configKey = String(entry.config_key || slug).trim();
        return slug === target || configKey === target;
    });
    return String(hit?.slug || hit?.config_key || target).trim();
}
export function integrationDefinition(integrationId) {
    const target = String(integrationId || '').trim();
    if (!target)
        return null;
    return _integrationCatalog.find((entry) => {
        const slug = String(entry.slug || '').trim();
        const configKey = String(entry.config_key || slug).trim();
        const panelId = String(entry.config_panel_id || slug).trim();
        return slug === target
            || configKey === target
            || panelId === target;
    }) || null;
}
export function supportsIntegrationEntitySync(sourceSlug) {
    const def = integrationDefinition(sourceSlug);
    return !!def?.supports_sync;
}
export function integrationLabel(entry) {
    if (!entry)
        return '';
    const titleKey = String(entry.title_key || '').trim();
    if (titleKey) {
        const translated = t(titleKey);
        if (translated && translated !== titleKey)
            return translated;
    }
    return entry.label || entry.slug || '';
}
export function integrationDescription(entry) {
    if (!entry)
        return '';
    const descKey = String(entry.description_key || '').trim();
    if (descKey) {
        const translated = t(descKey);
        if (translated && translated !== descKey)
            return translated;
    }
    return String(entry.description || '').trim();
}
