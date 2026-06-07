/**
 * Settings → Integrations: catalog, config entries, entity browser, modals.
 */
import { apiCall } from './api.js';
import { t, translateApiDetail, integrationApiMessage, getLanguage, tState } from './lang/index.js';
import { escapeHtml, showToast, showConfirm, openSubPage, closeSubPage } from './utils.js';
import { renderEntityModal, getDomainIcon } from './entity_renderers.js';
import { ACTIVE_STATES, CONTROLLABLE } from './entity_constants.js';
import { startCameraPreviewRefresh, stopCameraPreviewRefresh } from './camera_auth.js';
import { closeEntityDetailModal, filterHABySource } from './features_smarthome.js';
import { integrationSlugsMatch } from './integration_sources.js';

function _integrationSlugCandidates(slug) {
    const raw = String(slug || '').trim();
    if (!raw) return [];
    const dash = raw.replace(/_/g, '-');
    const under = raw.replace(/-/g, '_');
    return Array.from(new Set([raw, dash, under]));
}

function _findIntegrationCheckbox(slug) {
    for (const candidate of _integrationSlugCandidates(slug)) {
        const ids = [`${candidate}_enabled`, `integrations-${candidate}-enabled`, `${candidate}Enabled`];
        for (const id of ids) {
            const el = document.getElementById(id);
            if (el && el.type === 'checkbox') return el;
        }
    }
    return null;
}

/** Integration enable toggles live in the dynamic catalog — omit `enabled` on save when
 *  the checkbox is not mounted yet, so unrelated saves cannot flip integrations off. */
export function integrationEnabledForSave(slug) {
    const cb = _findIntegrationCheckbox(slug);
    if (!cb) return undefined;
    return !!cb.checked;
}

export function withOptionalIntegrationEnabled(section, slug) {
    const enabled = integrationEnabledForSave(slug);
    if (enabled !== undefined) section.enabled = enabled;
    return section;
}

function _findIntegrationButton(slug, mode) {
    for (const candidate of _integrationSlugCandidates(slug)) {
        const btn = document.getElementById(`${candidate}-btn-${mode}`);
        if (btn) return btn;
    }
    return null;
}

export function syncIntegrationToggles() {
    document.querySelectorAll('[data-integration-row]').forEach(row => {
        const slug = row.dataset.integrationRow;
        if (!slug) return;
        const input = _findIntegrationCheckbox(slug);
        const disableBtn = _findIntegrationButton(slug, 'disable');
        const enableBtn = _findIntegrationButton(slug, 'enable');
        if (!input || !disableBtn || !enableBtn) return;
        const on = !!input.checked;
        disableBtn.classList.toggle('hidden', !on);
        enableBtn.classList.toggle('hidden', on);
    });
    // Show/hide speak buttons depending on piper enabled
    const piperCheckbox = _findIntegrationCheckbox('piper');
    const anyTtsOn = !!(piperCheckbox && piperCheckbox.checked);
    document.querySelectorAll('.chat-speak-btn').forEach(btn => {
        btn.classList.toggle('hidden', !anyTtsOn);
    });
    // Show/hide always-speak button depending on piper enabled
    const alwaysSpeakBtn = document.getElementById('btn-always-speak');
    if (alwaysSpeakBtn) alwaysSpeakBtn.classList.toggle('hidden', !anyTtsOn);
    // Show/hide voice button depending on whisper enabled
    const voiceBtn = document.getElementById('btn-voice');
    if (voiceBtn) {
        const whisperCheckbox = _findIntegrationCheckbox('whisper');
        const whisperEnabled = !!(whisperCheckbox && whisperCheckbox.checked);
        voiceBtn.classList.toggle('hidden', !whisperEnabled);
        if (!whisperEnabled) {
            if (_voiceMediaRecorder && _voiceMediaRecorder.state === 'recording') {
                try { _voiceMediaRecorder.stop(); } catch (e) {}
            }
            if (_voiceSilenceTimer) { cancelAnimationFrame(_voiceSilenceTimer); _voiceSilenceTimer = null; }
            if (_voiceAudioCtx) { _voiceAudioCtx.close().catch(() => {}); _voiceAudioCtx = null; }
            if (_voiceStream) {
                _voiceStream.getTracks().forEach(t => t.stop());
                _voiceStream = null;
            }
            voiceBtn.disabled = false;
            voiceBtn.classList.remove('recording');
            const icon = voiceBtn.querySelector('i');
            if (icon) icon.className = window.__voiceLoopActive ? 'fas fa-sync-alt' : 'fas fa-microphone';
        }
    }
    updateIntegrationSubtab();
}

// ---------------------------------------------------------------------------
// Integration sub-tabs: Active / Available
// ---------------------------------------------------------------------------
let _activeIntegrationSubtab = 'active';

export function switchIntegrationSubtab(tab) {
    _activeIntegrationSubtab = tab;
    const btnActive = document.getElementById('int-subtab-active');
    const btnAvail  = document.getElementById('int-subtab-available');
    if (btnActive) {
        btnActive.classList.toggle('bg-accent/20', tab === 'active');
        btnActive.classList.toggle('text-accent', tab === 'active');
        btnActive.classList.toggle('border-accent/40', tab === 'active');
        btnActive.classList.toggle('bg-white/5', tab !== 'active');
        btnActive.classList.toggle('text-slate-400', tab !== 'active');
        btnActive.classList.toggle('border-white/10', tab !== 'active');
    }
    if (btnAvail) {
        btnAvail.classList.toggle('bg-accent/20', tab === 'available');
        btnAvail.classList.toggle('text-accent', tab === 'available');
        btnAvail.classList.toggle('border-accent/40', tab === 'available');
        btnAvail.classList.toggle('bg-white/5', tab !== 'available');
        btnAvail.classList.toggle('text-slate-400', tab !== 'available');
        btnAvail.classList.toggle('border-white/10', tab !== 'available');
    }
    updateIntegrationSubtab();
};

function updateIntegrationSubtab() {
    const tab = _activeIntegrationSubtab;
    const enabledMap = {};
    document.querySelectorAll('[data-integration-row]').forEach(row => {
        const slug = row.dataset.integrationRow;
        if (!slug) return;
        enabledMap[slug] = !!_findIntegrationCheckbox(slug)?.checked;
    });

    let visibleCount = 0;
    document.querySelectorAll('[data-integration-row]').forEach(row => {
        const slug = row.dataset.integrationRow;
        const isEnabled = enabledMap[slug] ?? false;
        const show = tab === 'active' ? isEnabled : !isEnabled;
        row.classList.toggle('hidden', !show);
        if (show) visibleCount++;
    });

    const emptyEl = document.getElementById('int-subtab-empty');
    if (emptyEl) emptyEl.classList.toggle('hidden', visibleCount > 0);

    const activeCount = Object.values(enabledMap).filter(Boolean).length;
    const availableCount = Object.keys(enabledMap).length - activeCount;
    const ac = document.getElementById('int-subtab-active-count');
    const avc = document.getElementById('int-subtab-available-count');
    if (ac) ac.textContent = activeCount > 0 ? `(${activeCount})` : '';
    if (avc) avc.textContent = availableCount > 0 ? `(${availableCount})` : '';
}

// --- ComfyUI helpers ---

export async function testComfyUIConnection() {
    const resultEl = document.getElementById('comfyui-test-result');
    if (!resultEl) return;
    resultEl.className = 'text-xs rounded-xl p-3 bg-slate-800 text-slate-400';
    resultEl.textContent = t('common.connecting');
    resultEl.classList.remove('hidden');
    try {
        const urlVal = (document.getElementById('comfyui_url')?.value || '').trim();
        const qs = urlVal ? `?url=${encodeURIComponent(urlVal)}` : '';
        const res = await apiCall(`/api/comfyui/test${qs}`);
        const data = await res.json();
        if (data.ok) {
            const stats = data.system_stats || {};
            const gpu = stats.devices?.[0]?.name || (t('common.unknown'));
            const vram = stats.devices?.[0]?.vram_total ? `${(stats.devices[0].vram_total / (1024**3)).toFixed(1)} GB VRAM` : '';
            resultEl.className = 'text-xs rounded-lg p-3 mt-2 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
            resultEl.textContent = `✓ ${t('config.comfyui_connected', { gpu, vram: vram ? ` — ${vram}` : '' })}`;
        } else {
            resultEl.className = 'text-xs rounded-lg p-3 mt-2 bg-red-500/10 text-red-400 border border-red-500/20';
            resultEl.textContent = `✗ ${data.error || t('config.comfyui_connection_failed')}`;
        }
    } catch (e) {
        resultEl.className = 'text-xs rounded-lg p-3 mt-2 bg-red-500/10 text-red-400 border border-red-500/20';
        resultEl.textContent = `✗ ${e.message || t('config.comfyui_request_failed')}`;
    }
};

export async function refreshComfyUICheckpoints() {
    const select = document.getElementById('comfyui_checkpoint');
    if (!select) return;
    const current = select.value;
    try {
        const urlVal = (document.getElementById('comfyui_url')?.value || '').trim();
        const qs = urlVal ? `?url=${encodeURIComponent(urlVal)}` : '';
        const res = await apiCall(`/api/comfyui/checkpoints${qs}`);
        const data = await res.json();
        const checkpoints = data.checkpoints || [];
        select.innerHTML = `<option value="">${escapeHtml(t('config.comfyui_select_checkpoint'))}</option>`;
        for (const ckpt of checkpoints) {
            const opt = document.createElement('option');
            opt.value = ckpt;
            opt.textContent = ckpt;
            select.appendChild(opt);
        }
        if (current && checkpoints.includes(current)) select.value = current;
        if (checkpoints.length) showToast(t('config.comfyui_checkpoints_found', { count: checkpoints.length }), 'success');
        else showToast(t('config.comfyui_no_checkpoints'), 'warning');
    } catch (e) {
        showToast(t('config.comfyui_checkpoints_fetch_failed', { detail: e.message || e }), 'error');
    }
};

export async function refreshComfyUIWorkflows() {
    const select = document.getElementById('comfyui_workflow_file');
    if (!select) return;
    const current = select.value;
    try {
        const res = await apiCall('/api/comfyui/workflows');
        const data = await res.json();
        const workflows = data.workflows || [];
        select.innerHTML = `<option value="">${escapeHtml(t('config.comfyui_workflow_none'))}</option>`;
        for (const wf of workflows) {
            const opt = document.createElement('option');
            opt.value = `comfyui_workflows/${wf.file}`;
            opt.textContent = wf.name;
            select.appendChild(opt);
        }
        if (current) select.value = current;
        if (workflows.length) showToast(t('config.comfyui_workflows_found', { count: workflows.length }), 'success');
        else showToast(t('config.comfyui_no_workflows'), 'info');
    } catch (e) {
        showToast(t('config.comfyui_workflows_fetch_failed', { detail: e.message || e }), 'error');
    }
};

export async function uploadComfyUIWorkflow(input) {
    const file = input.files?.[0];
    if (!file) return;
    try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch('/api/comfyui/workflows/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${window._authToken || ''}` },
            body: formData,
        });
        const data = await res.json();
        if (data.ok) {
            showToast(t('config.comfyui_workflow_uploaded', { file: data.file }), 'success');
            await refreshComfyUIWorkflows();
            // Auto-select the uploaded workflow
            const select = document.getElementById('comfyui_workflow_file');
            if (select) select.value = `comfyui_workflows/${data.file}`;
        } else {
            showToast(t('config.comfyui_upload_failed', { detail: data.error || t('common.unknown') }), 'error');
        }
    } catch (e) {
        showToast(t('config.comfyui_upload_failed', { detail: e.message || e }), 'error');
    }
    input.value = ''; // reset file input
};

let _integrationToggleButtonsBound = false;
export function bindIntegrationToggleButtonsOnce() {
    if (_integrationToggleButtonsBound) return;
    _integrationToggleButtonsBound = true;

    document.addEventListener('click', (e) => {
        const btn = e.target?.closest?.('.integration-toggle-btn');
        if (!btn) return;
        const wrap = btn.parentElement;
        const checkbox = wrap?.querySelector('input[type="checkbox"]');
        if (!checkbox) return;

        if (btn.id.includes('-btn-enable')) checkbox.checked = true;
        if (btn.id.includes('-btn-disable')) checkbox.checked = false;

        syncIntegrationToggles();

        // Always persist the enabled flag for THIS integration directly via
        // PATCH (deep-merge) — saveConfig() only knows about explicit panels
        // (pago, whisper, …) so generic catalog integrations like mosquitto
        // would lose the toggle on refresh otherwise.
        const slug = (btn.id || '').replace(/-btn-(enable|disable)$/, '');
        if (slug) {
            const def = _integrationDefinition(slug);
            const configKey = String(def?.config_key || slug).trim() || slug;
            apiCall('/api/config', {
                method: 'PATCH',
                body: { [configKey]: { enabled: !!checkbox.checked } },
            }).catch(() => {});
        }
    });

    const addCamBtn = document.getElementById('cctv-add-camera');
    if (addCamBtn) addCamBtn.addEventListener('click', addCctvCameraRow);
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC INTEGRATION CATALOG
// Backed by /api/integrations/catalog (see ui_catalog.json + ui_catalog.py).
// Renders the integration list rows, resolves modal title/icon/description and
// drives the shared "emitted entities" section. See docs/CARDS_AND_INTEGRATIONS.md.
// ─────────────────────────────────────────────────────────────────────────────

let _integrationCatalog = [];

function _normalizeIntegrationIcon(icon) {
    const raw = String(icon || '').trim();
    if (!raw) return 'fa-plug';
    if (raw.includes(' ')) return raw; // already a full FontAwesome class string
    if (raw.startsWith('fa-')) return raw;
    return `fa-${raw}`;
}

function _integrationCatalogSlug(integrationId) {
    const def = _integrationDefinition(integrationId);
    return String(def?.slug || integrationId || '').trim();
}

function _integrationEntitySourceSlug(integrationId) {
    return _integrationCatalogSlug(integrationId);
}

function _integrationDefinition(integrationId) {
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

function _supportsIntegrationEntitySync(sourceSlug) {
    const def = _integrationDefinition(sourceSlug);
    return !!def?.supports_sync;
}

function _integrationLabel(entry) {
    if (!entry) return '';
    const titleKey = String(entry.title_key || '').trim();
    if (titleKey) {
        const translated = t(titleKey);
        if (translated && translated !== titleKey) return translated;
    }
    return entry.label || entry.slug || '';
}

export async function syncConfiguredIntegration(integrationId, button = null) {
    const sourceSlug = _integrationEntitySourceSlug(integrationId);
    const btn = button || document.getElementById(`${sourceSlug}-sync-btn`) || document.getElementById(`${integrationId}-sync-btn`);
    const originalHtml = btn?.innerHTML || '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('integrations.entity_detail.sync_btn'))}</span>`;
    }
    try {
        await syncIntegrationEntities(sourceSlug, { toast: true });
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml || `<i class="fas fa-arrows-rotate"></i><span>${escapeHtml(t('integrations.entity_detail.sync_btn'))}</span>`;
        }
    }
};

