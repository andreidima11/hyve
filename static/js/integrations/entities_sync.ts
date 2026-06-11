/**
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

export function navigateToSmartHomeSource(slug: string) {
    switchTab('smarthome');
    const catalogSlug = integrationCatalogSlug(slug);
    setTimeout(() => filterHABySource(catalogSlug), 200);
};

export async function syncIntegrationEntities(slug: string, options: SyncIntegrationEntitiesOptions = {}) {
    const catalogSlug = integrationCatalogSlug(slug);
    const showUserToast = options.toast !== false;
    const btn = document.getElementById(`${catalogSlug}-sync-btn`) as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-1"></i>${escapeHtml(entityDetailText('sync_btn'))}`; }
    try {
        const res = await apiCall(`/api/integrations/sync/${encodeURIComponent(catalogSlug)}`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.status === 'ok') {
            await loadIntegrationEntities(catalogSlug);
            try { await loadIntegrationConfigEntries(catalogSlug); } catch (_) {}
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
        const msg = errMsg(e) || t('integrations.sync_failed');
        const errEl = document.getElementById(`${catalogSlug}-entities-error`);
        if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
        if (showUserToast && typeof showToast === 'function') showToast(msg, 'error', 3500);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-sync-alt mr-1"></i>${escapeHtml(entityDetailText('sync_btn'))}`; }
    }
};

// store current entities for toggling detail
let _currentEntities: IntegrationEntitiesMap = {};

function _ensureEntitySection(slug: string): HTMLElement | null {
    const existing = document.getElementById(`${slug}-entities-section`);
    if (existing) return existing;
    const panel = document.getElementById('addon-entities-container');
    if (!panel) return null;
    const html = `<div id="${slug}-entities-section" class="mt-4 border-t border-white/5 pt-4 hidden">
        <div class="flex items-center justify-between mb-2">
            <span class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">${escapeHtml(t('integrations.synced_entities'))}</span>
            <div class="flex items-center gap-2">
                <button type="button" data-config-action="navigateToSmartHomeSource" data-config-slug="${slug}" class="px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-accent/10 hover:bg-accent/20 text-accent border border-accent/20 transition-colors">
                    <i class="fas fa-pen mr-1"></i>${escapeHtml(t('integrations.rename'))}
                </button>
                <span id="${slug}-entities-time" class="text-[10px] text-slate-600"></span>
                <button type="button" id="${slug}-sync-btn" data-config-action="syncIntegrationEntities" data-config-slug="${slug}" class="px-2.5 py-1 rounded-lg text-[10px] font-semibold bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 border border-orange-500/20 transition-colors">
                    <i class="fas fa-sync-alt mr-1"></i>${escapeHtml(entityDetailText('sync_btn'))}
                </button>
            </div>
        </div>
        <div id="${slug}-entities-error" class="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-2 mb-2 hidden"></div>
        <div id="${slug}-entities-grid" class="grid grid-cols-2 sm:grid-cols-3 gap-2"></div>
    </div>`;
    panel.insertAdjacentHTML('beforeend', html);
    return document.getElementById(`${slug}-entities-section`);
}

export async function loadIntegrationEntities(slug: string) {
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
            const refreshErr = data?.refresh?.last_error;
            const storeErr = data.last_error;
            const showErr = refreshErr || storeErr || (data?.refresh?.reachable === false);
            if (showErr) {
                errEl.textContent = refreshErr || storeErr || t('integrations.refresh_unreachable');
                errEl.classList.remove('hidden');
            } else {
                errEl.classList.add('hidden');
            }
        }
        if (timeEl && data.updated_at) {
            const d = new Date(data.updated_at);
            const age = Date.now() - d.getTime();
            const isStale = age > 2 * 3600_000; // older than 2h
            timeEl.textContent = d.toLocaleString(detailLocale(), { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' });
            if (isStale) timeEl.textContent += ' ⏳';
        }

        const entities = data.entities || {};
        _currentEntities = entities;
        grid.innerHTML = '';

        // Check if all entities are empty or errored
        const hasErrors = Object.values(entities).some(v => (typeof v === 'object' && !Array.isArray(v) && (v as Record<string, unknown>)?.error));
        const allEmpty = Object.values(entities).every(v => {
            if (Array.isArray(v)) return v.length === 0;
            if (typeof v === 'object' && v) return !!(v as Record<string, unknown>).error || Object.keys(v).length === 0;
            return true;
        });
        if (allEmpty && errEl) {
            errEl.textContent = hasErrors ? entityDetailText('load_error') : entityDetailText('no_entities_sync');
            errEl.classList.remove('hidden');
        }

        for (const [key, value] of Object.entries(entities)) {
            const meta = entityMeta(key);
            let count = '';
            if (Array.isArray(value)) count = String(value.length);
            else if (typeof value === 'object' && value && !(value as Record<string, unknown>).error) count = entityDetailText('fields_count', { count: Object.keys(value).length });
            else if ((value as Record<string, unknown>)?.error) count = entityDetailText('error_badge');

            const card = document.createElement('div');
            card.className = 'entity-card bg-white/[0.03] border border-white/5 rounded-lg p-2.5 text-center cursor-pointer hover:bg-white/[0.06] hover:border-orange-500/20 transition-all';
            card.dataset.entityKey = key;
            card.innerHTML = `<i class="fas ${meta.icon} text-orange-400/60 text-sm mb-1"></i>`
                + `<div class="text-[10px] font-bold text-slate-400">${escapeHtml(meta.label)}</div>`
                + `<div class="text-[11px] text-slate-500 mono">${escapeHtml(String(count))}</div>`;

            card.addEventListener('click', () => {
                openEntityDetailModal(key, value, meta);
            });

            grid.appendChild(card);
        }
    } catch (_) {
        section.classList.add('hidden');
    }
}

function openEntityDetailModal(key: string, value: unknown, meta: EntityMetaInfo) {
    const modal = document.getElementById('entity-detail-modal');
    const iconEl = document.getElementById('entity-detail-modal-icon');
    const labelEl = document.getElementById('entity-detail-modal-label');
    const body = document.getElementById('entity-detail-modal-body');
    if (!modal || !body) return;
    if (iconEl) iconEl.className = `fas ${meta.icon}`;
    if (labelEl) labelEl.textContent = meta.label;
    const renderer = detailRenderers[key];
    if (renderer) {
        body.innerHTML = renderer(value);
    } else {
        body.innerHTML = `<pre class="text-[9px] text-slate-500 whitespace-pre-wrap break-all">${JSON.stringify(value, null, 2).slice(0, 2000)}</pre>`;
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}
