/**
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
import { loadIntegrationConfigEntries, integrationHasConfigSchema } from './config_entries.js';
import { loadExposedEntitiesSummary } from './entities_sync.js';

export function slugForId(s: string) {
    if (!s || typeof s !== 'string') return '';
    return s.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '') || '';
}


function addCctvCameraRow(camera: Record<string, unknown>) {
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
    if (id) row.dataset.cctvId = String(id);
    list.appendChild(row);
    const removeBtn = row.querySelector('.cctv-cam-remove');
    if (removeBtn) removeBtn.addEventListener('click', () => row.remove());
}

export function renderCctvCameras(cameras: unknown[]) {
    const list = document.getElementById('cctv-cameras-list');
    if (!list) return;
    list.innerHTML = '';
    (cameras as Record<string, unknown>[] || []).forEach((cam) => addCctvCameraRow(cam));
}
const INTEGRATION_MODAL_TITLES: Record<string, string> = { ha: 'config.ha_section', searxng: 'config.searxng_section', waha: 'config.waha_section', cctv: 'config.cctv_section', whisper: 'config.whisper_section', comfyui: 'config.comfyui_section', piper: 'config.piper_section', pago: 'config.pago_section', fusion_solar: 'config.fusion_solar_section' };
const INTEGRATION_MODAL_ICONS: Record<string, string> = { ha: 'fa-house-signal', searxng: 'fa-magnifying-glass', waha: 'fa-brands fa-whatsapp', cctv: 'fa-video', whisper: 'fa-microphone', comfyui: 'fa-palette', piper: 'fa-volume-up', pago: 'fa-file-invoice-dollar', fusion_solar: 'fa-solar-panel' };
const INTEGRATION_MODAL_IMAGES: Record<string, string> = {
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

export async function openIntegrationConfigModal(integrationId: string) {
    const modal = document.getElementById('integration-config-modal');
    const titleEl = document.getElementById('integration-config-modal-title');
    const iconEl = document.getElementById('integration-config-modal-icon');
    const logoEl = document.getElementById('integration-config-modal-logo') as HTMLImageElement | null;
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
    const meta = integrationDefinition(integrationId) || null;
    const catalogSlug = integrationCatalogSlug(integrationId);
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
                        await syncConfiguredIntegration(catalogSlug, syncBtn as HTMLButtonElement);
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
    const resolvedTitle = (titleKey ? t(titleKey) : '') || integrationLabel(meta) || integrationId;
    const icon = INTEGRATION_MODAL_ICONS[integrationId]
        || normalizeIntegrationIcon(meta?.icon || 'fa-plug');
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
        const keyEl = intEl('assist_api_key');
        if (keyEl) keyEl.value = '';
        try {
            const res = await apiCall('/api/assist-key');
            if (res.ok) {
                const data = await res.json();
                if (keyEl && data.assist_api_key) keyEl.value = data.assist_api_key;
                const ollamaUserUrlEl = intEl('assist_ollama_user_url');
                if (ollamaUserUrlEl && data.assist_api_key && origin) ollamaUserUrlEl.value = origin + '/ollama/user/' + data.assist_api_key;
            }
        } catch (_) {}
        const ollamaUserUrlEl = intEl('assist_ollama_user_url');
        if (ollamaUserUrlEl && !ollamaUserUrlEl.value && origin) ollamaUserUrlEl.value = '';
        // Load exposed entities summary
        loadExposedEntitiesSummary();
    }
    // Shared "emitted entities" section (only integrations with supports_sync).
    if (supportsIntegrationEntitySync(catalogSlug)) {
        try { await loadIntegrationExposedEntities(catalogSlug); } catch (_) {}
    }
    // HA-style config entries — only for component providers with CONFIG_SCHEMA.
    if (integrationHasConfigSchema(catalogSlug)) {
        try { await loadIntegrationConfigEntries(catalogSlug); } catch (_) {}
    }
}

export function copyAssistOllamaUserUrl(): void {
    const el = intEl('assist_ollama_user_url');
    if (!el || !el.value) return;
    copyToClipboard(el.value);
}

export function copyAssistKey(): void {
    const el = intEl('assist_api_key');
    if (!el || !el.value) return;
    copyToClipboard(el.value);
}

export async function regenerateAssistKey(): Promise<void> {
    if (!(await showConfirm(t('config.assist_regenerate_confirm')))) return;
    try {
        const res = await apiCall('/api/assist-key/regenerate', { method: 'POST' });
        if (!res.ok) throw new Error();
        const data = await res.json();
        const keyEl = intEl('assist_api_key');
        if (keyEl && data.assist_api_key) keyEl.value = data.assist_api_key;
        const origin = (typeof window !== 'undefined' && window.location?.origin) ? window.location.origin : '';
        const ollamaUserUrlEl = intEl('assist_ollama_user_url');
        if (ollamaUserUrlEl && data.assist_api_key && origin) ollamaUserUrlEl.value = origin + '/ollama/user/' + data.assist_api_key;
        showToast(t('config.assist_regenerate_done'), 'success');
    } catch (e) {
        showToast(t('config.assist_regenerate_error'), 'error');
    }
}

export function closeIntegrationConfigModal(): void {
    closeSubPage('integration-config-modal');
}