function _renderIntegrationCatalogRows() {
    const list = document.getElementById('integrations-list');
    if (!list) return;
    // Preserve the empty-state paragraph if it exists.
    const emptyEl = document.getElementById('int-subtab-empty');
    list.innerHTML = '';
    if (emptyEl) list.appendChild(emptyEl);

    const rowsHtml = _integrationCatalog.map((entry) => {
        const slug = escapeHtml(String(entry.slug || ''));
        const panelId = escapeHtml(String(entry.config_panel_id || entry.slug || ''));
        const toggleInputId = escapeHtml(String(entry.toggle_input_id || `${entry.slug}_enabled`));
        const toggleSlug = escapeHtml(String(entry.toggle_slug || entry.slug || ''));
        const label = escapeHtml(_integrationLabel(entry));
        const description = escapeHtml(String(entry.description || '').trim());
        const iconClass = escapeHtml(_normalizeIntegrationIcon(entry.icon || 'fa-plug'));
        const image = String(entry.image || '').trim();
        const accent = escapeHtml(String(entry.accent || '#94a3b8'));
        const iconBackground = escapeHtml(String(entry.icon_background || 'rgba(148,163,184,0.18)'));
        const textColor = escapeHtml(String(entry.text_color || entry.accent || '#cbd5e1'));
        const adminOnly = entry.admin_only ? 'config-admin-only' : '';
        const syncButton = entry.supports_sync
            ? `<button type="button" id="${slug}-sync-btn" data-config-action="syncConfiguredIntegration" data-config-slug="${slug}" class="px-3 py-2 rounded-xl text-xs font-medium bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 transition-colors inline-flex items-center gap-1.5"><i class="fas fa-arrows-rotate"></i><span>${escapeHtml(t('integrations.entity_detail.sync_btn'))}</span></button>`
            : '';
        // Toggle is rendered for every integration — Home Assistant is just
        // another source and can be disabled like any other.
        const toggle = `
                    <div class="flex items-center gap-2 ${adminOnly}">
                        <input type="checkbox" id="${toggleInputId}" class="sr-only" aria-hidden="true">
                        <button type="button" id="${toggleSlug}-btn-disable" class="integration-toggle-btn integration-btn-disable text-red-500/70 hover:text-red-500 hover:bg-red-500/10 px-3 sm:px-4 py-2 sm:py-2.5 rounded-lg sm:rounded-xl text-[10px] sm:text-xs font-bold uppercase tracking-wider transition-all inline-flex items-center gap-1.5 sm:gap-2 min-h-[36px] sm:min-h-[44px] border border-transparent hover:border-red-500/20 touch-manipulation hidden"><i class="fas fa-power-off"></i> <span>${escapeHtml(t('integrations.disable'))}</span></button>
                        <button type="button" id="${toggleSlug}-btn-enable" class="integration-toggle-btn integration-btn-enable text-emerald-500/70 hover:text-emerald-500 hover:bg-emerald-500/10 px-3 sm:px-4 py-2 sm:py-2.5 rounded-lg sm:rounded-xl text-[10px] sm:text-xs font-bold uppercase tracking-wider transition-all inline-flex items-center gap-1.5 sm:gap-2 min-h-[36px] sm:min-h-[44px] border border-transparent hover:border-emerald-500/20 touch-manipulation"><i class="fas fa-check"></i> <span>${escapeHtml(t('integrations.enable'))}</span></button>
                    </div>`;
        return `
            <div data-integration-row="${slug}" class="cfg-section flex flex-wrap items-center justify-between gap-3 min-w-0 ${adminOnly}" style="border-left: 4px solid ${accent};">
                <div class="flex items-center gap-3 min-w-0">
                    ${image ? `<img src="${escapeHtml(image)}" alt="" class="w-10 h-10 shrink-0" loading="lazy">` : `<span class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style="background:${iconBackground}; color:${textColor};"><i class="fas ${iconClass} text-xl"></i></span>`}
                    <div class="min-w-0">
                        <div class="text-sm font-bold truncate" style="color:${textColor};">${label}</div>
                        ${description ? `<div class="text-[11px] text-slate-500 truncate">${description}</div>` : ''}
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <button type="button" data-config-action="openIntegrationConfigModal" data-config-slug="${slug}" class="px-4 py-2 rounded-xl text-xs font-medium bg-white/5 hover:bg-white/10 text-slate-300 border border-white/10 transition-colors">${escapeHtml(t('integrations.settings_btn'))}</button>
                    ${syncButton}
                    ${toggle}
                </div>
            </div>`;
    }).join('');

    list.insertAdjacentHTML('beforeend', rowsHtml);
}

export async function loadIntegrationCatalog(force = false) {
    if (_integrationCatalog.length && !force) return _integrationCatalog;
    try {
        const res = await apiCall('/api/integrations/catalog');
        const data = await res.json().catch(() => ({}));
        _integrationCatalog = Array.isArray(data.integrations) ? data.integrations : [];
    } catch (_) {
        _integrationCatalog = [];
    }
    _renderIntegrationCatalogRows();
    return _integrationCatalog;
}

let _activeIntegrationSubtabPreferred = 'auto';
export async function refreshIntegrationsSettingsView(preferredTab = 'auto') {
    _activeIntegrationSubtabPreferred = preferredTab;
    await loadIntegrationCatalog(true);
    // The catalog renderer creates fresh checkbox/inputs for each integration,
    // so we must re-apply the saved config values; otherwise toggling is lost
    // on every refresh because the new <input> nodes start unchecked.
    try { await loadConfig(); } catch (_) {}
    // Apply per-integration "enabled" flags for generic catalog integrations
    // (mosquitto, etc.) — loadConfig() only sets a hardcoded set of fields.
    try {
        const r2 = await apiCall('/api/config');
        const cfg2 = await r2.json().catch(() => ({}));
        for (const entry of _integrationCatalog) {
            const slug = String(entry.slug || '');
            if (!slug) continue;
            const inputId = String(entry.toggle_input_id || `${slug}_enabled`);
            const cb = document.getElementById(inputId);
            if (!cb) continue;
            const section = cfg2[entry.config_key || slug];
            if (section && typeof section === 'object') {
                cb.checked = !!section.enabled;
            }
        }
    } catch (_) {}
    syncIntegrationToggles();
    bindIntegrationToggleButtonsOnce();

    let nextTab = preferredTab;
    if (preferredTab === 'auto') {
        const hasActive = Array.from(document.querySelectorAll('[data-integration-row]'))
            .some((row) => !!_findIntegrationCheckbox(row.dataset.integrationRow)?.checked);
        nextTab = hasActive ? 'active' : 'available';
    }
    if (nextTab !== 'active' && nextTab !== 'available') nextTab = 'active';
    switchIntegrationSubtab(nextTab);
}

// Shared "emitted devices" section — populated when the integration modal
// is opened. Groups exposed entities by device and renders clickable device
// cards; clicking a card opens a modal with controls + rename, à la
// Home Assistant.
let _exposedDevicesState = { slug: null, devices: [] };
// Page index per slug for the device grid.
const _DEVICE_PAGE_SIZE = 6;
const _devicePageState = new Map();

function _renderDevicesSection(section, group, slug, baseOffset, opts) {
    const pageSize = _DEVICE_PAGE_SIZE;
    const showEntryLabel = !!(opts && opts.showEntryLabel);
    const pages = Math.max(1, Math.ceil(group.devices.length / pageSize));
    const stateKey = `${slug}::${group.key}`;
    let page = _devicePageState.get(stateKey) || 0;
    if (page >= pages) page = pages - 1;
    if (page < 0) page = 0;
    _devicePageState.set(stateKey, page);

    const start = page * pageSize;
    const slice = group.devices.slice(start, start + pageSize);
    const cardsHtml = slice
        .map((d, j) => _devCardHtml(d, baseOffset + start + j, slug, showEntryLabel))
        .join('');

    const pagerHtml = pages > 1
        ? `<div class="flex items-center justify-between gap-2 mt-1 pt-2 border-t border-white/5" data-device-pager>
            <button type="button" data-device-page-prev ${page === 0 ? 'disabled' : ''}
                class="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:cursor-not-allowed">
                <i class="fas fa-chevron-left mr-1"></i>${escapeHtml(t('common.prev'))}
            </button>
            <span class="text-[11px] text-slate-500 mono">${escapeHtml(t('integrations.devices_pager', { page: page + 1, pages, count: group.devices.length }))}</span>
            <button type="button" data-device-page-next ${page >= pages - 1 ? 'disabled' : ''}
                class="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:cursor-not-allowed">
                ${escapeHtml(t('common.next'))}<i class="fas fa-chevron-right ml-1"></i>
            </button>
        </div>`
        : '';

    section.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2" style="column-gap:1.5rem;row-gap:1.25rem;">${cardsHtml}</div>
        ${pagerHtml}`;

    const prev = section.querySelector('[data-device-page-prev]');
    const next = section.querySelector('[data-device-page-next]');
    if (prev) prev.onclick = () => {
        _devicePageState.set(stateKey, Math.max(0, (_devicePageState.get(stateKey) || 0) - 1));
        _renderDevicesSection(section, group, slug, baseOffset, opts);
    };
    if (next) next.onclick = () => {
        _devicePageState.set(stateKey, Math.min(pages - 1, (_devicePageState.get(stateKey) || 0) + 1));
        _renderDevicesSection(section, group, slug, baseOffset, opts);
    };
}

function _devCardHtml(d, idx, slug, showEntryLabel) {
    const name = escapeHtml(d.name || d.device_id || t('integrations.device'));
    const ents = Array.isArray(d.entities) ? d.entities : [];
    const total = ents.length;
    const sub = [d.model, d.manufacturer].filter(Boolean).join(' · ');
    // Domain tally chips
    const tally = {};
    const _domOf = (e) => String(e.domain || String(e.entity_id || '').split('.')[0] || 'other').toLowerCase();
    for (const e of ents) {
        const dom = _domOf(e) || 'other';
        tally[dom] = (tally[dom] || 0) + 1;
    }
    const chips = Object.entries(tally).slice(0, 4).map(([dom, n]) => {
        const ic = getDomainIcon(dom);
        return `<span class="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-white/[0.04] border border-white/5 text-slate-400 uppercase tracking-wider"><i class="fas ${ic} text-[9px]"></i>${escapeHtml(dom)}<span class="text-slate-300">${n}</span></span>`;
    }).join('');
    // Primary readout: battery / state count (no on-count badge)
    let primary = `<span class="text-[10px] text-slate-500">${escapeHtml(t('integrations.entities_short', { count: total }))}</span>`;
    const sslug = escapeHtmlAttr(String(slug || ''));
    const entryTitle = (showEntryLabel && d.entry_title) ? escapeHtml(d.entry_title) : '';
    const entryHeader = entryTitle
        ? `<div class="flex items-center gap-1.5 mb-2 px-1 text-[10px] uppercase tracking-widest text-slate-500">
            <i class="fas fa-plug text-[9px] opacity-70"></i>
            <span class="truncate">${entryTitle}</span>
        </div>`
        : '';
    return `
    <div class="flex flex-col min-w-0">
        ${entryHeader}
        <div class="bg-white/[0.03] border border-white/5 rounded-xl p-4 hover:bg-white/[0.06] hover:border-accent/20 transition-all cursor-pointer overflow-hidden"
             data-entity-action="openDeviceModal" data-int-index="${idx}" data-int-slug="${sslug}">
            <div class="flex items-start justify-between gap-3 min-w-0">
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 min-w-0">
                        <i class="fas fa-microchip text-accent/70 text-sm shrink-0"></i>
                        <div class="text-[13px] font-semibold text-slate-100 fade-edge-r min-w-0 flex-1">${name}</div>
                    </div>
                    ${sub ? `<div class="text-[11px] text-slate-500 truncate mt-1">${escapeHtml(sub)}</div>` : ''}
                </div>
                <div class="shrink-0">${primary}</div>
            </div>
            ${chips ? `<div class="flex items-center gap-1.5 mt-3 flex-wrap min-w-0">${chips}</div>` : ''}
        </div>
    </div>`;
}

async function loadIntegrationExposedEntities(integrationId) {
    const section = document.getElementById('integration-exposed-entities-section');
    const caption = document.getElementById('integration-exposed-entities-caption');
    const grid    = document.getElementById('integration-exposed-entities-grid');
    const empty   = document.getElementById('integration-exposed-entities-empty');
    const error   = document.getElementById('integration-exposed-entities-error');
    const openBtn = document.getElementById('integration-exposed-entities-open');
    const syncBtn = document.getElementById('integration-exposed-entities-sync');
    if (!section || !grid || !empty || !openBtn) return null;

    const sourceSlug = _integrationEntitySourceSlug(integrationId);
    if (!_supportsIntegrationEntitySync(sourceSlug)) {
        section.classList.add('hidden');
        return null;
    }
    section.classList.remove('hidden');
    grid.innerHTML = '';
    grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-3';
    empty.classList.add('hidden');
    error.classList.add('hidden');
    if (caption) caption.textContent = t('common.loading_devices');

    openBtn.onclick = () => {
        navigateToSmartHomeSource(sourceSlug);
    };
    if (syncBtn) {
        const supportsSync = _supportsIntegrationEntitySync(sourceSlug);
        syncBtn.classList.toggle('hidden', !supportsSync);
        syncBtn.classList.toggle('inline-flex', supportsSync);
        syncBtn.onclick = supportsSync ? async () => {
            await syncConfiguredIntegration(integrationId, syncBtn);
            await loadIntegrationExposedEntities(integrationId);
        } : null;
    }

    try {
        const res = await apiCall(`/api/integrations/${encodeURIComponent(sourceSlug)}/devices`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || translateApiDetail(data.message) || t('integrations.devices_load_error'));
        const devices = Array.isArray(data.devices) ? data.devices : [];
        const totalEnts = devices.reduce((s, d) => s + ((d.entities && d.entities.length) || 0), 0);
        const meta = _integrationDefinition(integrationId);
        const label = _integrationLabel(meta) || integrationId;
        if (caption) caption.textContent = t('integrations.devices_caption', { label, devices: devices.length, entities: totalEnts });

        if (!devices.length) {
            _exposedDevicesState = { slug: sourceSlug, devices: [] };
            empty.classList.remove('hidden');
            return 0;
        }
        // Single continuous grid: cards flow one after another regardless of
        // entry. When more than one entry is in play, each card shows its
        // own entry title as a small caption below it. Sort so devices from
        // the same entry stay adjacent.
        const entryKeys = new Set(devices.map(d => d.entry_id || ''));
        const showEntryLabel = entryKeys.size > 1;
        const sorted = devices.slice().sort((a, b) => {
            const ta = String(a.entry_title || '');
            const tb = String(b.entry_title || '');
            if (ta !== tb) return ta.localeCompare(tb);
            return String(a.name || '').localeCompare(String(b.name || ''));
        });
        _exposedDevicesState = { slug: sourceSlug, devices: sorted };
        grid.className = 'flex flex-col gap-3';
        grid.innerHTML = '';
        const section = document.createElement('div');
        section.className = 'space-y-3';
        section.dataset.entryKey = '__all__';
        section.dataset.baseOffset = '0';
        grid.appendChild(section);
        _renderDevicesSection(
            section,
            { key: '__all__', title: '', devices: sorted },
            sourceSlug,
            0,
            { showEntryLabel },
        );
        return devices.length;
    } catch (err) {
        if (caption) caption.textContent = '';
        error.textContent = err.message || t('integrations.devices_load_error');
        error.classList.remove('hidden');
        return null;
    }
}

// ── HA-style config entries (multi-instance, declarative) ──────────────
let _entriesCurrent = { slug: null, schema: [], entries: [], supportsMultiple: false, label: '' };
const _syncingEntryIds = new Set();

function _integrationHasConfigSchema(integrationId) {
    const def = _integrationDefinition(integrationId);
    return !!def?.has_config_schema;
}

function _showIntegrationSchemaLoadError(slug, message) {
    const generic = document.getElementById('integration-panel-generic');
    const desc = document.getElementById('integration-generic-description');
    if (generic) generic.classList.remove('hidden');
    if (desc) {
        desc.textContent = message;
        desc.classList.remove('hidden');
    }
    if (typeof showToast === 'function') {
        showToast(message, 'error', 4500);
    }
    console.warn(`[integrations] schema load failed for ${slug}:`, message);
}

async function loadIntegrationConfigEntries(slug) {
    const section = document.getElementById('integration-entries-section');
    if (!section) return;
    if (!_integrationHasConfigSchema(slug)) {
        section.classList.add('hidden');
        return;
    }
    const desc = document.getElementById('integration-generic-description');
    if (desc) { desc.textContent = ''; desc.classList.add('hidden'); }
    let payload = null;
    try {
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/schema`);
        if (!res.ok) {
            const o = await res.json().catch(() => ({}));
            const detail = o.detail || o.message || `HTTP ${res.status}`;
            section.classList.add('hidden');
            if (res.status === 404) {
                _showIntegrationSchemaLoadError(
                    slug,
                    t('integrations.config_provider_missing', { slug }),
                );
            } else {
                _showIntegrationSchemaLoadError(slug, t('integrations.config_load_failed', { detail }));
            }
            return;
        }
        payload = await res.json();
    } catch (err) {
        section.classList.add('hidden');
        _showIntegrationSchemaLoadError(slug, err?.message || t('integrations.schema_load_network'));
        return;
    }
    if (!payload || !Array.isArray(payload.schema) || payload.schema.length === 0) {
        // Provider has no declarative schema → keep legacy/custom panel only.
        section.classList.add('hidden');
        return;
    }
    _entriesCurrent = {
        slug,
        schema: payload.schema,
        entries: payload.entries || [],
        supportsMultiple: !!payload.supports_multiple,
        label: payload.label || slug,
    };
    section.classList.remove('hidden');
    // Hide the legacy generic panel entirely — the entries section + the
    // shared Dispozitive section now cover everything.
    const generic = document.getElementById('integration-panel-generic');
    if (generic) generic.classList.add('hidden');
    // Also hide any hand-authored legacy panel for this slug — once an
    // integration declares CONFIG_SCHEMA, the entries flow IS the UI.
    // Keeps every integration looking identical (HA-style).
    document.querySelectorAll('[id^="integration-panel-"]').forEach(p => {
        if (p.id !== 'integration-panel-generic') p.classList.add('hidden');
    });
    const addBtn = document.getElementById('integration-entries-add-btn');
    if (addBtn) {
        const disable = !_entriesCurrent.supportsMultiple && _entriesCurrent.entries.length > 0;
        addBtn.disabled = disable;
        addBtn.classList.toggle('opacity-40', disable);
        addBtn.title = disable ? t('integrations.single_entry_only') : '';
        addBtn.onclick = () => openEntryEditor(null);
    }
    // Hide the generic "no settings" hint — the entries section IS the settings UI.
    const hint = document.getElementById('integration-generic-empty-hint');
    if (hint) hint.classList.add('hidden');
    _renderEntriesList();
}

