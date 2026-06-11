#!/usr/bin/env python3
"""Split static/js/integrations/core.ts into focused modules."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "static/js/integrations/core.ts"
OUT = ROOT / "static/js/integrations"

lines = CORE.read_text().splitlines(keepends=True)


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def rename_catalog_helpers(text: str) -> str:
    repl = [
        ("_normalizeIntegrationIcon", "normalizeIntegrationIcon"),
        ("_integrationCatalogSlug", "integrationCatalogSlug"),
        ("_integrationEntitySourceSlug", "integrationEntitySourceSlug"),
        ("_integrationIdForSourceSlug", "integrationIdForSourceSlug"),
        ("_integrationDefinition", "integrationDefinition"),
        ("_supportsIntegrationEntitySync", "supportsIntegrationEntitySync"),
        ("_integrationLabel", "integrationLabel"),
        ("_applyCatalogEnabledToCheckboxes", "applyCatalogEnabledToCheckboxes"),
        ("_persistIntegrationEnabled", "persistIntegrationEnabled"),
        ("_detailLocale", "detailLocale"),
    ]
    for old, new in repl:
        text = text.replace(old, new)
    return text


CATALOG_META = """/**
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

""" + rename_catalog_helpers(chunk(225, 279)).replace(
    "function normalizeIntegrationIcon", "export function normalizeIntegrationIcon"
).replace(
    "function integrationCatalogSlug", "export function integrationCatalogSlug"
).replace(
    "function integrationEntitySourceSlug", "export function integrationEntitySourceSlug"
).replace(
    "function integrationIdForSourceSlug", "export function integrationIdForSourceSlug"
).replace(
    "function integrationDefinition", "export function integrationDefinition"
).replace(
    "function supportsIntegrationEntitySync", "export function supportsIntegrationEntitySync"
).replace(
    "function integrationLabel", "export function integrationLabel"
)

CATALOG = """/**
 * Settings → Integrations catalog list, toggles, subtabs.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast } from '../utils.js';
import { loadConfig } from '../features_config.js';
import { toggleVoiceRecording, isVoiceLoopActive } from '../voice.js';
import {
    getIntegrationCatalog,
    setIntegrationCatalog,
    integrationDefinition,
    integrationLabel,
    normalizeIntegrationIcon,
    updateIntegrationCatalogEnabled,
} from './catalog_meta.js';
import { integrationEntitySourceSlug } from './catalog_meta.js';
import { syncIntegrationEntities } from './entities_sync.js';
import { findIntegrationCheckbox, integrationSlugCandidates } from './utils.js';

""" + rename_catalog_helpers(
    chunk(40, 99) + chunk(104, 214) + chunk(281, 349) + chunk(351, 386)
).replace(
    "let _integrationCatalog: IntegrationCatalogEntry[] = [];\n\n", ""
).replace(
    "_integrationCatalog.length", "getIntegrationCatalog().length"
).replace(
    "_integrationCatalog = Array", "setIntegrationCatalog(Array"
).replace(
    "_integrationCatalog = []", "setIntegrationCatalog([])"
).replace(
    "_integrationCatalog.map", "getIntegrationCatalog().map"
).replace(
    "for (const entry of _integrationCatalog)", "for (const entry of getIntegrationCatalog())"
).replace(
    "if (_integrationCatalog.length && !force) return _integrationCatalog;",
    "if (getIntegrationCatalog().length && !force) return getIntegrationCatalog();",
).replace(
    "return _integrationCatalog;", "return getIntegrationCatalog();"
)

EXPOSED = """/**
 * Integration exposed devices grid, live updates, device/entity modals.
 */
import { apiCall } from '../api.js';
import {
    initIntegrationsLiveWs,
    refreshIntegrationsLiveConnection,
    subscribeIntegrationsLive,
} from '../integrations_live_ws.js';
import { t, translateApiDetail, tState } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr, showToast } from '../utils.js';
import { renderEntityModal, getDomainIcon, wireEntityRegistryEditor } from '../entity_renderers.js';
import { ACTIVE_STATES, CONTROLLABLE, selectOptionsFromCaps } from '../entity_constants.js';
import { appendMediaQueryToken, getCameraStreamToken, startCameraPreviewRefresh, stopCameraPreviewRefresh } from '../camera_auth.js';
import { integrationSlugsMatch } from '../integration_sources.js';
import type { ExposedDevicesState, IntegrationDeviceSection } from '../types/features_integrations_settings.js';
import type { IntegrationDeviceGroup, HyveEntity } from '../types/entity.js';
import { errMsg, isActiveState } from './utils.js';
import {
    integrationDefinition,
    integrationEntitySourceSlug,
    integrationIdForSourceSlug,
    integrationLabel,
    supportsIntegrationEntitySync,
} from './catalog_meta.js';
import { syncConfiguredIntegration } from './catalog.js';
import { navigateToSmartHomeSource } from './entities_sync.js';

""" + rename_catalog_helpers(chunk(389, 662) + chunk(1087, 1505)).replace(
    "async function loadIntegrationExposedEntities", "export async function loadIntegrationExposedEntities", 1
)

CONFIG_ENTRIES = """/**
 * HA-style integration config entries (multi-instance, declarative).
 */
