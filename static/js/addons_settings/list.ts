/**
 * Add-ons settings: catalog list, install/enable, config modal.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { showToast, showConfirm, escapeHtml, openSubPage, closeSubPage } from '../utils.js';
import { loadIntegrationEntities } from '../features_integrations_settings.js';
import type { AddonRecord } from './types.js';
import * as render from './render.js';

let _currentAddonSlug: string | null = null;
export async function loadAddons() {
    const container = document.getElementById('addons-list');
    if (!container) return;

    let addons: AddonRecord[] = [];
    try {
        const res = await apiCall('/api/addons');
        if (res.ok) addons = await res.json() as AddonRecord[];
    } catch (e) {
        container.innerHTML = `<p class="text-sm text-red-400 text-center py-8">${escapeHtml(t('hy.addon_list_load_error'))}</p>`;
        return;
    }

    if (!addons.length) {
        container.innerHTML = `<p class="text-sm text-slate-500 text-center py-8">${escapeHtml(t('hy.addon_list_empty'))}</p>`;
        return;
    }

    container.innerHTML = addons.map(addon => render._renderAddonCard(addon)).join('');
}
export async function installAddon(slug: string) {
    const card = document.getElementById(`addon-card-${slug}`);
    const btn = card?.querySelector('button') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(t('hy.addon_installing'))}`; }

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/install`, { method: 'POST' });
        if (res.ok) {
            showToast(t('hy.addon_installed'), 'success');
            await loadAddons();
        } else {
            const err = await res.json().catch(() => ({})) as { detail?: string };
            showToast(err.detail || t('hy.addon_install_error'), 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-download"></i> ${escapeHtml(t('hy.addon_install_btn'))}`; }
        }
    } catch (e) {
        showToast(t('hy.network_error'), 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-download"></i> ${escapeHtml(t('hy.addon_install_btn'))}`; }
    }
}

export async function uninstallAddon(slug: string) {
    if (!(await showConfirm(t('hy.addon_uninstall_confirm', { slug })))) return;
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/uninstall`, { method: 'POST' });
        if (res.ok) {
            showToast(t('hy.addon_uninstalled'), 'success');
            await loadAddons();
        } else {
            showToast(t('hy.addon_uninstall_error'), 'error');
        }
    } catch (e) {
        showToast(t('hy.network_error'), 'error');
    }
}

export async function toggleAddon(slug: string, enabled: boolean) {
    const ep = enabled ? 'enable' : 'disable';
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/${ep}`, { method: 'POST' });
        if (res.ok) {
            showToast(enabled ? t('hy.addon_enabled_toast') : t('hy.addon_disabled_toast'), 'success');
            await loadAddons();
        } else {
            showToast(t('common.error'), 'error');
        }
    } catch (e) {
        showToast(t('hy.network_error'), 'error');
    }
}

export async function openAddonConfigModal(slug: string) {
    _currentAddonSlug = slug;
    const titleEl = document.getElementById('addon-config-modal-title');
    const iconEl = document.getElementById('addon-config-modal-icon');
    const fieldsEl = document.getElementById('addon-config-fields');
    if (!fieldsEl) return;

    let addon: AddonRecord | null = null;
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}`);
        if (res.ok) addon = await res.json() as AddonRecord;
    } catch (_) {}

    if (!addon) { showToast(t('hy.addon_not_found'), 'error'); return; }

    if (titleEl) titleEl.textContent = addon.name || slug;
    if (iconEl) iconEl.className = `${addon.icon || 'fas fa-puzzle-piece'}`;

    const schema = addon.config_schema || [];
    const cfg = addon.state?.config || {};

    fieldsEl.innerHTML = schema.map(field => {
        const val = cfg[field.key] ?? field.default ?? '';
        const key = escapeHtml(field.key);
        const label = escapeHtml(field.label || field.key);
        const desc = field.description ? `<p class="text-[10px] text-slate-500 mt-0.5">${escapeHtml(field.description)}</p>` : '';
        const ph = escapeHtml(field.placeholder || '');

        if (field.type === 'number') {
            return `<div class="space-y-1">
                <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${label}</label>
                <input type="number" data-addon-key="${key}" value="${escapeHtml(String(val))}" placeholder="${ph}" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-xs mono text-slate-300 focus:border-accent outline-none">
                ${desc}
            </div>`;
        }
        return `<div class="space-y-1">
            <label class="text-[10px] font-bold text-slate-500 uppercase tracking-widest block">${label}</label>
            <input type="text" data-addon-key="${key}" value="${escapeHtml(String(val))}" placeholder="${ph}" class="w-full bg-slate-900 border border-white/5 rounded-xl p-3 text-xs mono text-slate-300 focus:border-accent outline-none">
            ${desc}
        </div>`;
    }).join('');

    if (addon.start_command) {
        const args = (addon.start_command.args || []).map(a =>
            a.replace(/\{(\w+)\}/g, (_, k) => String(cfg[k] ?? k))
        );
        const cmd = `${addon.start_command.command} ${args.join(' ')}`;
        fieldsEl.innerHTML += `
            <div class="mt-4 pt-4 border-t border-white/5 space-y-2">
                <p class="text-[10px] font-bold text-slate-500 uppercase tracking-widest">${escapeHtml(t('hy.addon_start_command_label'))}</p>
                <code class="block bg-slate-900 border border-white/5 rounded-xl p-3 text-[11px] mono text-slate-400 break-all select-all">${escapeHtml(cmd)}</code>
                <p class="text-[10px] text-slate-600">${escapeHtml(addon.start_command.description || '')}</p>
            </div>
        `;
    }

    const healthResult = document.getElementById('addon-health-result');
    if (healthResult) { healthResult.classList.add('hidden'); healthResult.textContent = ''; }

    // Watchdog toggle
    const watchdogToggle = document.getElementById('addon-watchdog-toggle') as HTMLInputElement | null;
    const watchdogSection = document.getElementById('addon-watchdog-section');
    if (watchdogToggle) watchdogToggle.checked = !!(addon.state?.watchdog);
    // Only show watchdog if addon has a start_command
    if (watchdogSection) watchdogSection.classList.toggle('hidden', !addon.start_command);

    // Clear previous addon entity section and load entities
    const addonEntContainer = document.getElementById('addon-entities-container');
    if (addonEntContainer) addonEntContainer.innerHTML = '';
    const entitySlug = addon.integration_key || slug;
    loadIntegrationEntities(entitySlug);

    openSubPage('addon-config-modal');
}

export function closeAddonConfigModal() {
    _currentAddonSlug = null;
    closeSubPage('addon-config-modal');
}

export async function saveAddonConfig() {
    if (!_currentAddonSlug) return;
    const fields = document.querySelectorAll('#addon-config-fields [data-addon-key]');
    const config: Record<string, unknown> = {};
    fields.forEach(f => {
        const el = f as HTMLInputElement;
        const key = el.dataset.addonKey;
        if (!key) return;
        config[key] = el.type === 'number' ? Number(el.value) : el.value;
    });

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(_currentAddonSlug)}/config`, {
            method: 'PATCH',
            body: config,
        });
        if (!res.ok) {
            showToast(t('hy.addon_config_save_error'), 'error');
            return;
        }
    } catch (e) {
        showToast(t('hy.network_error'), 'error');
        return;
    }

    // Save watchdog setting
    const watchdogToggle = document.getElementById('addon-watchdog-toggle') as HTMLInputElement | null;
    if (watchdogToggle && !watchdogToggle.closest('.hidden')) {
        try {
            await apiCall(`/api/addons/${encodeURIComponent(_currentAddonSlug)}/watchdog`, {
                method: 'POST',
                body: { enabled: watchdogToggle.checked },
            });
        } catch (e) {}
    }

    showToast(t('hy.addon_config_saved'), 'success');
}

export async function checkAddonHealth() {
    if (!_currentAddonSlug) return;
    const resultEl = document.getElementById('addon-health-result');
    const btn = document.getElementById('addon-health-btn') as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    if (resultEl) { resultEl.classList.remove('hidden'); resultEl.className = 'text-xs rounded-xl p-3 bg-slate-900 border border-white/5 text-slate-400'; resultEl.textContent = t('common.checking'); }

    const formatHealthError = (detail: unknown) => {
        const raw = String(detail || '').trim();
        const low = raw.toLowerCase();
        if (!raw) return t('hy.addon_health_no_response');
        if (low === 'not_running') return t('hy.addon_health_not_running');
        if (low === 'no_port_configured') return t('hy.addon_health_no_port');
        if (low.includes('connection refused') || low.includes('errno 61')) {
            return t('hy.addon_health_connection_refused');
        }
        if (low.includes('timed out') || low.includes('timeout')) {
            return t('hy.addon_health_timeout');
        }
        return raw;
    };

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(_currentAddonSlug)}/health`);
        const data = await res.json() as { ok?: boolean; detail?: string };
        if (data.ok) {
            if (resultEl) { resultEl.className = 'text-xs rounded-xl p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'; resultEl.textContent = `✓ ${t('hy.addon_health_connected', { detail: data.detail || 'OK' })}`; }
        } else {
            if (resultEl) { resultEl.className = 'text-xs rounded-xl p-3 bg-red-500/10 border border-red-500/20 text-red-400'; resultEl.textContent = `✗ ${t('hy.addon_health_error', { detail: formatHealthError(data.detail) })}`; }
        }
    } catch (e) {
        if (resultEl) { resultEl.className = 'text-xs rounded-xl p-3 bg-red-500/10 border border-red-500/20 text-red-400'; resultEl.textContent = `✗ ${t('hy.addon_health_network_error')}`; }
    }
    if (btn) btn.disabled = false;
}