function _renderEntriesList() {
    const list = document.getElementById('integration-entries-list');
    const empty = document.getElementById('integration-entries-empty');
    if (!list) return;
    list.innerHTML = '';
    if (!_entriesCurrent.entries.length) {
        if (empty) empty.classList.remove('hidden');
        return;
    }
    if (empty) empty.classList.add('hidden');
    _entriesCurrent.entries.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'flex items-center justify-between gap-2 bg-white/[0.03] border border-white/5 rounded-lg p-2.5';
        row.dataset.entryId = entry.entry_id;
        const enabled = entry.enabled !== false;
        const isSyncing = _syncingEntryIds.has(entry.entry_id);
        const syncBadge = isSyncing
            ? `<span class="inline-flex items-center gap-1 text-[10px] text-amber-400/80 animate-pulse"><i class="fas fa-spinner fa-spin text-[8px]"></i> ${escapeHtml(t('integrations.syncing_badge'))}</span>`
            : '';
        const statusText = enabled ? '' : '· dezactivat';
        row.innerHTML = `
            <div class="min-w-0 flex-1">
                <div class="text-[12px] font-semibold text-slate-100 truncate">${escapeHtml(entry.title || _entriesCurrent.label)}</div>
                <div class="text-[10px] text-slate-500 mono truncate flex items-center gap-2">${escapeHtml(entry.entry_id.slice(0,8))} ${statusText} ${syncBadge}</div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                <button type="button" data-act="edit" class="px-2 py-1 rounded text-[10px] bg-white/5 hover:bg-white/10 text-slate-300" title="${escapeHtml(t('common.edit'))}"><i class="fas fa-pen"></i></button>
                <button type="button" data-act="delete" class="px-2 py-1 rounded text-[10px] bg-red-500/10 hover:bg-red-500/20 text-red-300" title="${escapeHtml(t('common.delete'))}"><i class="fas fa-trash"></i></button>
            </div>`;
        row.querySelector('[data-act="edit"]').onclick = () => openEntryEditor(entry);
        row.querySelector('[data-act="delete"]').onclick = async () => {
            if (!await showConfirm(t('integrations.entry_delete_config_confirm', { title: entry.title }))) return;
            try {
                const slug = _entriesCurrent.slug;
                const r = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/entries/${encodeURIComponent(entry.entry_id)}`, { method: 'DELETE' });
                if (!r.ok) { const o = await r.json().catch(() => ({})); throw new Error(translateApiDetail(o.detail) || t('integrations.delete_error')); }
                await loadIntegrationConfigEntries(slug);
                try { await loadIntegrationExposedEntities(slug); } catch (_) {}
                if (typeof showToast === 'function') showToast(t('hy.deleted'), 'success', 1800);
            } catch (e) {
                if (typeof showToast === 'function') showToast(e.message || t('common.error'), 'error', 2500);
            }
        };
        list.appendChild(row);
    });
}

function _pollForEntities(slug, attempts = 0, syncingEntryId = null) {
    const maxAttempts = 8;
    const delays = [1500, 2500, 3000, 4000, 5000, 7000, 10000, 15000];
    const grid = document.getElementById('integration-exposed-entities-grid');
    if (grid && attempts === 0) {
        grid.innerHTML = `<div class="flex items-center gap-2 text-slate-400 text-xs py-4 px-2">
            <i class="fas fa-spinner fa-spin"></i>
            <span>${escapeHtml(t('integrations.syncing_devices'))}</span>
        </div>`;
    }
    loadIntegrationExposedEntities(slug).then(count => {
        if (count > 0) {
            _clearSyncingState(syncingEntryId);
            return;
        }
        if (attempts < maxAttempts) {
            const delay = delays[Math.min(attempts, delays.length - 1)];
            setTimeout(() => _pollForEntities(slug, attempts + 1, syncingEntryId), delay);
        } else {
            _clearSyncingState(syncingEntryId);
            if (grid) grid.innerHTML = `<div class="text-slate-500 text-xs py-4 px-2">${escapeHtml(t('integrations.no_devices_yet'))}</div>`;
        }
    }).catch(() => {
        if (attempts < maxAttempts) {
            const delay = delays[Math.min(attempts, delays.length - 1)];
            setTimeout(() => _pollForEntities(slug, attempts + 1, syncingEntryId), delay);
        } else {
            _clearSyncingState(syncingEntryId);
        }
    });
}

function _clearSyncingState(entryId) {
    if (!entryId) return;
    _syncingEntryIds.delete(entryId);
    const row = document.querySelector(`[data-entry-id="${CSS.escape(entryId)}"]`);
    if (row) {
        const badge = row.querySelector('.animate-pulse');
        if (badge) badge.remove();
    }
}

function openEntryEditor(entry) {
    const modal = document.getElementById('integration-entry-modal');
    const titleEl = document.getElementById('integration-entry-modal-title');
    const fieldsEl = document.getElementById('integration-entry-fields');
    const errEl = document.getElementById('integration-entry-error');
    const titleInput = document.querySelector('#integration-entry-form input[name="__title__"]');
    if (!modal || !fieldsEl || !titleInput) return;
    errEl.classList.add('hidden'); errEl.textContent = '';
    titleEl.textContent = entry ? t('integrations.entry_edit_title', { title: entry.title }) : t('integrations.entry_add_title', { label: _entriesCurrent.label });
    titleInput.value = entry?.title || '';
    fieldsEl.innerHTML = '';
    const data = entry?.data || {};
    _entriesCurrent.schema.forEach(field => {
        const wrap = document.createElement('div');
        const id = `entry_field_${field.key}`;
        const required = field.required ? '<span class="text-red-400">*</span>' : '';
        const help = field.help ? `<div class="text-[10px] text-slate-500 mt-1">${escapeHtml(field.help)}</div>` : '';
        let input = '';
        const value = data[field.key] !== undefined ? data[field.key] : (field.default !== undefined ? field.default : '');
        const placeholder = field.placeholder ? `placeholder="${escapeHtml(field.placeholder)}"` : '';
        if (field.type === 'link') {
            const href = escapeHtmlAttr(field.url || '#');
            input = `<a href="${href}" target="_blank" rel="noopener noreferrer"
                class="w-full flex items-center justify-center gap-2 bg-accent/15 border border-accent/40 text-accent rounded-lg px-3 py-2.5 text-sm font-semibold hover:bg-accent/25 transition-colors no-underline">
                <i class="fas fa-arrow-up-right-from-square"></i> <span>Deschide pagina Xiaomi</span>
            </a>`;
        } else if (field.type === 'select' && Array.isArray(field.options)) {
            const opts = field.options.map(o => `<option value="${escapeHtml(o.value)}" ${String(o.value)===String(value)?'selected':''}>${escapeHtml(o.label)}</option>`).join('');
            input = `<select id="${id}" name="${field.key}" class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-accent outline-none">${opts}</select>`;
        } else if (field.type === 'bool') {
            input = `<label class="flex items-center gap-2 text-sm text-slate-200"><input type="checkbox" id="${id}" name="${field.key}" ${value?'checked':''} class="accent-accent"> <span>${escapeHtml(field.label || field.key)}</span></label>`;
        } else {
            const t = field.type === 'number' ? 'number' : (field.type === 'password' ? 'password' : (field.type === 'url' ? 'url' : 'text'));
            const minAttr = field.min != null ? ` min="${escapeHtmlAttr(field.min)}"` : '';
            const maxAttr = field.max != null ? ` max="${escapeHtmlAttr(field.max)}"` : '';
            input = `<input type="${t}" id="${id}" name="${field.key}"${minAttr}${maxAttr} ${placeholder} value="${escapeHtml(value)}" class="w-full bg-slate-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-100 focus:border-accent outline-none">`;
        }
        if (field.type === 'bool') {
            wrap.innerHTML = input;
        } else {
            wrap.innerHTML = `<label class="block text-[10px] font-semibold text-slate-400 uppercase mb-1">${escapeHtml(field.label || field.key)} ${required}</label>${input}${help}`;
        }
        fieldsEl.appendChild(wrap);
    });
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    const close = () => { modal.classList.add('hidden'); modal.classList.remove('flex'); };
    document.getElementById('integration-entry-modal-close').onclick = close;
    document.getElementById('integration-entry-cancel').onclick = close;
    // Helper: collect form data, skipping masked secrets when editing.
    const collectData = () => {
        const out = {};
        for (const field of _entriesCurrent.schema) {
            if (field.type === 'oauth' || field.type === 'link') continue;
            const el = document.getElementById(`entry_field_${field.key}`);
            if (!el) continue;
            let v;
            if (field.type === 'bool') v = !!el.checked;
            else if (field.type === 'number') v = el.value === '' ? null : Number(el.value);
            else v = el.value;
            if (entry && field.secret && typeof v === 'string' && /^[•*]+$/.test(v)) continue;
            out[field.key] = v;
        }
        return out;
    };

    // Test connection — runs the provider's ``async_test_connection`` against
    // the unsaved form data. Does NOT persist the entry.
    const testBtn = document.getElementById('integration-entry-test');
    if (testBtn) {
        testBtn.onclick = async () => {
            errEl.classList.add('hidden'); errEl.textContent = '';
            const orig = testBtn.innerHTML;
            testBtn.disabled = true;
            testBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(t('integrations.test_connecting'))}`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 45000);
            try {
                const r = await apiCall(`/api/integrations/${encodeURIComponent(_entriesCurrent.slug)}/entries/test`, {
                    method: 'POST', headers: {'Content-Type':'application/json'},
                    body: JSON.stringify({ data: collectData(), entry_id: entry?.entry_id || null }),
                    signal: controller.signal,
                });
                const o = await r.json().catch(() => ({}));
                if (r.ok && o.ok) {
                    if (typeof showToast === 'function') showToast(integrationApiMessage(o) || t('integrations.connection_ok'), 'success', 2200);
                } else {
                    errEl.textContent = integrationApiMessage(o) || t('integrations.test_failed');
                    errEl.classList.remove('hidden');
                }
            } catch (e) {
                errEl.textContent = e.name === 'AbortError'
                    ? t('integrations.test_timeout')
                    : (e.message || t('common.error'));
                errEl.classList.remove('hidden');
            } finally {
                clearTimeout(timeoutId);
                testBtn.disabled = false;
                testBtn.innerHTML = orig;
            }
        };
    }

    document.getElementById('integration-entry-save').onclick = async () => {
        const saveBtn = document.getElementById('integration-entry-save');
        const payload = { title: (titleInput.value || '').trim() || _entriesCurrent.label, data: collectData() };
        const isCreate = !entry;
        const slug = _entriesCurrent.slug;
        // Disable save button to prevent double-clicks
        if (saveBtn) { saveBtn.disabled = true; saveBtn.classList.add('opacity-50'); }
        try {
            const url = entry
                ? `/api/integrations/${encodeURIComponent(slug)}/entries/${encodeURIComponent(entry.entry_id)}`
                : `/api/integrations/${encodeURIComponent(slug)}/entries`;
            const r = await apiCall(url, { method: entry ? 'PATCH' : 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
            const o = await r.json().catch(() => ({}));
            if (!r.ok) {
                errEl.textContent = translateApiDetail(o.detail) || translateApiDetail(o.errors) || t('integrations.save_error');
                errEl.classList.remove('hidden');
                return;
            }
            // Close modal immediately — entry is saved, sync runs in background
            close();
            if (typeof showToast === 'function') showToast(t('hy.saved'), 'success', 1800);
            // Mark entry as syncing so the row shows a loading indicator
            const savedEntryId = o.entry?.entry_id;
            if (savedEntryId) _syncingEntryIds.add(savedEntryId);
            // Refresh the entries list right away (entry already persisted, shows syncing badge)
            await loadIntegrationConfigEntries(slug);
            // Poll for entities — clears syncing state when done
            _pollForEntities(slug, 0, savedEntryId);
        } catch (e) {
            errEl.textContent = e.message || t('common.error'); errEl.classList.remove('hidden');
        } finally {
            if (saveBtn) { saveBtn.disabled = false; saveBtn.classList.remove('opacity-50'); }
        }
    };
}

// ── OAuth connect flow (Xiaomi Home & future OAuth providers) ──────────
// Opens the provider's auth page in a popup, then polls the provider's status
// endpoint until the server-side redirect callback has captured the code and
// created the config entry. No copy/paste, no homeassistant.local.
async function _runOAuthConnect(field, btn, errEl, closeModal) {
    const slug = _entriesCurrent.slug;
    const labelEl = btn.querySelector('[data-oauth-label]');
    const statusEl = btn.parentElement.querySelector('[data-oauth-status]');
    const origLabel = labelEl ? labelEl.textContent : '';
    const setBusy = (txt) => { if (labelEl) labelEl.textContent = txt; btn.disabled = true; };
    const reset = () => { if (labelEl) labelEl.textContent = origLabel; btn.disabled = false; };
    if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }

    // Build the start URL with declared form params (e.g. cloud_server).
    const qs = new URLSearchParams();
    (field.params || []).forEach(key => {
        const el = document.getElementById(`entry_field_${key}`);
        if (el && el.value !== undefined) qs.set(key, el.value);
    });
    setBusy(t('integrations.oauth_opening'));
    let state;
    let popup;
    try {
        // Open the popup synchronously (inside the click) to avoid blockers.
        popup = window.open('about:blank', 'xiaomi_oauth', 'width=480,height=720');
        const r = await apiCall(`${field.start}?${qs.toString()}`);
        const o = await r.json().catch(() => ({}));
        if (!r.ok || !o.auth_url) {
            if (popup) popup.close();
            throw new Error(o.detail || t('integrations.oauth_start_failed'));
        }
        state = o.state;
        if (popup) popup.location.href = o.auth_url;
        else window.open(o.auth_url, '_blank');
    } catch (e) {
        reset();
        if (errEl) { errEl.textContent = e.message || t('common.error'); errEl.classList.remove('hidden'); }
        return;
    }

    setBusy(t('integrations.oauth_waiting'));
    const deadline = Date.now() + 5 * 60 * 1000;
    const poll = async () => {
        if (Date.now() > deadline) {
            reset();
            if (errEl) { errEl.textContent = t('integrations.oauth_expired'); errEl.classList.remove('hidden'); }
            return;
        }
        try {
            const r = await apiCall(`${field.status}?state=${encodeURIComponent(state)}`);
            const o = await r.json().catch(() => ({}));
            if (o.status === 'completed') {
                if (statusEl) statusEl.innerHTML = `<span class="text-[11px] text-emerald-400 font-semibold"><i class="fas fa-check-circle mr-1"></i>${escapeHtml(t('integrations.oauth_connected'))}</span>`;
                if (typeof showToast === 'function') showToast(t('hy.xiaomi_connected'), 'success', 2200);
                try { if (popup && !popup.closed) popup.close(); } catch (_) {}
                if (typeof closeModal === 'function') closeModal();
                if (o.entry_id) _syncingEntryIds.add(o.entry_id);
                await loadIntegrationConfigEntries(slug);
                _pollForEntities(slug, 0, o.entry_id);
                return;
            }
            if (o.status === 'error' || o.status === 'expired') {
                reset();
                if (errEl) { errEl.textContent = o.error || t('integrations.oauth_auth_failed'); errEl.classList.remove('hidden'); }
                return;
            }
        } catch (_) { /* keep polling */ }
        setTimeout(poll, 2000);
    };
    setTimeout(poll, 2500);
}

// ── Device modal (shared across integrations) ──────────────────────────
function _entityIcon(eid, domain) {
    const dom = String(domain || String(eid || '').split('.')[0] || '').toLowerCase();
    return getDomainIcon(dom);
}

function _intCtrlAttrs(slug, eid, action, payload = null, { stop = false } = {}) {
    const payloadAttr = payload != null ? ` data-int-payload="${escapeHtmlAttr(JSON.stringify(payload))}"` : '';
    const stopAttr = stop ? ' data-entity-stop="1"' : '';
    return `data-entity-action="control" data-int-slug="${escapeHtmlAttr(slug)}" data-int-entity-id="${escapeHtmlAttr(eid)}" data-int-cmd="${escapeHtmlAttr(action)}"${payloadAttr}${stopAttr}`;
}

function _renderEntityControlRow(ent, slug) {
    const eid = ent.entity_id || '';
    const name = escapeHtml(ent.name || ent.friendly_name || eid);
    const dom = String(ent.domain || String(eid).split('.')[0] || '').toLowerCase();
    const state = ent.state == null || ent.state === '' ? 'unknown' : String(ent.state);
    const unit = ent.unit ? ` ${escapeHtml(String(ent.unit))}` : '';
    const lower = state.toLowerCase();
    const isOn = ACTIVE_STATES.includes(lower);
    const isOff = ['off', 'closed', 'locked', 'idle', 'docked', 'paused'].includes(lower);
    const tone = isOn ? 'text-accent' : (isOff ? 'text-slate-400' : 'text-slate-200');
    const icon = _entityIcon(eid, dom);
    const eidA = escapeHtmlAttr(eid);
    const sA = escapeHtmlAttr(slug);

    let control = '';
    const caps = ((ent.attributes || {}).capabilities) || {};
    const controllable = ent.controllable !== false && CONTROLLABLE.includes(dom);
    if (controllable && (dom === 'switch' || dom === 'light' || dom === 'input_boolean' || dom === 'fan' || dom === 'humidifier' || dom === 'water_heater' || dom === 'climate')) {
        const action = isOn ? 'turn_off' : 'turn_on';
        control = `<button type="button" role="switch" aria-checked="${isOn}"
            class="px-3 py-1.5 rounded-full text-[11px] font-bold border transition-colors shrink-0 ${isOn ? 'bg-accent/20 border-accent/40 text-accent' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}"
            ${_intCtrlAttrs(slug, eid, action, null, { stop: true })}>
            ${isOn ? escapeHtml(tState('on')).toUpperCase() : escapeHtml(tState('off')).toUpperCase()}
        </button>`;
    } else if (controllable && (dom === 'cover' || dom === 'lock')) {
        const action = isOn ? (dom === 'lock' ? 'lock' : 'close_cover') : (dom === 'lock' ? 'unlock' : 'open_cover');
        control = `<button type="button"
            class="px-3 py-1.5 rounded-full text-[11px] font-bold border bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 shrink-0"
            ${_intCtrlAttrs(slug, eid, action, null, { stop: true })}>
            ${escapeHtml(action.replace('_', ' '))}
        </button>`;
    } else if (controllable && dom === 'vacuum') {
        const stateLbl = tState(lower);
        const vBtn = (vacAction, ic, title) => `<button type="button" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"
            class="w-8 h-8 rounded-full border bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-accent shrink-0 flex items-center justify-center transition-colors"
            ${_intCtrlAttrs(slug, eid, vacAction, null, { stop: true })}>
            <i class="fas ${ic} text-[11px]"></i>
        </button>`;
        control = `<div class="flex items-center gap-1.5 shrink-0">
            <span class="text-[10px] mono ${tone} mr-0.5">${escapeHtml(stateLbl)}</span>
            ${vBtn('start', 'fa-play', t('entity.render.vacuum_start'))}
            ${vBtn('stop', 'fa-stop', t('entity.render.vacuum_stop'))}
            ${vBtn('return_to_base', 'fa-house', t('entity.render.vacuum_dock'))}
        </div>`;
    } else if (dom === 'number' && Number.isFinite(Number(ent.state))) {
        const min = caps.min ?? 0, max = caps.max ?? 100, step = caps.step ?? 1;
        const val = Number(ent.state);
        control = `<input type="range" min="${min}" max="${max}" step="${step}" value="${val}"
            class="w-24 md:w-32 shrink-0 accent-accent"
            ${_intCtrlAttrs(slug, eid, 'set')} data-int-input="valueFloat" data-entity-stop="1">`;
    } else if (dom === 'select' && Array.isArray(caps.options) && caps.options.length) {
        control = `<select class="bg-white/5 border border-white/10 rounded-lg text-[11px] text-slate-200 px-2 py-1.5 shrink-0"
            ${_intCtrlAttrs(slug, eid, 'set')} data-int-input="valueString" data-entity-stop="1">
            ${caps.options.map(o => {
                const v = (o && typeof o === 'object') ? String(o.value ?? o.label ?? '') : String(o);
                const lbl = (o && typeof o === 'object') ? String(o.label ?? o.value ?? '') : String(o);
                return `<option value="${escapeHtmlAttr(v)}" ${v.toLowerCase() === lower ? 'selected' : ''}>${escapeHtml(lbl)}</option>`;
            }).join('')}
        </select>`;
    }

    const encoded = encodeURIComponent(JSON.stringify(ent)).replace(/'/g, '%27');
    return `<div class="flex items-center gap-3 px-3 py-3 bg-white/[0.03] border border-white/5 rounded-xl cursor-pointer hover:bg-white/[0.06] hover:border-accent/20 transition-colors"
        data-entity-action="openCard" data-int-encoded="${encoded}">
        <i class="fas ${icon} text-accent/70 text-sm w-4 text-center shrink-0"></i>
        <div class="min-w-0 flex-1">
            <div class="text-[12px] font-semibold text-slate-100 fade-edge-r">${name}</div>
            <div class="text-[10px] text-slate-500 mono fade-edge-r">${escapeHtml(eid)}</div>
        </div>
        ${control
            ? ''
            : `<span class="text-[11px] mono ${tone} truncate max-w-[9rem] text-right shrink-0" data-entity-state="${eidA}">${escapeHtml(state)}${unit}</span>`}
        ${control}
    </div>`;
}

// Pagination for the entity list inside the device-detail modal.
const _ENTITY_PAGE_SIZE = 5;
const _entityPageState = new Map(); // key: `${slug}::${deviceId}` -> page index (0-based)

function _entityPageKey(slug, deviceId) { return `${slug}::${deviceId}`; }

function _renderPaginatedEntityList(ents, slug, deviceId) {
    const total = ents.length;
    const pageSize = _ENTITY_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const key = _entityPageKey(slug, deviceId);
    let page = _entityPageState.get(key) || 0;
    if (page >= pages) page = pages - 1;
    if (page < 0) page = 0;
    _entityPageState.set(key, page);

    const start = page * pageSize;
    const slice = ents.slice(start, start + pageSize);
    const rows = `<div class="space-y-2" data-entity-list>${slice.map(e => _renderEntityControlRow(e, slug)).join('')}</div>`;

    if (pages <= 1) return rows;

    const sA = escapeHtmlAttr(slug);
    const dA = escapeHtmlAttr(deviceId);
    const prevDisabled = page === 0;
    const nextDisabled = page >= pages - 1;
    const pager = `
    <div class="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-white/5" data-entity-pager>
        <button type="button" data-entity-page-prev
            ${prevDisabled ? 'disabled' : ''}
            class="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:cursor-not-allowed">
            <i class="fas fa-chevron-left mr-1"></i>${escapeHtml(t('common.prev'))}
        </button>
        <span class="text-[11px] text-slate-500 mono">${escapeHtml(t('integrations.entities_pager', { page: page + 1, pages, count: total }))}</span>
        <button type="button" data-entity-page-next
            ${nextDisabled ? 'disabled' : ''}
            data-slug="${sA}" data-device="${dA}"
            class="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:cursor-not-allowed">
            ${escapeHtml(t('common.next'))}<i class="fas fa-chevron-right ml-1"></i>
        </button>
    </div>`;
    return rows + pager;
}

function _wireEntityListPagination(body, ents, slug, deviceId) {
    const key = _entityPageKey(slug, deviceId);
    const pages = Math.max(1, Math.ceil(ents.length / _ENTITY_PAGE_SIZE));
    const rerender = () => {
        const list = _renderPaginatedEntityList(ents, slug, deviceId);
        const oldList = body.querySelector('[data-entity-list]');
        const oldPager = body.querySelector('[data-entity-pager]');
        if (oldPager) oldPager.remove();
        if (oldList) {
            const wrap = document.createElement('div');
            wrap.innerHTML = list;
            oldList.replaceWith(...wrap.childNodes);
        }
        _wireEntityListPagination(body, ents, slug, deviceId);
    };
    const prev = body.querySelector('[data-entity-page-prev]');
    const next = body.querySelector('[data-entity-page-next]');
    if (prev) prev.onclick = () => {
        const p = (_entityPageState.get(key) || 0) - 1;
        _entityPageState.set(key, Math.max(0, p));
        rerender();
    };
    if (next) next.onclick = () => {
        const p = (_entityPageState.get(key) || 0) + 1;
        _entityPageState.set(key, Math.min(pages - 1, p));
        rerender();
    };
}

function _openIntegrationEntityDetailModal(entity, slug) {
    const modal = document.getElementById('entity-detail-modal');
    const iconEl = document.getElementById('entity-detail-modal-icon');
    const labelEl = document.getElementById('entity-detail-modal-label');
    const body = document.getElementById('entity-detail-modal-body');
    if (!modal || !body || !entity) return;

    stopCameraPreviewRefresh();
    modal.querySelectorAll('hyve-camera-live-player').forEach(el => {
        try { el.pauseStream?.(); } catch (_) {}
    });

    const dom = String(entity.domain || String(entity.entity_id || '').split('.')[0] || '').toLowerCase();
    const dc = ((entity.attributes || {}).capabilities || {}).device_class || (entity.attributes || {}).device_class || '';
    const icon = getDomainIcon(dom, dc);
    if (iconEl) iconEl.className = `fas ${icon}`;
    if (labelEl) labelEl.textContent = entity.name || entity.entity_id || 'Entity';

    body.innerHTML = renderEntityModal(entity, slug || _exposedDevicesState?.slug || entity.source || '');
    if (modal.parentNode !== document.body) document.body.appendChild(modal);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    startCameraPreviewRefresh();
}

export function openIntegrationEntityCard(encoded) {
    let entity;
    try {
        entity = JSON.parse(decodeURIComponent(encoded));
    } catch (_) {
        return;
    }
    if (!entity || !entity.entity_id) return;
    _openIntegrationEntityDetailModal(entity, _exposedDevicesState?.slug || entity.source || '');
};

export function openIntegrationDeviceModal(idx, slug) {
    const state = _exposedDevicesState;
    if (!state || !integrationSlugsMatch(state.slug, slug)) return;
    const dev = state.devices[idx];
    if (!dev) return;
    const modal = document.getElementById('entity-detail-modal');
    const iconEl = document.getElementById('entity-detail-modal-icon');
    const labelEl = document.getElementById('entity-detail-modal-label');
    const body = document.getElementById('entity-detail-modal-body');
    if (!modal || !body) return;
    if (iconEl) iconEl.className = 'fas fa-microchip';
    if (labelEl) labelEl.textContent = t('common.device');

    const name = escapeHtml(dev.name || dev.device_id || (t('common.device')));
    const sub = [dev.model, dev.manufacturer].filter(Boolean).join(' · ');
    const ents = (dev.entities || []).slice().sort((a, b) => {
        const order = { switch: 0, light: 1, cover: 2, lock: 3, climate: 4, number: 5, select: 6, button: 7, binary_sensor: 8, sensor: 9 };
        const da = String(a.entity_id || '').split('.')[0];
        const db = String(b.entity_id || '').split('.')[0];
        const oa = order[da] ?? 99, ob = order[db] ?? 99;
        if (oa !== ob) return oa - ob;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });

    const sA = escapeHtmlAttr(slug);
    const didA = escapeHtmlAttr(dev.device_id || '');
    const curA = escapeHtmlAttr(dev.name || dev.device_id || '');

    const hero = `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-3 mb-3 flex items-start gap-3">
        <div class="w-10 h-10 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
            <i class="fas fa-microchip text-accent text-base"></i>
        </div>
        <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-[9px] uppercase tracking-widest text-slate-500">
                <span>Dispozitiv</span>
                <button type="button" id="entity-detail-rename-btn" class="hover:text-accent transition-colors" title="${escapeHtml(t('integrations.rename_device_title'))}">
                    <i class="fas fa-pen text-[10px]"></i>
                </button>
            </div>
            <div id="entity-detail-name-view" class="text-sm font-semibold text-slate-100 mt-0.5 break-words leading-snug">${name}</div>
            <div id="entity-detail-name-edit" class="hidden mt-1 flex items-center gap-2">
                <input type="text" id="entity-detail-name-input" value="${curA}"
                    class="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-accent/40">
                <button type="button" id="entity-detail-name-save" class="px-2 py-1 rounded-lg bg-accent/20 border border-accent/40 text-accent text-[11px] font-semibold hover:bg-accent/30 shrink-0">
                    <i class="fas fa-check"></i>
                </button>
                <button type="button" id="entity-detail-name-cancel" class="px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-[11px] hover:bg-white/10 shrink-0">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            ${sub ? `<div class="text-[10px] text-slate-500 break-words mt-0.5">${escapeHtml(sub)}</div>` : ''}
            <div class="text-[9px] text-slate-500 mono break-all mt-1 leading-snug">${escapeHtml(dev.device_id || '')}</div>
        </div>
        <div class="text-right shrink-0">
            <div class="text-lg font-semibold text-slate-200 mono leading-none">${ents.length}</div>
            <div class="text-[9px] uppercase tracking-wider text-slate-500 mt-0.5">${escapeHtml(t('integrations.entities_label'))}</div>
        </div>
    </div>`;
    const list = ents.length
        ? _renderPaginatedEntityList(ents, slug, dev.device_id || '')
        : `<div class="text-[11px] text-slate-500 text-center py-6">${escapeHtml(t('integrations.no_controls'))}</div>`;
    body.innerHTML = hero + list;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    _wireEntityListPagination(body, ents, slug, dev.device_id || '');

    // Wire inline rename UI
    const view = body.querySelector('#entity-detail-name-view');
    const edit = body.querySelector('#entity-detail-name-edit');
    const input = body.querySelector('#entity-detail-name-input');
    const renameBtn = body.querySelector('#entity-detail-rename-btn');
    const saveBtn = body.querySelector('#entity-detail-name-save');
    const cancelBtn = body.querySelector('#entity-detail-name-cancel');
    const showEdit = () => { view?.classList.add('hidden'); edit?.classList.remove('hidden'); input?.focus(); input?.select(); };
    const hideEdit = () => { edit?.classList.add('hidden'); view?.classList.remove('hidden'); };
    if (renameBtn) renameBtn.onclick = showEdit;
    if (cancelBtn) cancelBtn.onclick = hideEdit;
    const submit = () => renameIntegrationDevice(slug, dev.device_id || '', dev.name || dev.device_id || '', input?.value || '');
    if (saveBtn) saveBtn.onclick = submit;
    if (input) input.onkeydown = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); hideEdit(); }
    };
};

export async function controlIntegrationEntity(slug, entityId, action, btn, data) {
    if (btn) { btn.disabled = true; btn.dataset._prev = btn.innerHTML || ''; }
    // Optimistic local update so the UI reacts instantly without waiting for
    // the server to round-trip a full re-fetch.
    let prevState = null;
    let touchedEnt = null;
    let touchedIdx = -1;
    if (_exposedDevicesState.slug && integrationSlugsMatch(_exposedDevicesState.slug, slug)) {
        for (let i = 0; i < _exposedDevicesState.devices.length; i++) {
            const found = (_exposedDevicesState.devices[i].entities || []).find(e => e.entity_id === entityId);
            if (found) { touchedEnt = found; touchedIdx = i; break; }
        }
        if (touchedEnt) {
            prevState = touchedEnt.state;
            if (action === 'turn_on' || action === 'open_cover' || action === 'unlock') touchedEnt.state = 'on';
            else if (action === 'turn_off' || action === 'close_cover' || action === 'lock') touchedEnt.state = 'off';
            else if (action === 'set' && data && data.value !== undefined) touchedEnt.state = String(data.value);
            const modal = document.getElementById('entity-detail-modal');
            if (modal && !modal.classList.contains('hidden') && touchedIdx >= 0) {
                openIntegrationDeviceModal(touchedIdx, slug);
            }
        }
    }
    try {
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_id: entityId, action, data: data || {} }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.detail || out.message || t('integrations.action_failed'));
    } catch (err) {
        // Rollback optimistic update
        if (touchedEnt) {
            touchedEnt.state = prevState;
            const modal = document.getElementById('entity-detail-modal');
            if (modal && !modal.classList.contains('hidden') && touchedIdx >= 0) {
                openIntegrationDeviceModal(touchedIdx, slug);
            }
        }
        if (typeof showToast === 'function') showToast(err.message || t('common.error'), 'error', 2500);
    } finally {
        if (btn) { btn.disabled = false; }
    }
};

export async function renameIntegrationDevice(slug, deviceId, currentName, providedName) {
    let next = providedName;
    if (next == null) {
        next = window.prompt(t('integrations.device_rename_prompt'), currentName || '');
        if (next == null) return;
    }
    const trimmed = String(next).trim();
    if (!trimmed || trimmed === currentName) return;
    try {
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/device/${encodeURIComponent(deviceId)}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmed, current_name: currentName || deviceId }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.detail || out.message || t('integrations.device_rename_failed'));
        // Optimistic local update — no full re-fetch needed since the alias
        // is the source of truth and lives in our YAML.
        if (_exposedDevicesState.slug && integrationSlugsMatch(_exposedDevicesState.slug, slug)) {
            const idx = _exposedDevicesState.devices.findIndex(d => (d.device_id || '') === deviceId);
            if (idx >= 0) {
                _exposedDevicesState.devices[idx].name = trimmed;
                const grid = document.getElementById('integration-exposed-entities-grid');
                if (grid) grid.innerHTML = _exposedDevicesState.devices.map((d, i) => _devCardHtml(d, i, slug)).join('');
                const modal = document.getElementById('entity-detail-modal');
                if (modal && !modal.classList.contains('hidden')) {
                    openIntegrationDeviceModal(idx, slug);
                }
            }
        }
    } catch (err) {
        if (typeof showToast === 'function') showToast(err.message || t('common.error'), 'error', 3000);
    }
};

export function slugForId(s) {
    if (!s || typeof s !== 'string') return '';
    return s.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || '';
}

export function escapeHtmlAttr(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function addCctvCameraRow(camera) {
    const list = document.getElementById('cctv-cameras-list');
    if (!list) return;
    const name = (camera && camera.name) || '';
    const rtsp = (camera && camera.rtsp_url) || '';
    const context = (camera && camera.context) || '';
    const id = (camera && camera.id) || '';
    const ctxPlaceholder = t('config.cctv_camera_context');
    const row = document.createElement('div');
    row.className = 'cctv-camera-row flex flex-wrap gap-2 p-3 rounded-xl bg-slate-900/50 border border-white/5';
    row.innerHTML = `
        <input type="text" class="cctv-cam-name flex-1 min-w-[100px] bg-slate-900 border border-white/5 rounded-lg p-2 text-xs text-slate-300 focus:border-violet-400 outline-none" placeholder="${escapeHtmlAttr(t('config.cctv_camera_name'))}" value="${escapeHtmlAttr(name)}">
        <input type="text" class="cctv-cam-rtsp flex-1 min-w-[120px] bg-slate-900 border border-white/5 rounded-lg p-2 text-xs mono text-slate-400 focus:border-violet-400 outline-none" placeholder="rtsp://..." value="${escapeHtmlAttr(rtsp)}">
        <input type="text" class="cctv-cam-context w-full min-w-0 bg-slate-900 border border-white/5 rounded-lg p-2 text-xs text-slate-400 focus:border-violet-400 outline-none" placeholder="${escapeHtmlAttr(ctxPlaceholder)}" value="${escapeHtmlAttr(context)}" title="${escapeHtmlAttr(t('config.cctv_camera_context_hint'))}">
        <button type="button" class="cctv-cam-remove px-2 py-1.5 rounded-lg text-[10px] text-red-400 hover:bg-red-500/20 border border-red-500/20 shrink-0" data-i18n="common.delete">Delete</button>
    `;
    if (id) row.dataset.cctvId = id;
    list.appendChild(row);
    const removeBtn = row.querySelector('.cctv-cam-remove');
    if (removeBtn) removeBtn.addEventListener('click', () => row.remove());
}

export function renderCctvCameras(cameras) {
    const list = document.getElementById('cctv-cameras-list');
    if (!list) return;
    list.innerHTML = '';
    (cameras || []).forEach(cam => addCctvCameraRow(cam));
}
const INTEGRATION_MODAL_TITLES = { ha: 'config.ha_section', searxng: 'config.searxng_section', waha: 'config.waha_section', cctv: 'config.cctv_section', whisper: 'config.whisper_section', comfyui: 'config.comfyui_section', piper: 'config.piper_section', pago: 'config.pago_section', fusion_solar: 'config.fusion_solar_section' };
const INTEGRATION_MODAL_ICONS  = { ha: 'fa-house-signal', searxng: 'fa-magnifying-glass', waha: 'fa-brands fa-whatsapp', cctv: 'fa-video', whisper: 'fa-microphone', comfyui: 'fa-palette', piper: 'fa-volume-up', pago: 'fa-file-invoice-dollar', fusion_solar: 'fa-solar-panel' };
const INTEGRATION_MODAL_IMAGES = {
    waha: '/static/icons/integrations/waha.png',
    searxng: '/static/icons/integrations/searxng.png',
    comfyui: '/static/icons/integrations/comfyui.avif',
    whisper: '/static/icons/integrations/whisper.png',
    piper: '/static/icons/integrations/piper.webp',
    fusion_solar: '/static/icons/integrations/fusion_solar.png',
    open_meteo: '/static/icons/integrations/open_meteo.png',
    pago: '/static/icons/integrations/pago.png',
    eon_romania: '/static/icons/integrations/eon_romania.png',
    reteleelectrice: '/static/icons/integrations/reteleelectrice.jpg',
    reolink: '/static/icons/integrations/reolink.jpg',
    tapo: '/static/icons/integrations/tapo.png',
    midea_ac: '/static/icons/integrations/midea_ac.png',
    ariston_net: '/static/icons/integrations/ariston_net.svg',
    mosquitto: '/static/icons/integrations/mosquitto.png',
};

export async function openIntegrationConfigModal(integrationId) {
    const modal = document.getElementById('integration-config-modal');
    const titleEl = document.getElementById('integration-config-modal-title');
    const iconEl = document.getElementById('integration-config-modal-icon');
    const logoEl = document.getElementById('integration-config-modal-logo');
    if (!modal || !titleEl) return;
    document.querySelectorAll('[id^="integration-panel-"]').forEach(panel => {
        panel.classList.add('hidden');
    });
    // Hide the shared "emitted entities" section between opens; it is
    // re-shown at the end of this function for any integration that exposes
    // entities through the catalog.
    const exposedSection = document.getElementById('integration-exposed-entities-section');
    if (exposedSection) exposedSection.classList.add('hidden');
    const entriesSection = document.getElementById('integration-entries-section');
    if (entriesSection) entriesSection.classList.add('hidden');

    // Make sure catalog metadata is available so we can resolve the panel id,
    // title, icon and fall back to the generic panel for new integrations.
    try { await loadIntegrationCatalog(false); } catch (_) {}
    const meta = _integrationDefinition(integrationId) || null;
    const catalogSlug = _integrationCatalogSlug(integrationId);
    const resolvedPanelId = meta?.config_panel_id || catalogSlug;
    const panel = document.getElementById(`integration-panel-${resolvedPanelId}`)
        || document.getElementById(`integration-panel-${integrationId}`);
    if (panel) {
        panel.classList.remove('hidden');
    } else {
        // Generic fallback — shown when an integration has no hand-authored
        // config block. Keeps new integrations self-serve per
        // docs/CARDS_AND_INTEGRATIONS.md.
        const generic = document.getElementById('integration-panel-generic');
        if (generic) {
            generic.classList.remove('hidden');
            const descEl = document.getElementById('integration-generic-description');
            if (descEl) {
                const desc = String(meta?.description || '').trim();
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
                        try { await loadIntegrationExposedEntities(catalogSlug); } catch (_) {}
                    };
                } else {
                    syncBtn.classList.remove('flex');
                    syncBtn.onclick = null;
                }
            }
        }
    }
    const titleKey = INTEGRATION_MODAL_TITLES[integrationId];
    const resolvedTitle = (titleKey ? t(titleKey) : '') || _integrationLabel(meta) || integrationId;
    const icon = INTEGRATION_MODAL_ICONS[integrationId]
        || _normalizeIntegrationIcon(meta?.icon || 'fa-plug');
    const logo = String(meta?.image || INTEGRATION_MODAL_IMAGES[integrationId] || '').trim();
    titleEl.textContent = resolvedTitle;
    if (logoEl) {
        logoEl.classList.toggle('hidden', !logo);
        logoEl.style.display = logo ? '' : 'none';
        logoEl.src = logo || '';
        logoEl.alt = logo ? resolvedTitle : '';
        logoEl.onerror = () => {
            logoEl.classList.add('hidden');
            logoEl.style.display = 'none';
            if (iconEl) iconEl.classList.remove('hidden');
            if (iconEl) iconEl.style.display = '';
        };
    }
    if (iconEl) {
        iconEl.className = `fas ${icon}`;
        iconEl.classList.toggle('hidden', !!logo);
        iconEl.style.display = logo ? 'none' : '';
    }
    openSubPage('integration-config-modal');

    // Always re-fetch config so fields reflect stored values
    let cfg = null;
    try {
        const cfgRes = await apiCall('/api/config');
        if (cfgRes.ok) cfg = await cfgRes.json();
    } catch (_) {}

    if (integrationId === 'ha') {
        const origin = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : '';
        const keyEl = document.getElementById('assist_api_key');
        if (keyEl) keyEl.value = '';
        try {
            const res = await apiCall('/api/assist-key');
            if (res.ok) {
                const data = await res.json();
                if (keyEl && data.assist_api_key) keyEl.value = data.assist_api_key;
                const ollamaUserUrlEl = document.getElementById('assist_ollama_user_url');
                if (ollamaUserUrlEl && data.assist_api_key && origin) ollamaUserUrlEl.value = origin + '/ollama/user/' + data.assist_api_key;
            }
        } catch (_) {}
        const ollamaUserUrlEl = document.getElementById('assist_ollama_user_url');
        if (ollamaUserUrlEl && !ollamaUserUrlEl.value && origin) ollamaUserUrlEl.value = '';
        // Load exposed entities summary
        _loadExposedEntitiesSummary();
    }
    if (integrationId === 'waha') {
        if (cfg) {
            const wahaCfg = cfg.waha || {};
            const wahaUrl = document.getElementById('waha_url');
            const wlNumbers = document.getElementById('wl_numbers');
            if (wahaUrl) wahaUrl.value = wahaCfg.url || '';
            if (wlNumbers && wahaCfg.allowed_numbers) wlNumbers.value = (wahaCfg.allowed_numbers || []).join('\n');
        }
        const wh = document.getElementById('waha_webhook');
        if (wh && typeof window !== 'undefined' && window.location?.origin) {
            wh.value = window.location.origin + '/api/webhook/waha';
        }
    }
    if (integrationId === 'searxng' && cfg) {
        const sx = cfg.searxng || {};
        const sxUrl = document.getElementById('searxng_url');
        if (sxUrl) sxUrl.value = sx.url || '';
    }
    if (integrationId === 'comfyui') {
        if (cfg) {
            const c = cfg.comfyui || {};
            const fields = {
                'comfyui_url': c.url || 'http://localhost:8188',
                'comfyui_steps': c.default_steps ?? 20,
                'comfyui_cfg': c.default_cfg_scale ?? 7,
                'comfyui_width': c.default_width ?? 1024,
                'comfyui_height': c.default_height ?? 1024,
                'comfyui_sampler': c.default_sampler || 'euler',
                'comfyui_scheduler': c.default_scheduler || 'normal',
                'comfyui_timeout': c.timeout ?? 120,
                'comfyui_negative': c.default_negative_prompt || '',
            };
            for (const [id, val] of Object.entries(fields)) {
                const el = document.getElementById(id);
                if (el) el.value = val;
            }
            // Refresh checkpoint & workflow selects, then set stored values
            const storedCheckpoint = c.default_checkpoint || '';
            const storedWorkflow = c.workflow_file || '';
            try {
                await refreshComfyUICheckpoints();
                const ckptEl = document.getElementById('comfyui_checkpoint');
                if (ckptEl && storedCheckpoint) ckptEl.value = storedCheckpoint;
            } catch (_) {}
            try {
                await refreshComfyUIWorkflows();
                const wfEl = document.getElementById('comfyui_workflow_file');
                if (wfEl && storedWorkflow) wfEl.value = storedWorkflow;
            } catch (_) {}
        }
    }
    if (integrationId === 'cctv' && cfg) {
        const cctvCfg = cfg.cctv || {};
        renderCctvCameras(cctvCfg.cameras || []);
    }
    if (integrationId === 'whisper' && cfg) {
        const w = cfg.whisper || {};
        const wHost = document.getElementById('whisper_host');
        const wPort = document.getElementById('whisper_port');
        const wLang = document.getElementById('whisper_language');
        if (wHost) wHost.value = w.host || 'localhost';
        if (wPort) wPort.value = w.port || 10300;
        if (wLang) wLang.value = w.language || 'ro';
        const wVadMs = document.getElementById('whisper_vad_silence_ms');
        const wVadSens = document.getElementById('whisper_vad_sensitivity');
        if (wVadMs) wVadMs.value = w.vad_silence_ms || 2500;
        if (wVadSens) wVadSens.value = w.vad_sensitivity || 'medium';
    }
    if (integrationId === 'piper' && cfg) {
        // Populate addon config fields from addon API
        try {
            const addonRes = await apiCall('/api/addons/piper');
            if (addonRes.ok) {
                const addon = await addonRes.json();
                const ac = addon.state?.config || {};
                const pVoice = document.getElementById('piper_voice');
                const pHost = document.getElementById('piper_host');
                const pPort = document.getElementById('piper_port');
                const pSpeakerId = document.getElementById('piper_speaker_id');
                const pLengthScale = document.getElementById('piper_length_scale');
                if (pVoice) pVoice.value = ac.voice || 'ro_RO-mihai-medium';
                if (pHost) pHost.value = ac.host || 'localhost';
                if (pPort) pPort.value = ac.port || 10200;
                if (pSpeakerId) pSpeakerId.value = ac.speaker_id ?? 0;
                if (pLengthScale) pLengthScale.value = ac.length_scale || '1.0';
            }
        } catch (_) {}
    }
    if (integrationId === 'pago' && cfg) {
        const p = cfg.pago || {};
        const pEmail = document.getElementById('pago_email');
        const pPass = document.getElementById('pago_password');
        const pInterval = document.getElementById('pago_scan_interval');
        if (pEmail) pEmail.value = p.email || '';
        if (pPass && p.password) pPass.value = p.password;
        if (pInterval) pInterval.value = p.scan_interval ?? 3600;
    }
    if (integrationId === 'fusion_solar' && cfg) {
        const f = cfg.fusion_solar || {};
        const mode = document.getElementById('fusion_solar_mode');
        const host = document.getElementById('fusion_solar_host');
        const kiosk = document.getElementById('fusion_solar_kiosk_url');
        const user = document.getElementById('fusion_solar_username');
        const pass = document.getElementById('fusion_solar_password');
        const interval = document.getElementById('fusion_solar_scan_interval');
        if (mode) mode.value = f.mode || 'auto';
        if (host) host.value = f.host || 'https://eu5.fusionsolar.huawei.com';
        if (kiosk) kiosk.value = f.kiosk_url || '';
        if (user) user.value = f.username || '';
        if (pass && f.password) pass.value = f.password;
        if (interval) interval.value = f.scan_interval ?? 600;
    }

    // Shared "emitted entities" section (only integrations with supports_sync).
    if (_supportsIntegrationEntitySync(catalogSlug)) {
        try { await loadIntegrationExposedEntities(catalogSlug); } catch (_) {}
    }
    // HA-style config entries — only for component providers with CONFIG_SCHEMA.
    if (_integrationHasConfigSchema(catalogSlug)) {
        try { await loadIntegrationConfigEntries(catalogSlug); } catch (_) {}
    }
}

export function copyAssistOllamaUserUrl() {
    const el = document.getElementById('assist_ollama_user_url');
    if (!el || !el.value) return;
    copyToClipboard(el.value);
}

export function copyAssistKey() {
    const el = document.getElementById('assist_api_key');
    if (!el || !el.value) return;
    copyToClipboard(el.value);
}

export async function regenerateAssistKey() {
    if (!(await showConfirm(t('config.assist_regenerate_confirm')))) return;
    try {
        const res = await apiCall('/api/assist-key/regenerate', { method: 'POST' });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const keyEl = document.getElementById('assist_api_key');
        if (keyEl && data.assist_api_key) keyEl.value = data.assist_api_key;
        const origin = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : '';
        const ollamaUserUrlEl = document.getElementById('assist_ollama_user_url');
        if (ollamaUserUrlEl && data.assist_api_key && origin) ollamaUserUrlEl.value = origin + '/ollama/user/' + data.assist_api_key;
        showToast(t('config.assist_regenerate_done'), 'success');
    } catch (e) {
        showToast(t('config.assist_regenerate_error'), 'error');
    }
}

export function closeIntegrationConfigModal() {
    // Save addon-level config for piper if its panel is visible
    const piperPanel = document.getElementById('integration-panel-piper');
    if (piperPanel && !piperPanel.classList.contains('hidden')) {
        _savePiperAddonConfig();
    }
    closeSubPage('integration-config-modal');
    import('./features_config.js').then(({ saveConfig }) => saveConfig({ silent: true })).catch(() => {});
}

async function _savePiperAddonConfig() {
    const voice = document.getElementById('piper_voice')?.value || 'ro_RO-mihai-medium';
    const host = (document.getElementById('piper_host')?.value || 'localhost').trim();
    const port = parseInt(document.getElementById('piper_port')?.value, 10) || 10200;
    const speaker_id = parseInt(document.getElementById('piper_speaker_id')?.value, 10) || 0;
    const length_scale = (document.getElementById('piper_length_scale')?.value || '1.0').trim();
    try {
        await apiCall('/api/addons/piper/config', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ voice, host, port, speaker_id, length_scale }),
        });
    } catch (_) {}
}
// ---------------------------------------------------------------------------
// Integration entity sync & display
// ---------------------------------------------------------------------------

const _ENTITY_META = {
    profil:          { icon: 'fa-user',                labelKey: 'profil' },
    abonament:       { icon: 'fa-id-badge',            labelKey: 'abonament' },
    carduri:         { icon: 'fa-credit-card',         labelKey: 'carduri' },
    vehicule:        { icon: 'fa-car',                 labelKey: 'vehicule' },
    facturi:         { icon: 'fa-file-invoice-dollar', labelKey: 'facturi' },
    conturi_facturi: { icon: 'fa-building',            labelKey: 'conturi_facturi' },
    plati:           { icon: 'fa-receipt',             labelKey: 'plati' },
    summary:         { icon: 'fa-solar-panel',         labelKey: 'summary' },
    stations:        { icon: 'fa-industry',            labelKey: 'stations' },
    realtime:        { icon: 'fa-bolt',                labelKey: 'realtime' },
    yearly:          { icon: 'fa-chart-line',          labelKey: 'yearly' },
    yearly_current:  { icon: 'fa-calendar-check',      labelKey: 'yearly_current' },
    yearly_lifetime: { icon: 'fa-infinity',            labelKey: 'yearly_lifetime' },
    devices:         { icon: 'fa-microchip',           labelKey: 'devices' },
};

function _detailLocale() {
    return getLanguage() === 'ro' ? 'ro-RO' : 'en-US';
}

function _ed(key, params) {
    return t('integrations.entity_detail.' + key, params);
}

function _entityMeta(key) {
    const meta = _ENTITY_META[key];
    if (meta) return { icon: meta.icon, label: _ed(meta.labelKey) };
    return { icon: 'fa-database', label: key };
}

function _detailRow(labelKey, value) {
    if (value == null || value === '') return '';
    return `<div class="flex justify-between gap-2"><span class="text-slate-500">${escapeHtml(_ed(labelKey))}</span><span class="text-slate-300 text-right">${value}</span></div>`;
}

// ---- detail renderers per entity key ------------------------------------

function _fmtDateStr(s) {
    if (!s || s.length < 10) return s || '—';
    const d = new Date(s.slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return s;
    return d.toLocaleDateString(_detailLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}
function _fmtTs(ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleDateString(_detailLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}
function _daysUntil(dateStr) {
    if (!dateStr || dateStr.length < 10) return null;
    const d = new Date(dateStr.slice(0, 10) + 'T00:00:00');
    if (isNaN(d)) return null;
    const now = new Date(); now.setHours(0, 0, 0, 0);
    return Math.floor((d - now) / 86400000);
}

function _renderDetailProfil(data) {
    if (!data || data.error) return `<span class="text-red-400 text-[10px]">${escapeHtml(_ed('error'))}</span>`;
    return [
        _detailRow('field_name', `${data.nume || ''} ${data.prenume || ''}`.trim()),
        _detailRow('field_email', data.email),
        _detailRow('field_phone', data.telefon ? `+${data.telefon}` : null),
        _detailRow('field_id', data.pos_user_id),
        _detailRow('field_member_since', data.creat_la ? _fmtTs(data.creat_la) : null),
    ].join('');
}

function _renderDetailAbonament(data) {
    if (!data || data.error) return `<span class="text-red-400 text-[10px]">${escapeHtml(_ed('error'))}</span>`;
    const active = data.activ
        ? `<span class="text-emerald-400">${escapeHtml(_ed('active'))}</span>`
        : `<span class="text-red-400">${escapeHtml(_ed('inactive'))}</span>`;
    return [
        _detailRow('field_status', active),
        _detailRow('field_period', data.inceput && data.sfarsit ? `${data.inceput} → ${data.sfarsit}` : null),
        _detailRow('field_period_days', data.perioada_zile),
        _detailRow('field_bills_per_month', data.facturi_lunare != null ? `${data.plati_folosite ?? 0} / ${data.facturi_lunare}` : null),
        _detailRow('field_payments_remaining', data.plati_ramase != null ? `<span class="${data.plati_ramase > 0 ? 'text-emerald-400' : 'text-amber-400'}">${data.plati_ramase}</span>` : null),
    ].join('');
}

function _renderDetailCarduri(data) {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_cards'))}</span>`;
    return data.map(c => {
        const last4 = c.last4 || '????';
        const type = c.tip_card || '';
        const alias = c.alias || '';
        const active = c.activ !== false;
        const isDefault = c.default;
        const defaultBadge = isDefault ? ` <span class="text-orange-400 text-[9px]">${escapeHtml(_ed('default_badge'))}</span>` : '';
        return `<div class="flex items-center justify-between gap-2">`
            + `<span class="text-slate-300 font-mono">****${last4}</span>`
            + `<span class="text-slate-500">${type}${alias ? ' · ' + alias : ''}${defaultBadge}</span>`
            + `<span class="${active ? 'text-emerald-400' : 'text-red-400'} text-[9px]">${active ? '●' : '○'}</span>`
            + `</div>`;
    }).join('');
}

