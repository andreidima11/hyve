#!/usr/bin/env python3
"""Split static/js/features_config.ts into static/js/config/ modules."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "static/js/features_config.ts"
OUT = ROOT / "static/js/config"

lines = SRC.read_text().splitlines(keepends=True)


def chunk(start: int, end: int) -> str:
    return "".join(lines[start - 1 : end])


def privatize(text: str) -> str:
    repl = [
        ("_cfgVal(", "cfgVal("),
        ("_errMsg(", "errMsg("),
        ("_findIntegrationCheckbox", "findIntegrationCheckbox"),
        ("_integrationSlugCandidates", "integrationSlugCandidates"),
        ("_refreshUiLanguageSelect", "refreshUiLanguageSelect"),
        ("_updateSearchTendencyHint", "updateSearchTendencyHint"),
        ("_savePiperAddonConfig", "savePiperAddonConfig"),
        ("_applyAndSaveUiLanguage", "applyAndSaveUiLanguage"),
    ]
    for old, new in repl:
        text = text.replace(old, new)
    return text


UTILS = """/**
 * Config form DOM helpers.
 */
import type { ConfigFormElement } from '../types/features_config.js';
import { t } from '../lang/index.js';

export function cfgField(id: string): ConfigFormElement | null {
    return document.getElementById(id) as ConfigFormElement | null;
}

export function cfgNode(id: string): HTMLElement | null {
    return document.getElementById(id);
}

export function cfgVal(id: string): string {
    return cfgField(id)?.value ?? '';
}