import { apiCall } from '../api.js';
import { t, translateApiDetail, integrationApiMessage } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr, showToast, showConfirm } from '../utils.js';
import type { IntegrationConfigEntriesState } from '../types/features_integrations_settings.js';
import { errMsg, intEl } from './utils.js';
import { integrationDefinition, integrationHasConfigSchema } from './catalog_meta.js';
import { loadIntegrationExposedEntities } from './exposed_devices.js';

""" + rename_catalog_helpers(chunk(665, 1084)).replace(
    "function _integrationHasConfigSchema", "function integrationHasConfigSchema"
)

# Add integrationHasConfigSchema to catalog_meta instead
CONFIG_ENTRIES = CONFIG_ENTRIES.replace(
    "function integrationHasConfigSchema", "export function integrationHasConfigSchema", 1
).replace(
    "async function loadIntegrationConfigEntries", "export async function loadIntegrationConfigEntries", 1
).replace(
    "!_integrationHasConfigSchema", "!integrationHasConfigSchema"
)

CONFIG_MODAL = """/**
 * Integration config modal, CCTV camera rows, Assist API key helpers.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr, showToast, showConfirm, openSubPage, closeSubPage } from '../utils.js';
import { copyToClipboard } from '../features_config.js';
import { intEl } from './utils.js';
import {
    integrationDefinition,
    integrationCatalogSlug,
    integrationLabel,
    normalizeIntegrationIcon,
    supportsIntegrationEntitySync,
} from './catalog_meta.js';
import { loadIntegrationCatalog, syncConfiguredIntegration } from './catalog.js';
import { loadIntegrationExposedEntities } from './exposed_devices.js';
import { loadIntegrationConfigEntries } from './config_entries.js';
import { loadExposedEntitiesSummary } from './entities_sync.js';

""" + rename_catalog_helpers(chunk(1507, 1709)).replace(
    "_loadExposedEntitiesSummary", "loadExposedEntitiesSummary"
).replace(
    "_integrationHasConfigSchema", "integrationHasConfigSchema"
)

CONFIG_MODAL = CONFIG_MODAL.replace(
    "import { loadIntegrationConfigEntries } from './config_entries.js';\nimport { loadExposedEntitiesSummary } from './entities_sync.js';\n",
    "import { loadIntegrationConfigEntries, integrationHasConfigSchema } from './config_entries.js';\nimport { loadExposedEntitiesSummary } from './entities_sync.js';\n",
)

ENTITIES_SYNC = """/**
 * Integration entity sync/load (Pago, Fusion Solar, etc.).
 */
import { apiCall } from '../api.js';
import { t, translateApiDetail, integrationApiMessage } from '../lang/index.js';
import { escapeHtml, showToast } from '../utils.js';
import { switchTab } from '../nav_bridge.js';
import { filterHABySource } from '../features_smarthome.js';
import type {
    EntityMetaInfo,
    IntegrationEntitiesMap,
    SyncIntegrationEntitiesOptions,
} from '../types/features_integrations_settings.js';
import { errMsg } from './utils.js';
import { detailRenderers, entityDetailText, entityMeta, detailLocale } from './entity_details.js';
import { integrationCatalogSlug } from './catalog_meta.js';
import { loadIntegrationConfigEntries } from './config_entries.js';

""" + rename_catalog_helpers(chunk(1712, 1896)).replace(
    "async function _loadExposedEntitiesSummary", "export async function loadExposedEntitiesSummary"
).replace(
    "function _openEntityDetailModal", "function openEntityDetailModal"
).replace(
    "_openEntityDetailModal", "openEntityDetailModal"
)

# Export loadIntegrationExposedEntities from exposed - config_entries needs it
# Export syncConfiguredIntegration from catalog
# Export integrationHasConfigSchema from config_entries

CORE_FACADE = """/**
 * Settings → Integrations: re-exports facade.
 */
export { escapeHtmlAttr } from '../utils.js';

export {
    integrationEnabledForSave,
    withOptionalIntegrationEnabled,
    syncIntegrationToggles,
    switchIntegrationSubtab,
    bindIntegrationToggleButtonsOnce,
    syncConfiguredIntegration,
    loadIntegrationCatalog,
    refreshIntegrationsSettingsView,
} from './catalog.js';

export { getIntegrationCatalog } from './catalog_meta.js';

export {
    openIntegrationEntityCard,
    openIntegrationDeviceModal,
    controlIntegrationEntity,
    renameIntegrationDevice,
} from './exposed_devices.js';

export {
    slugForId,
    renderCctvCameras,
    openIntegrationConfigModal,
    copyAssistOllamaUserUrl,
    copyAssistKey,
    regenerateAssistKey,
    closeIntegrationConfigModal,
} from './config_modal.js';

export {
    navigateToSmartHomeSource,
    syncIntegrationEntities,
    loadIntegrationEntities,
} from './entities_sync.js';
"""

files = {
    "catalog_meta.ts": CATALOG_META,
    "catalog.ts": CATALOG,
    "exposed_devices.ts": EXPOSED,
    "config_entries.ts": CONFIG_ENTRIES,
    "config_modal.ts": CONFIG_MODAL,
    "entities_sync.ts": ENTITIES_SYNC,
    "core.ts": CORE_FACADE,
}

for name, content in files.items():
    (OUT / name).write_text(content)
    print(f"wrote {name}: {len(content.splitlines())} lines")