function _renderDetailVehicule(data) {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_vehicles'))}</span>`;
    const alertLabels = {
        rca_expira: 'alert_rca', itp_expira: 'alert_itp',
        vinieta_expira: 'alert_vignette', rovinieta_expira: 'alert_vignette', casco_expira: 'alert_casco',
    };
    return data.map(v => {
        const plate = v.nr_inmatriculare || '?';
        const alerte = v.alerte || {};
        const rcaDays = _daysUntil(alerte.rca_expira);
        const itpDays = _daysUntil(alerte.itp_expira);
        let status = _ed('vehicle_status_ok'), statusCls = 'text-emerald-400';
        if (rcaDays !== null && rcaDays < 0) { status = _ed('vehicle_rca_expired'); statusCls = 'text-red-400'; }
        else if (itpDays !== null && itpDays < 0) { status = _ed('vehicle_itp_expired'); statusCls = 'text-red-400'; }
        else if (!alerte.rca_expira) { status = _ed('vehicle_no_rca'); statusCls = 'text-amber-400'; }
        const tags = [];
        for (const [key, labelKey] of Object.entries(alertLabels)) {
            const val = alerte[key];
            if (!val) continue;
            const days = _daysUntil(val);
            const dateStr = _fmtDateStr(val);
            let cls = 'text-emerald-400';
            let extra = '';
            if (days !== null) {
                if (days < 0) { cls = 'text-red-400'; extra = _ed('expired_suffix'); }
                else { extra = _ed('days_suffix', { days }); }
            }
            tags.push(`<span class="${cls}">${escapeHtml(_ed(labelKey))} ${dateStr}${escapeHtml(extra)}</span>`);
        }
        const notifs = [];
        if (alerte.rca_notificare_sms) notifs.push('SMS');
        if (alerte.rca_notificare_email) notifs.push('Email');
        const notifStr = notifs.length ? `<div class="text-[9px] text-slate-600">${escapeHtml(_ed('rca_notifications', { channels: notifs.join(', ') }))}</div>` : '';
        return `<div class="space-y-0.5 pb-1.5 ${data.indexOf(v) < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="flex items-center justify-between"><span class="text-slate-300 font-mono font-bold">${plate}</span><span class="${statusCls} text-[10px] font-semibold">${escapeHtml(status)}</span></div>`
            + `<div class="text-[10px] flex flex-wrap gap-x-1.5 gap-y-0.5">${tags.join('')}</div>`
            + notifStr
            + `</div>`;
    }).join('');
}