export function errMsg(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

export function integrationSlugCandidates(slug: string): string[] {
    const raw = String(slug || '').trim();
    if (!raw) return [];
    const dash = raw.replace(/_/g, '-');
    const under = raw.replace(/-/g, '_');
    return Array.from(new Set([raw, dash, under]));
}

export function findIntegrationCheckbox(slug: string): ConfigFormElement | null {
    for (const candidate of integrationSlugCandidates(slug)) {
        const ids = [`${candidate}_enabled`, `integrations-${candidate}-enabled`, `${candidate}Enabled`];
        for (const id of ids) {
            const el = cfgField(id);
            if (el && el.type === 'checkbox') return el;
        }
    }
    return null;
}

export function formatHealthError(detail: unknown): string {
    const raw = String(detail || '').trim();
    const low = raw.toLowerCase();
    if (!raw) return t('hy.addon_health_no_response');
    if (low === 'not_running') return t('hy.addon_health_not_running');
    if (low === 'no_port_configured') return t('hy.addon_health_no_port');
    if (low.includes('connection refused') || low.includes('errno 61')) return t('hy.addon_health_connection_refused');
    if (low.includes('timed out') || low.includes('timeout')) return t('hy.addon_health_timeout');
    return raw;
}
"""

UI_LANGUAGE = """/**
 * UI language dropdown + search tendency hint.
 */
import { apiCall } from '../api.js';
import { setLanguage, getLanguage, t, getAvailableLanguages, loadComponentTranslations } from '../lang/index.js';
import { showToast } from '../utils.js';
import { initGenericCustomSelects } from '../features_custom_selects.js';
import { cfgField } from './utils.js';

const _SEARCH_TENDENCY_HINTS: Record<number, string> = {
    1: 'Minimal — almost never searches. Only when you explicitly ask it to.',
    2: 'Conservative — prefers own knowledge, searches only for today\\'s news/weather.',
    3: 'Balanced — searches for current events, uses knowledge for known facts.',
    4: 'Proactive — searches when not fully confident, verifies uncertain facts.',
    5: 'Aggressive — actively searches to provide the freshest information.',
};

export function updateSearchTendencyHint(val: number) {
    const hint = cfgField('search_tendency_hint');
    if (hint) hint.textContent = _SEARCH_TENDENCY_HINTS[val] || _SEARCH_TENDENCY_HINTS[3];
}

let _uiLanguageSaveSeq = 0;

export function refreshUiLanguageSelect(language: string) {
    const uiLangSelect = cfgField('ui_language');
    const dd = cfgField('ui_language_dropdown');
    if (!uiLangSelect) return;
    const value = language || uiLangSelect.value || getLanguage();
    const opts = getAvailableLanguages();
    uiLangSelect.value = value;
    if (!dd) return;
    const menu = dd.querySelector('.dashboard-custom-select__menu');
    const valueEl = dd.querySelector('.dashboard-custom-select__value');
    const selectedLabel = (opts.find(o => o.code === value)?.label) || (opts[0]?.label) || '—';
    if (valueEl) valueEl.textContent = selectedLabel;
    if (menu) {
        menu.innerHTML = opts.map(o => {
            const isSelected = o.code === value;
            return `<button type="button" class="dashboard-custom-select__option" data-value="${o.code}" data-selected="${isSelected ? 'true' : 'false'}">${o.label}</button>`;
        }).join('');
    }
}

let _uiLanguageDropdownBound = false;

if (typeof document !== 'undefined' && !_uiLanguageDropdownBound) {
    _uiLanguageDropdownBound = true;
    document.addEventListener('click', (e: MouseEvent) => {
        const dd = cfgField('ui_language_dropdown');
        if (!dd) return;
        const tgt = e.target as HTMLElement | null;
        if (!tgt) return;
        const toggleBtn = tgt.closest('[data-action="toggle-ui-language"]');
        if (toggleBtn && dd.contains(toggleBtn)) {
            e.preventDefault();
            e.stopPropagation();
            dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
            return;
        }
        const opt = tgt.closest('.dashboard-custom-select__option');
        if (opt && dd.contains(opt)) {
            e.preventDefault();
            e.stopPropagation();
            const value = (opt as HTMLElement).dataset.value;
            dd.dataset.open = 'false';
            const hidden = cfgField('ui_language');
            if (hidden && value && hidden.value !== value) {
                hidden.value = value;
                applyAndSaveUiLanguage(value);
            }
            return;
        }
        if (!dd.contains(tgt)) dd.dataset.open = 'false';
    });
}

async function applyAndSaveUiLanguage(language: string) {
    if (!language) return;
    const previousLanguage = getLanguage();
    const saveSeq = ++_uiLanguageSaveSeq;
    const dd = cfgField('ui_language_dropdown');

    try {
        setLanguage(language);
        await loadComponentTranslations(language);
        refreshUiLanguageSelect(language);
        try { initGenericCustomSelects(); } catch (_) {}
        if (dd) dd.dataset.disabled = 'true';
        await apiCall('/api/config', { method: 'PATCH', body: { ui: { language } } });
    } catch (err) {
        if (saveSeq === _uiLanguageSaveSeq) {
            try {
                setLanguage(previousLanguage);
                refreshUiLanguageSelect(previousLanguage);
            } catch (_) {}
            showToast(t('config.save_error'), 'error');
        }
    } finally {
        if (dd && saveSeq === _uiLanguageSaveSeq) dd.dataset.disabled = 'false';
    }
}
"""

USER_PHONES = """/**
 * User WhatsApp phone linking (non-admin settings).
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast, showConfirm } from '../utils.js';
import type { ConfigFormElement } from '../types/features_config.js';
import { cfgField } from './utils.js';

export function renderUserPhonesList(phones: string[]) {
    const listEl = cfgField('user-phones-list');
    if (!listEl) return;
    if (!phones.length) {
        listEl.innerHTML = `<span class="text-slate-500 text-[11px]">—</span>`;
        return;
    }
    listEl.innerHTML = phones.map(num => {
        const safeNum = escapeHtml(num);
        const escNum = num.replace(/'/g, "\\\\'");
        return `
        <div class="flex items-center justify-between gap-2 py-1.5 px-2 rounded-lg bg-white/[0.02] border border-white/5">
            <span class="mono text-slate-300">${safeNum}</span>
            <button type="button" data-config-action="unlinkUserPhone" data-config-phone="${escNum}" class="text-[10px] text-red-400 hover:bg-red-500/20 px-2 py-0.5 rounded">${t('common.delete')}</button>
        </div>`;
    }).join('');
}

""" + privatize(chunk(589, 618))

LOAD = """/**
 * Load /api/config into settings form fields.
 */
import { apiCall } from '../api.js';
import { getLanguage, t } from '../lang/index.js';
import { renderExtractionExamples } from '../features_memory.js';
import {
    syncIntegrationToggles,
    bindIntegrationToggleButtonsOnce,
    loadIntegrationCatalog,
    getIntegrationCatalog,
} from '../features_integrations_settings.js';
import { getTts } from '../chat.js';
import { setIsAdmin } from '../user_context.js';
import { syncUpdatesIntervalDropdown } from '../features_addons_settings.js';
import { cfgField, findIntegrationCheckbox } from './utils.js';
import { refreshUiLanguageSelect, updateSearchTendencyHint } from './ui_language.js';
import { renderUserPhonesList, addUserPhone } from './user_phones.js';
import { saveConfig } from './save.js';

let _configAutoSaveBound = false;
let _configAutoSaveTimer = null;
let _configAutoSavePauseUntil = 0;

function _queueConfigAutoSave() {
    // Auto-save disabled — manual Save button used instead
}

function _bindConfigAutoSaveOnce() {
    // Auto-save disabled — manual Save button in settings header
}

""" + privatize(chunk(185, 568))

SAVE = """/**
 * Persist settings form to /api/config.
 */
import { apiCall } from '../api.js';
import { setLanguage, t } from '../lang/index.js';
import { escapeHtml, showToast } from '../utils.js';
import { getExtractionExamples } from '../features_memory.js';
import { setIsAdmin, isExplicitNonAdmin } from '../user_context.js';
import { saveNotificationSettings } from '../features_notifications_config.js';
import type { SaveConfigOptions } from '../types/features_config.js';
import { cfgField, cfgVal, errMsg } from './utils.js';
import { refreshUiLanguageSelect } from './ui_language.js';

""" + privatize(chunk(1308, 1536))

MODEL_PROFILES = """/**
 * Model profiles list, editor, and chat model selector.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { escapeHtml, showToast, showConfirm, openSubPage, closeSubPage } from '../utils.js';
import { updateThinkingModeUi } from '../thinking_mode.js';
import type { ModelProfile, ModelProfilesResponse } from '../types/features_config.js';
import { cfgField } from './utils.js';

""" + privatize(chunk(621, 1306))

CLIPBOARD = """/**
 * Clipboard helpers for settings (webhook, assist keys, etc.).
 */
import { t } from '../lang/index.js';
import { showToast } from '../utils.js';
import { cfgField } from './utils.js';

""" + privatize(chunk(1540, 1575))

SERVER = """/**
 * Server restart + reconnect polling.
 */
import { apiCall, suppressLogout } from '../api.js';
import { t } from '../lang/index.js';
import { showToast, showConfirm } from '../utils.js';
import { showHubStartupLoadingAfterRestart } from '../startup_status.js';
import { errMsg } from './utils.js';

""" + privatize(chunk(1578, 1624))

VOICE_TESTS = """/**
 * Whisper / Piper connection test buttons in settings.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { cfgField, cfgVal, errMsg, formatHealthError } from './utils.js';

async function savePiperAddonConfig(): Promise<void> {
    const body: Record<string, unknown> = {};
    const host = cfgField('piper_host')?.value?.trim();
    const portRaw = cfgField('piper_port')?.value?.trim();
    if (host) body.host = host;
    if (portRaw) body.port = parseInt(portRaw, 10) || undefined;
    if (!Object.keys(body).length) return;
    await apiCall('/api/addons/piper/config', { method: 'PATCH', body });
}

""" + privatize(chunk(1627, 1704))

FACADE = """/**
 * Settings config facade — re-exports config modules + related settings tabs.
 */
export { loadConfig } from './config/load.js';
export { saveConfig } from './config/save.js';
export { addUserPhone, unlinkUserPhone } from './config/user_phones.js';
export {
    loadModelProfiles,
    moveProfileOrder,
    syncVisionCapabilityCheckbox,
    showProfileEditor,
    closeProfileEditor,
    onProfileProviderChange,
    onProfileSubProviderChange,
    saveProfile,
    deleteProfile,
    openProfileCardMenu,
    closeProfileCardMenu,
    setProfileVisibility,
    duplicateProfile,
    activateProfile,
} from './config/model_profiles.js';
export { copyToClipboard, copyWebhook } from './config/clipboard.js';
export { restartServer } from './config/server.js';
export { testWhisperConnection, testPiperConnection } from './config/voice_tests.js';

export {
    refreshIntegrationsSettingsView,
    switchIntegrationSubtab,
    openIntegrationConfigModal,
    closeIntegrationConfigModal,
    copyAssistOllamaUserUrl,
    copyAssistKey,
    regenerateAssistKey,
} from './features_integrations_settings.js';

export {
    selectNotifChannel,
    selectNotifTransport,
    refreshNotifWsNativeStatus,
    testNotification,
    testWsNotification,
    testFcmNotification,
    loadNotificationPrefs,
    saveNotificationSettings,
} from './features_notifications_config.js';

export {
    loadAddons,
    installAddon,
    uninstallAddon,
    toggleAddon,
    openAddonConfigModal,
    closeAddonConfigModal,
    saveAddonConfig,
    checkAddonHealth,
    updateHeaderUpdatesBadge,
    refreshUpdatesHeaderBadge,
    loadUpdatesAddons,
    checkAddonUpdates,
    updateAllAddons,
    updateSingleAddon,
    toggleUpdatesIntervalDropdown,
    setUpdatesInterval,
    syncUpdatesIntervalDropdown,
} from './features_addons_settings.js';

export {
    initGenericCustomSelects,
    upgradeNativeSelects,
} from './features_custom_selects.js';
"""

OUT.mkdir(parents=True, exist_ok=True)
files = {
    "utils.ts": UTILS,
    "ui_language.ts": UI_LANGUAGE,
    "user_phones.ts": USER_PHONES,
    "load.ts": LOAD,
    "save.ts": SAVE,
    "model_profiles.ts": MODEL_PROFILES,
    "clipboard.ts": CLIPBOARD,
    "server.ts": SERVER,
    "voice_tests.ts": VOICE_TESTS,
}
for name, content in files.items():
    (OUT / name).write_text(content)
    print(f"wrote config/{name}: {len(content.splitlines())} lines")

SRC.write_text(FACADE)
print(f"wrote features_config.ts facade: {len(FACADE.splitlines())} lines")