function _renderDetailFacturi(data) {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_bills'))}</span>`;
    const total = data.reduce((s, b) => s + (b.suma_datorata || 0), 0);
    const today = new Date().toISOString().slice(0, 10);
    const restante = data.filter(b => b.scadenta && b.scadenta <= today).length;
    let header = `<div class="flex justify-between gap-2 pb-1 mb-1 border-b border-white/5">`
        + `<span class="text-slate-400">${escapeHtml(_ed('total_due'))}</span>`
        + `<span class="text-slate-200 font-mono font-bold">${total.toFixed(2)} RON</span></div>`;
    if (restante > 0) {
        header += `<div class="text-red-400 text-[10px] mb-1"><i class="fas fa-exclamation-triangle mr-1"></i>${escapeHtml(restante === 1 ? _ed('overdue_one') : _ed('overdue_many', { count: restante }))}</div>`;
    }
    return header + data.map(b => {
        const amt = b.suma_datorata != null ? `${b.suma_datorata.toFixed(2)} RON` : '—';
        const scad = b.scadenta || '—';
        const overdue = b.scadenta && b.scadenta <= today;
        const cls = overdue ? 'text-red-400' : 'text-slate-300';
        return `<div class="flex justify-between gap-2"><span class="${cls} font-mono">${amt}</span><span class="text-slate-500">${escapeHtml(_ed('due_on', { date: _fmtDateStr(scad) }))}${overdue ? ' <i class="fas fa-exclamation-triangle text-red-400 text-[9px] ml-1"></i>' : ''}</span></div>`;
    }).join('');
}

function _renderDetailConturiFurnizori(data) {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_providers'))}</span>`;
    return data.map(c => {
        const name = c.furnizor_nume || c.furnizor || '?';
        const loc = c.locatie || '';
        const suma = c.ultima_plata_suma;
        const dataPlata = c.ultima_plata_data ? _fmtDateStr(c.ultima_plata_data) : '';
        const auto = c.auto_plata ? `<span class="text-blue-400 text-[9px] ml-1">${escapeHtml(_ed('auto_pay'))}</span>` : '';
        const when = dataPlata ? _ed('last_payment_on', { date: dataPlata }) : '';
        const paymentLine = suma != null
            ? `<div class="text-[10px] text-slate-400">${escapeHtml(_ed('last_payment', { amount: `${suma.toFixed(2)} RON`, when }))}</div>`
            : '';
        return `<div class="space-y-0.5 pb-1 ${data.indexOf(c) < data.length - 1 ? 'border-b border-white/5 mb-1' : ''}">`
            + `<div class="flex items-center justify-between gap-2"><span class="text-slate-300 font-semibold">${name}</span>${auto}</div>`
            + (loc ? `<div class="text-[10px] text-slate-500"><i class="fas fa-map-marker-alt text-[8px] mr-1"></i>${loc}${c.tip_locatie ? ' · ' + c.tip_locatie : ''}</div>` : '')
            + paymentLine
            + `</div>`;
    }).join('');
}

function _renderDetailPlati(data) {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_payments'))}</span>`;
    const typeKeys = { provider: 'payment_type_bill', rca: 'payment_type_rca', recharge: 'payment_type_recharge', vignette: 'payment_type_vignette' };
    const recent = data.slice(0, 12);
    return recent.map(p => {
        const amt = p.suma != null ? `${Number(p.suma).toFixed(2)} RON` : (p.suma_platita != null ? `${Number(p.suma_platita).toFixed(2)} RON` : '—');
        const date = p.data ? _fmtDateStr(p.data) : '—';
        const type = typeKeys[p.tip] ? _ed(typeKeys[p.tip]) : (p.tip || '');
        const furn = p.furnizor_nume || '';
        const loc = p.locatie || '';
        const ok = p.status === 'finalized';
        const label = furn || type || '?';
        return `<div class="flex items-center justify-between gap-1">`
            + `<span class="text-slate-300 font-mono text-[10px] shrink-0">${amt}</span>`
            + `<span class="text-slate-500 truncate text-[10px]">${escapeHtml(label)}${loc ? ' · ' + escapeHtml(loc) : ''}</span>`
            + `<span class="text-slate-600 text-[10px] shrink-0">${date}</span>`
            + `<span class="${ok ? 'text-emerald-400' : 'text-amber-400'} text-[9px] shrink-0">${ok ? '✓' : '…'}</span>`
            + `</div>`;
    }).join('')
        + (data.length > 12 ? `<div class="text-[10px] text-slate-600 text-center mt-1">${escapeHtml(_ed('older_payments', { count: data.length - 12 }))}</div>` : '');
}

function _fusionSummaryRows(item) {
    return [
        item.station_address ? ['field_address', item.station_address] : null,
        item.capacity_kw != null ? ['field_capacity', `${Number(item.capacity_kw).toFixed(2)} kW`] : null,
        item.realtime_power_kw != null ? ['field_live_power', `${Number(item.realtime_power_kw).toFixed(2)} kW`] : null,
        item.daily_energy_kwh != null ? ['field_daily_production', `${Number(item.daily_energy_kwh).toFixed(2)} kWh`] : null,
        item.month_energy_kwh != null ? ['field_monthly_production', `${Number(item.month_energy_kwh).toFixed(2)} kWh`] : null,
        item.yearly_energy_kwh != null ? ['field_yearly_production', `${Number(item.yearly_energy_kwh).toFixed(2)} kWh`] : null,
        item.lifetime_energy_kwh != null ? ['field_total_production', `${Number(item.lifetime_energy_kwh).toFixed(2)} kWh`] : null,
        item.feed_in_energy_kwh != null ? ['field_feed_in', `${Number(item.feed_in_energy_kwh).toFixed(2)} kWh`] : null,
        item.consumption_kwh != null ? ['field_consumption', `${Number(item.consumption_kwh).toFixed(2)} kWh`] : null,
        item.revenue != null ? ['field_revenue', `${Number(item.revenue).toFixed(2)} RON`] : null,
    ].filter(Boolean);
}

function _fusionYearlyKpiRows(kpi) {
    return [
        kpi.installed_capacity != null ? ['field_installed_capacity', `${Number(kpi.installed_capacity).toFixed(2)} kW`] : null,
        kpi.radiation_intensity != null ? ['field_global_radiation', `${(Number(kpi.radiation_intensity) * 1000).toFixed(1)} Wh/m²`] : null,
        kpi.theory_power != null ? ['field_theoretical_production', `${Number(kpi.theory_power).toFixed(2)} kWh`] : null,
        kpi.performance_ratio != null ? ['field_performance_ratio', `${Number(kpi.performance_ratio).toFixed(3)}`] : null,
        kpi.inverter_power != null ? ['field_inverter_production', `${Number(kpi.inverter_power).toFixed(2)} kWh`] : null,
        kpi.ongrid_power != null ? ['field_feed_in', `${Number(kpi.ongrid_power).toFixed(2)} kWh`] : null,
        kpi.use_power != null ? ['field_consumption', `${Number(kpi.use_power).toFixed(2)} kWh`] : null,
        kpi.power_profit != null ? ['field_revenue', `${Number(kpi.power_profit).toFixed(2)} RON`] : null,
        kpi.perpower_ratio != null ? ['field_specific_energy', `${Number(kpi.perpower_ratio).toFixed(2)} kWh/kWp`] : null,
        kpi.reduction_total_co2 != null ? ['field_co2_reduction', `${(Number(kpi.reduction_total_co2) * 1000).toFixed(1)} kg`] : null,
        kpi.reduction_total_coal != null ? ['field_coal_saved', `${(Number(kpi.reduction_total_coal) * 1000).toFixed(1)} kg`] : null,
        kpi.reduction_total_tree != null ? ['field_tree_equivalent', `${Number(kpi.reduction_total_tree).toFixed(0)}`] : null,
    ].filter(Boolean);
}

const _FUSION_KPI_KEYS = {
    active_power: ['kpi_active_power', 'kW'], day_cap: ['kpi_day_cap', 'kWh'],
    total_cap: ['kpi_total_cap', 'kWh'], efficiency: ['kpi_efficiency', '%'],
    temperature: ['kpi_temperature', '°C'], elec_freq: ['kpi_elec_freq', 'Hz'],
    power_factor: ['kpi_power_factor', ''], reactive_power: ['kpi_reactive_power', 'kVar'],
    mppt_power: ['kpi_mppt_power', 'kW'], battery_soc: ['kpi_battery_soc', '%'],
    battery_soh: ['kpi_battery_soh', '%'], ch_discharge_power: ['kpi_ch_discharge_power', 'W'],
    charge_cap: ['kpi_charge_cap', 'kWh'], discharge_cap: ['kpi_discharge_cap', 'kWh'],
    meter_u: ['kpi_meter_u', 'V'], meter_i: ['kpi_meter_i', 'A'],
    grid_frequency: ['kpi_grid_frequency', 'Hz'], active_cap: ['kpi_active_cap', 'kWh'],
    reverse_active_cap: ['kpi_reverse_active_cap', 'kWh'], inverter_state: ['kpi_inverter_state', ''],
    run_state: ['kpi_run_state', ''],
};

function _renderDetailFusionSummary(data) {
    if (!data || typeof data !== 'object') return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_data'))}</span>`;
    const rows = [
        ['field_stations', data.station_count],
        ['field_live_power', data.realtime_power_kw != null ? `${Number(data.realtime_power_kw).toFixed(2)} kW` : null],
        ['field_daily_production', data.daily_energy_kwh != null ? `${Number(data.daily_energy_kwh).toFixed(2)} kWh` : null],
        ['field_monthly_production', data.month_energy_kwh != null ? `${Number(data.month_energy_kwh).toFixed(2)} kWh` : null],
        ['field_total_production', data.lifetime_energy_kwh != null ? `${Number(data.lifetime_energy_kwh).toFixed(2)} kWh` : null],
        ['field_status', data.status || null],
    ].filter(([, v]) => v !== null && v !== undefined && v !== '');
    return rows.map(([lk, v]) => _detailRow(lk, v)).join('');
}

function _renderDetailFusionStations(data) {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_stations'))}</span>`;
    return data.map((item, i) => {
        const rows = _fusionSummaryRows(item);
        return `<div class="space-y-0.5 pb-1.5 ${i < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${escapeHtml(item.station_name || item.station_code || _ed('default_station'))}</div>`
            + rows.map(([lk, v]) => _detailRow(lk, v)).join('')
            + `</div>`;
    }).join('');
}

function _renderDetailFusionRealtime(data) {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_live_data'))}</span>`;
    return data.map((item, i) => {
        const rows = [
            ['field_power', `${Number(item.realtime_power_kw || 0).toFixed(2)} kW`],
            ['field_today', `${Number(item.daily_energy_kwh || 0).toFixed(2)} kWh`],
            item.month_energy_kwh != null ? ['field_month', `${Number(item.month_energy_kwh).toFixed(2)} kWh`] : null,
            item.lifetime_energy_kwh != null ? ['field_total', `${Number(item.lifetime_energy_kwh).toFixed(2)} kWh`] : null,
        ].filter(Boolean);
        return `<div class="space-y-0.5 pb-1.5 ${i < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${escapeHtml(item.station_name || item.station_code || _ed('default_station'))}</div>`
            + rows.map(([lk, v]) => _detailRow(lk, v)).join('')
            + `</div>`;
    }).join('');
}

function _renderDetailFusionYearly(data) {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_yearly_data'))}</span>`;
    return data.map((item, i) => {
        if (!item || typeof item !== 'object') return '';
        const code = item.stationCode || '?';
        const kpi = item.dataItemMap || {};
        const ct = item.collectTime;
        const yearLabel = ct ? new Date(ct).getFullYear() : '?';
        const rows = _fusionYearlyKpiRows(kpi);
        if (!rows.length) return '';
        return `<div class="space-y-0.5 pb-1.5 ${i < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${escapeHtml(code)} <span class="text-amber-400 text-xs ml-1">${escapeHtml(_ed('year_label', { year: yearLabel }))}</span></div>`
            + rows.map(([lk, v]) => _detailRow(lk, v)).join('')
            + `</div>`;
    }).filter(Boolean).join('') || `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_data'))}</span>`;
}

function _renderDetailFusionYearlyCurrent(data) {
    if (!data || typeof data !== 'object' || !Object.keys(data).length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_current_year_data'))}</span>`;
    return Object.entries(data).map(([code, kpi], i, arr) => {
        if (!kpi || typeof kpi !== 'object') return '';
        const ct = kpi.collect_time;
        const yearLabel = ct ? new Date(ct).getFullYear() : new Date().getFullYear();
        const rows = _fusionYearlyKpiRows(kpi);
        if (!rows.length) return '';
        return `<div class="space-y-0.5 pb-1.5 ${i < arr.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${escapeHtml(code)} <span class="text-amber-400 text-xs ml-1">${escapeHtml(_ed('year_label', { year: yearLabel }))}</span></div>`
            + rows.map(([lk, v]) => _detailRow(lk, v)).join('')
            + `</div>`;
    }).filter(Boolean).join('') || `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_data'))}</span>`;
}

function _renderDetailFusionYearlyLifetime(data) {
    if (!data || typeof data !== 'object' || !Object.keys(data).length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_lifetime_data'))}</span>`;
    return Object.entries(data).map(([code, kpi], i, arr) => {
        if (!kpi || typeof kpi !== 'object') return '';
        const rows = [
            kpi.inverter_power != null ? ['field_inverter_production', `${Number(kpi.inverter_power).toFixed(2)} kWh`] : null,
            kpi.ongrid_power != null ? ['field_feed_in', `${Number(kpi.ongrid_power).toFixed(2)} kWh`] : null,
            kpi.use_power != null ? ['field_consumption', `${Number(kpi.use_power).toFixed(2)} kWh`] : null,
            kpi.power_profit != null ? ['field_revenue', `${Number(kpi.power_profit).toFixed(2)} RON`] : null,
            kpi.perpower_ratio != null ? ['field_specific_energy', `${Number(kpi.perpower_ratio).toFixed(2)} kWh/kWp`] : null,
            kpi.reduction_total_co2 != null ? ['field_co2_reduction', `${(Number(kpi.reduction_total_co2) * 1000).toFixed(1)} kg`] : null,
            kpi.reduction_total_coal != null ? ['field_coal_saved', `${(Number(kpi.reduction_total_coal) * 1000).toFixed(1)} kg`] : null,
            kpi.reduction_total_tree != null ? ['field_tree_equivalent', `${Number(kpi.reduction_total_tree).toFixed(0)}`] : null,
        ].filter(Boolean);
        if (!rows.length) return '';
        return `<div class="space-y-0.5 pb-1.5 ${i < arr.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${escapeHtml(code)} <span class="text-purple-400 text-xs ml-1">${escapeHtml(_ed('lifetime_tag'))}</span></div>`
            + rows.map(([lk, v]) => _detailRow(lk, v)).join('')
            + `</div>`;
    }).filter(Boolean).join('') || `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_data'))}</span>`;
}

function _renderDetailFusionDevices(data) {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_devices'))}</span>`;
    return data.map((dev, i) => {
        if (!dev || typeof dev !== 'object') return '';
        const kpi = dev.realtime_kpi || {};
        const infoRows = [
            dev.device_type ? ['field_type', dev.device_type] : null,
            dev.esn_code ? ['field_serial', dev.esn_code] : null,
            dev.inverter_type ? ['field_inverter_model', dev.inverter_type] : null,
            dev.software_version ? ['field_software', dev.software_version] : null,
            dev.station_code ? ['field_station', dev.station_code] : null,
        ].filter(Boolean);
        const kpiRows = Object.entries(kpi).map(([k, v]) => {
            if (v == null) return null;
            const cfg = _FUSION_KPI_KEYS[k];
            const formatted = cfg && cfg[1] ? `${Number(v).toFixed(2)} ${cfg[1]}` : String(v);
            return { labelKey: cfg ? cfg[0] : null, rawKey: k, value: formatted };
        }).filter(Boolean);
        const allRows = [...infoRows, ...kpiRows];
        if (!allRows.length) return '';
        const rowHtml = (row) => {
            if (Array.isArray(row)) return _detailRow(row[0], row[1]);
            if (row.labelKey) return _detailRow(row.labelKey, row.value);
            return `<div class="flex justify-between gap-2"><span class="text-slate-500">${escapeHtml(row.rawKey)}</span><span class="text-slate-300 text-right">${escapeHtml(row.value)}</span></div>`;
        };
        return `<div class="space-y-0.5 pb-1.5 ${i < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${escapeHtml(dev.device_name || dev.device_id || _ed('default_device'))} <span class="text-sky-400 text-xs ml-1">${escapeHtml(dev.device_type || '')}</span></div>`
            + allRows.map(rowHtml).join('')
            + `</div>`;
    }).filter(Boolean).join('') || `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_data'))}</span>`;
}

const _DETAIL_RENDERERS = {
    profil: _renderDetailProfil,
    abonament: _renderDetailAbonament,
    carduri: _renderDetailCarduri,
    vehicule: _renderDetailVehicule,
    facturi: _renderDetailFacturi,
    conturi_facturi: _renderDetailConturiFurnizori,
    plati: _renderDetailPlati,
    summary: _renderDetailFusionSummary,
    stations: _renderDetailFusionStations,
    realtime: _renderDetailFusionRealtime,
    yearly: _renderDetailFusionYearly,
    yearly_current: _renderDetailFusionYearlyCurrent,
    yearly_lifetime: _renderDetailFusionYearlyLifetime,
    devices: _renderDetailFusionDevices,
};

// ---- sync & load --------------------------------------------------------

export function navigateToSmartHomeSource(slug) {
    if (typeof window.switchTab === 'function') window.switchTab('smarthome');
    const catalogSlug = _integrationCatalogSlug(slug);
    setTimeout(() => filterHABySource(catalogSlug), 200);
};

export async function syncIntegrationEntities(slug, options = {}) {
    const catalogSlug = _integrationCatalogSlug(slug);
    const showUserToast = options.toast !== false;
    const btn = document.getElementById(`${catalogSlug}-sync-btn`);
    if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-1"></i>${escapeHtml(_ed('sync_btn'))}`; }
    try {
        const res = await apiCall(`/api/integrations/sync/${encodeURIComponent(catalogSlug)}`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.status === 'ok') {
            await loadIntegrationEntities(catalogSlug);
            if (showUserToast && typeof showToast === 'function') {
                const count = Number(data.entity_count);
                const msg = Number.isFinite(count) && count >= 0
                    ? t('integrations.sync_ok_count', { count })
                    : t('integrations.sync_ok');
                showToast(msg, 'success', 2200);
            }
        } else {
            const msg = translateApiDetail(data.detail) || integrationApiMessage(data) || t('integrations.sync_failed');
            const errEl = document.getElementById(`${catalogSlug}-entities-error`);
            if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
            if (showUserToast && typeof showToast === 'function') showToast(msg, 'error', 3500);
        }
    } catch (e) {
        const msg = e.message || t('integrations.sync_failed');
        const errEl = document.getElementById(`${catalogSlug}-entities-error`);
        if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
        if (showUserToast && typeof showToast === 'function') showToast(msg, 'error', 3500);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-sync-alt mr-1"></i>${escapeHtml(_ed('sync_btn'))}`; }
    }
};

// store current entities for toggling detail
let _currentEntities = {};

async function _loadExposedEntitiesSummary() {
    const grid = document.getElementById('ha-exposed-entities-grid');
    const empty = document.getElementById('ha-exposed-entities-empty');
    if (!grid) return;
    try {
        const res = await apiCall('/api/integrations/all-entities');
        if (!res.ok) { if (empty) empty.classList.remove('hidden'); return; }
        const data = await res.json();
        const sources = data.sources || [];
        if (!sources.length) { grid.innerHTML = ''; if (empty) empty.classList.remove('hidden'); return; }
        if (empty) empty.classList.add('hidden');
        grid.innerHTML = sources.map(src => {
            return `<div class="bg-white/[0.03] border border-white/5 rounded-lg p-2.5 text-center cursor-pointer hover:bg-white/[0.06] hover:border-orange-500/20 transition-all" data-config-action="openSmarthomeTab">
                <i class="fas ${escapeHtml(src.icon)} ${escapeHtml(src.color)} text-sm mb-1"></i>
                <div class="text-[10px] font-bold text-slate-400">${escapeHtml(src.label)}</div>
                <div class="text-[11px] text-slate-500 mono">${escapeHtml(t('integrations.entity_count_label', { count: src.count }))}</div>
            </div>`;
        }).join('') + `<div class="bg-white/[0.03] border border-white/5 rounded-lg p-2.5 text-center">
            <i class="fas fa-layer-group text-accent/60 text-sm mb-1"></i>
            <div class="text-[10px] font-bold text-accent/80">${escapeHtml(t('integrations.total'))}</div>
            <div class="text-[11px] text-slate-500 mono">${escapeHtml(t('integrations.entity_count_label', { count: data.total }))}</div>
        </div>`;
    } catch (_) {
        if (empty) empty.classList.remove('hidden');
    }
}

function _ensureEntitySection(slug) {
    if (document.getElementById(`${slug}-entities-section`)) return;
    // Try built-in integration panel first, then addon container
    const panel = document.getElementById(`integration-panel-${slug}`) || document.getElementById('addon-entities-container');
    if (!panel) return;
    const html = `<div id="${slug}-entities-section" class="mt-4 border-t border-white/5 pt-4 hidden">
        <div class="flex items-center justify-between mb-2">
            <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">${escapeHtml(t('integrations.synced_entities'))}</span>
            <div class="flex items-center gap-2">
                <button type="button" data-config-action="navigateToSmartHomeSource" data-config-slug="${slug}" class="px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-accent/10 hover:bg-accent/20 text-accent border border-accent/20 transition-colors">
                    <i class="fas fa-pen mr-1"></i>${escapeHtml(t('integrations.rename'))}
                </button>
                <span id="${slug}-entities-time" class="text-[10px] text-slate-600"></span>
                <button type="button" id="${slug}-sync-btn" data-config-action="syncIntegrationEntities" data-config-slug="${slug}" class="px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 border border-orange-500/20 transition-colors">
                    <i class="fas fa-sync-alt mr-1"></i>${escapeHtml(_ed('sync_btn'))}
                </button>
            </div>
        </div>
        <div id="${slug}-entities-error" class="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-2 mb-2 hidden"></div>
        <div id="${slug}-entities-grid" class="grid grid-cols-2 sm:grid-cols-3 gap-2"></div>
    </div>`;
    panel.insertAdjacentHTML('beforeend', html);
}

async function loadIntegrationEntities(slug) {
    _ensureEntitySection(slug);
    const section = document.getElementById(`${slug}-entities-section`);
    const grid = document.getElementById(`${slug}-entities-grid`);
    const timeEl = document.getElementById(`${slug}-entities-time`);
    const errEl = document.getElementById(`${slug}-entities-error`);
    if (!section || !grid) return;
    try {
        const res = await apiCall(`/api/integrations/${slug}/entities`);
        if (!res.ok) { section.classList.add('hidden'); return; }
        const data = await res.json();
        section.classList.remove('hidden');
        if (errEl) {
            if (data.last_error) { errEl.textContent = data.last_error; errEl.classList.remove('hidden'); }
            else errEl.classList.add('hidden');
        }
        if (timeEl && data.updated_at) {
            const d = new Date(data.updated_at);
            const age = Date.now() - d.getTime();
            const isStale = age > 2 * 3600_000; // older than 2h
            timeEl.textContent = d.toLocaleString(_detailLocale(), { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
            if (isStale) timeEl.textContent += ' ⏳';
        }

        const entities = data.entities || {};
        _currentEntities = entities;
        grid.innerHTML = '';

        // Check if all entities are empty or errored
        const hasErrors = Object.values(entities).some(v => (typeof v === 'object' && !Array.isArray(v) && v?.error));
        const allEmpty = Object.values(entities).every(v => {
            if (Array.isArray(v)) return v.length === 0;
            if (typeof v === 'object' && v) return !!v.error || Object.keys(v).length === 0;
            return true;
        });
        if (allEmpty && errEl) {
            errEl.textContent = hasErrors ? _ed('load_error') : _ed('no_entities_sync');
            errEl.classList.remove('hidden');
        }

        for (const [key, value] of Object.entries(entities)) {
            const meta = _entityMeta(key);
            let count = '';
            if (Array.isArray(value)) count = value.length;
            else if (typeof value === 'object' && value && !value.error) count = _ed('fields_count', { count: Object.keys(value).length });
            else if (value?.error) count = _ed('error_badge');

            const card = document.createElement('div');
            card.className = 'entity-card bg-white/[0.03] border border-white/5 rounded-lg p-2.5 text-center cursor-pointer hover:bg-white/[0.06] hover:border-orange-500/20 transition-all';
            card.dataset.entityKey = key;
            card.innerHTML = `<i class="fas ${meta.icon} text-orange-400/60 text-sm mb-1"></i>`
                + `<div class="text-[10px] font-bold text-slate-400">${escapeHtml(meta.label)}</div>`
                + `<div class="text-[11px] text-slate-500 mono">${escapeHtml(String(count))}</div>`;

            card.addEventListener('click', () => {
                _openEntityDetailModal(key, value, meta);
            });

            grid.appendChild(card);
        }
    } catch (_) {
        section.classList.add('hidden');
    }
}

function _openEntityDetailModal(key, value, meta) {
    const modal = document.getElementById('entity-detail-modal');
    const iconEl = document.getElementById('entity-detail-modal-icon');
    const labelEl = document.getElementById('entity-detail-modal-label');
    const body = document.getElementById('entity-detail-modal-body');
    if (!modal || !body) return;
    if (iconEl) iconEl.className = `fas ${meta.icon}`;
    if (labelEl) labelEl.textContent = meta.label;
    const renderer = _DETAIL_RENDERERS[key];
    if (renderer) {
        body.innerHTML = renderer(value);
    } else {
        body.innerHTML = `<pre class="text-[9px] text-slate-500 whitespace-pre-wrap break-all">${JSON.stringify(value, null, 2).slice(0, 2000)}</pre>`;
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

/** @returns {Array<object>} */
export function getIntegrationCatalog() {
    return _integrationCatalog;
}
