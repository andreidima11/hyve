/**
 * Settings → Add-ons list + Updates hub (install/enable/update add-ons).
 */
import { apiCall } from './api.js';
import { t } from './lang/index.js';
import { showToast, showConfirm, escapeHtml } from './utils.js';
import { isExplicitNonAdmin } from './user_context.js';

// ═══════════════════════════════════════════════════════════════════════════
// ADDONS / APPS
// ═══════════════════════════════════════════════════════════════════════════

let _currentAddonSlug = null;

const _addonColorMap = {
    cyan: { bg: 'bg-cyan-500/20', text: 'text-cyan-400', border: '#22d3ee', btnBg: 'bg-cyan-500/15', btnHover: 'hover:bg-cyan-500/25', btnText: 'text-cyan-300', btnBorder: 'border-cyan-500/25' },
    blue: { bg: 'bg-blue-500/20', text: 'text-blue-400', border: '#3b82f6', btnBg: 'bg-blue-500/15', btnHover: 'hover:bg-blue-500/25', btnText: 'text-blue-300', btnBorder: 'border-blue-500/25' },
    emerald: { bg: 'bg-emerald-500/20', text: 'text-emerald-400', border: '#10b981', btnBg: 'bg-emerald-500/15', btnHover: 'hover:bg-emerald-500/25', btnText: 'text-emerald-300', btnBorder: 'border-emerald-500/25' },
    amber: { bg: 'bg-amber-500/20', text: 'text-amber-400', border: '#f59e0b', btnBg: 'bg-amber-500/15', btnHover: 'hover:bg-amber-500/25', btnText: 'text-amber-300', btnBorder: 'border-amber-500/25' },
    violet: { bg: 'bg-violet-500/20', text: 'text-violet-400', border: '#8b5cf6', btnBg: 'bg-violet-500/15', btnHover: 'hover:bg-violet-500/25', btnText: 'text-violet-300', btnBorder: 'border-violet-500/25' },
    rose: { bg: 'bg-rose-500/20', text: 'text-rose-400', border: '#f43f5e', btnBg: 'bg-rose-500/15', btnHover: 'hover:bg-rose-500/25', btnText: 'text-rose-300', btnBorder: 'border-rose-500/25' },
    indigo: { bg: 'bg-indigo-500/20', text: 'text-indigo-400', border: '#6366f1', btnBg: 'bg-indigo-500/15', btnHover: 'hover:bg-indigo-500/25', btnText: 'text-indigo-300', btnBorder: 'border-indigo-500/25' },
};
const _defaultColor = { bg: 'bg-slate-500/20', text: 'text-slate-400', border: '#64748b', btnBg: 'bg-slate-500/15', btnHover: 'hover:bg-slate-500/25', btnText: 'text-slate-300', btnBorder: 'border-slate-500/25' };

export async function loadAddons() {
    const container = document.getElementById('addons-list');
    if (!container) return;

    let addons = [];
    try {
        const res = await apiCall('/api/addons');
        if (res.ok) addons = await res.json();
    } catch (e) {
        container.innerHTML = `<p class="text-sm text-red-400 text-center py-8">${escapeHtml(t('hy.addon_list_load_error'))}</p>`;
        return;
    }

    if (!addons.length) {
        container.innerHTML = `<p class="text-sm text-slate-500 text-center py-8">${escapeHtml(t('hy.addon_list_empty'))}</p>`;
        return;
    }

    container.innerHTML = addons.map(addon => _renderAddonCard(addon)).join('');
}

function _renderAddonCard(addon) {
    const s = addon.state || {};
    const installed = !!s.installed;
    const enabled = !!s.enabled;
    const c = _addonColorMap[addon.color] || _defaultColor;
    const slug = escapeHtml(addon.slug);
    const name = escapeHtml(addon.name);
    const desc = escapeHtml(addon.description || '');
    const version = escapeHtml(addon.version || '');

    let statusBadge = '';
    let actions = '';

    if (installed) {
        if (enabled) {
            statusBadge = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full border border-emerald-500/30 text-emerald-400 bg-emerald-500/10">${escapeHtml(t('hy.addon_status_active'))}</span>`;
        } else {
            statusBadge = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full border border-amber-500/30 text-amber-400 bg-amber-500/10">${escapeHtml(t('hy.addon_status_installed'))}</span>`;
        }
        actions = `
            <button type="button" data-config-action="openAddonConfigModal" data-config-slug="${slug}" class="px-4 py-2 rounded-xl text-xs font-medium bg-white/5 hover:${c.btnBg} text-slate-300 hover:${c.btnText} border border-white/10 transition-colors">
                <i class="fas fa-cog mr-1"></i> ${escapeHtml(t('hy.addon_configure'))}
            </button>
            ${enabled
                ? `<button type="button" data-config-action="toggleAddon" data-config-slug="${slug}" data-config-enabled="false" class="integration-toggle-btn integration-btn-disable text-red-500/70 hover:text-red-500 hover:bg-red-500/10 px-3 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all inline-flex items-center gap-1.5 border border-transparent hover:border-red-500/20"><i class="fas fa-power-off"></i> ${escapeHtml(t('integrations.disable'))}</button>`
                : `<button type="button" data-config-action="toggleAddon" data-config-slug="${slug}" data-config-enabled="true" class="integration-toggle-btn integration-btn-enable text-emerald-500/70 hover:text-emerald-500 hover:bg-emerald-500/10 px-3 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider transition-all inline-flex items-center gap-1.5 border border-transparent hover:border-emerald-500/20"><i class="fas fa-check"></i> ${escapeHtml(t('integrations.enable'))}</button>`
            }
            <button type="button" data-config-action="uninstallAddon" data-config-slug="${slug}" class="text-red-500/50 hover:text-red-500 hover:bg-red-500/10 px-2 py-2 rounded-xl text-[10px] transition-all border border-transparent hover:border-red-500/20" title="${escapeHtml(t('hy.addon_uninstall_title'))}"><i class="fas fa-trash-alt"></i></button>
        `;
    } else {
        statusBadge = `<span class="text-[10px] font-bold px-2 py-0.5 rounded-full border border-slate-500/30 text-slate-500">${escapeHtml(t('hy.addon_status_available'))}</span>`;
        actions = `
            <button type="button" data-config-action="installAddon" data-config-slug="${slug}" class="${c.btnBg} ${c.btnHover} ${c.btnText} border ${c.btnBorder} px-4 py-2 rounded-xl text-xs font-medium transition-colors inline-flex items-center gap-1.5">
                <i class="fas fa-download"></i> ${escapeHtml(t('hy.addon_install_btn'))}
            </button>
        `;
    }

    return `
        <div class="cfg-section flex flex-wrap items-center justify-between gap-3" style="border-left: 4px solid ${c.border};" id="addon-card-${slug}">
            <div class="flex items-center gap-3 flex-wrap min-w-0">
                <span class="w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center shrink-0"><i class="${escapeHtml(addon.icon || 'fas fa-puzzle-piece')} ${c.text} text-xl"></i></span>
                <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="text-sm font-bold ${c.text}">${name}</span>
                        ${statusBadge}
                        ${version ? `<span class="text-[10px] text-slate-600">v${version}</span>` : ''}
                    </div>
                    <p class="text-[10px] text-slate-500 mt-0.5 leading-relaxed">${desc}</p>
                </div>
            </div>
            <div class="flex items-center gap-2 flex-wrap">
                ${actions}
            </div>
        </div>
    `;
}

export async function installAddon(slug) {
    const card = document.getElementById(`addon-card-${slug}`);
    const btn = card?.querySelector('button');
    if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(t('hy.addon_installing'))}`; }

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/install`, { method: 'POST' });
        if (res.ok) {
            showToast(t('hy.addon_installed'), 'success');
            await loadAddons();
        } else {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || t('hy.addon_install_error'), 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-download"></i> ${escapeHtml(t('hy.addon_install_btn'))}`; }
        }
    } catch (e) {
        showToast(t('hy.network_error'), 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-download"></i> ${escapeHtml(t('hy.addon_install_btn'))}`; }
    }
}

export async function uninstallAddon(slug) {
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

export async function toggleAddon(slug, enabled) {
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

export async function openAddonConfigModal(slug) {
    _currentAddonSlug = slug;
    const titleEl = document.getElementById('addon-config-modal-title');
    const iconEl = document.getElementById('addon-config-modal-icon');
    const fieldsEl = document.getElementById('addon-config-fields');
    if (!fieldsEl) return;

    let addon = null;
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}`);
        if (res.ok) addon = await res.json();
    } catch (e) {}

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
        const args = (addon.start_command.args || []).map(a => {
            return a.replace(/\{(\w+)\}/g, (_, k) => cfg[k] ?? k);
        });
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
    const watchdogToggle = document.getElementById('addon-watchdog-toggle');
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
    const config = {};
    fields.forEach(f => {
        const key = f.dataset.addonKey;
        config[key] = f.type === 'number' ? Number(f.value) : f.value;
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
    const watchdogToggle = document.getElementById('addon-watchdog-toggle');
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
    const btn = document.getElementById('addon-health-btn');
    if (btn) btn.disabled = true;
    if (resultEl) { resultEl.classList.remove('hidden'); resultEl.className = 'text-xs rounded-xl p-3 bg-slate-900 border border-white/5 text-slate-400'; resultEl.textContent = t('common.checking'); }

    const formatHealthError = (detail) => {
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
        const data = await res.json();
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

// ─────────────────────────────────────────────────────────────────────────────
// UPDATES — Add-on update management
// ─────────────────────────────────────────────────────────────────────────────

let _addonUpdatesCache = [];

/** Update the iOS-style badge on the Updates hub card with the number of available updates. */
export function updateHeaderUpdatesBadge(count) {
    const badge = document.getElementById('hub-updates-badge-count');
    if (!badge) return;
    const n = Math.max(0, parseInt(count, 10) || 0);
    if (n <= 0) {
        badge.classList.add('hidden');
        return;
    }
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.remove('hidden');
    // Replay animation
    badge.style.animation = 'none';
    void badge.offsetWidth;
    badge.style.animation = '';
}

/** Background poll for available add-on updates and refresh the header badge. */
export async function refreshUpdatesHeaderBadge() {
    if (isExplicitNonAdmin()) return;
    try {
        const res = await apiCall('/api/updates/addons');
        if (!res.ok) return;
        const data = await res.json();
        updateHeaderUpdatesBadge(data?.total_updates || 0);
    } catch (_) {}
}

export async function loadUpdatesAddons() {
    const list = document.getElementById('updates-addons-list');
    if (!list) return;
    list.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs"><i class="fas fa-spinner fa-spin mr-2"></i>${escapeHtml(t('updates.loading'))}</div>`;
    _setUpdatesStatus('', 'hidden');
    try {
        const res = await apiCall('/api/updates/addons');
        const data = await res.json();
        _addonUpdatesCache = data.addons || [];
        updateHeaderUpdatesBadge(data.total_updates || 0);
        _renderAddonUpdateRows();
    } catch (e) {
        list.innerHTML = `<div class="text-center py-8 text-red-400 text-xs"><i class="fas fa-triangle-exclamation mr-2"></i>${escapeHtml(e.message || String(e))}</div>`;
    }
}

export async function checkAddonUpdates() {
    const btn = document.getElementById('updates-addons-check-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('updates.check_btn'))}</span>`; }
    _setUpdatesStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('updates.checking'))}`, 'info');
    try {
        await apiCall('/api/updates/addons/check', { method: 'POST' });
        // Reload the full list so badges/state reflect the recomputed result.
        await loadUpdatesAddons();
        const count = _addonUpdatesCache.filter(a => a.update_available).length;
        if (count > 0) {
            _setUpdatesStatus(`<i class="fas fa-arrow-up mr-1.5"></i>${escapeHtml(t('updates.n_updates_available', { count }))}`, 'warning');
        } else {
            _setUpdatesStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('updates.all_up_to_date'))}`, 'success');
        }
    } catch (e) {
        _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e.message || String(e))}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-rotate"></i><span>${escapeHtml(t('updates.check_btn'))}</span>`; }
    }
}

export async function updateAllAddons() {
    const pending = _addonUpdatesCache.filter(a => a.update_available);
    if (!pending.length) return;
    if (!(await showConfirm(t('updates.confirm_update_addons', { count: pending.length })))) return;
    await _runAddonUpdate({ all: true });
}

export async function updateSingleAddon(slug) {
    const addon = _addonUpdatesCache.find(a => a.slug === slug);
    const name = addon ? addon.name : slug;
    if (!(await showConfirm(t('updates.confirm_update_addon', { name })))) return;
    await _runAddonUpdate({ slugs: [slug] });
}

async function _runAddonUpdate(body) {
    const upgradeBtn = document.getElementById('updates-addons-upgrade-btn');
    if (upgradeBtn) { upgradeBtn.disabled = true; upgradeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('updates.upgrade_btn_loading'))}</span>`; }
    _setUpdatesStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('updates.installing'))}`, 'info');
    try {
        const res = await apiCall('/api/updates/addons/update', { method: 'POST', body });
        const data = await res.json();
        if (data.status === 'ok') {
            _setUpdatesStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('updates.addons_updated', { count: (data.updated || []).length }))}`, 'success');
        } else if (data.status === 'partial') {
            _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(data.message || '')}`, 'warning');
        } else {
            let html = `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(data.message || t('updates.save_error'))}`;
            if (data.failed && data.failed.length) {
                html += `<ul class="mt-2 ml-4 list-disc text-[10px] space-y-0.5">`;
                for (const f of data.failed) html += `<li><strong>${escapeHtml(f.slug)}</strong> — ${escapeHtml(f.error || '')}</li>`;
                html += `</ul>`;
            }
            _setUpdatesStatus(html, 'error');
        }
        await loadUpdatesAddons();
    } catch (e) {
        _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e.message || String(e))}`, 'error');
    } finally {
        if (upgradeBtn) { upgradeBtn.disabled = false; upgradeBtn.innerHTML = `<i class="fas fa-arrow-up"></i><span>${escapeHtml(t('updates.upgrade_all_btn'))}</span>`; }
    }
}

const _ADDON_COLOR_MAP = {
    cyan: 'text-cyan-400', blue: 'text-blue-400', purple: 'text-purple-400',
    fuchsia: 'text-fuchsia-400', amber: 'text-amber-400', red: 'text-red-400',
    green: 'text-green-400', emerald: 'text-emerald-400', slate: 'text-slate-400',
    indigo: 'text-indigo-400', rose: 'text-rose-400',
};

function _renderAddonUpdateRows() {
    const list = document.getElementById('updates-addons-list');
    if (!list) return;

    const sorted = [..._addonUpdatesCache].sort((a, b) => {
        if (!!a.update_available !== !!b.update_available) return a.update_available ? -1 : 1;
        return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });
    const total = sorted.length;
    const pending = sorted.filter(a => a.update_available).length;

    const countEl = document.getElementById('updates-addons-count');
    if (countEl) countEl.textContent = t('updates.addons_count', { count: total });

    const upgradeBtn = document.getElementById('updates-addons-upgrade-btn');
    if (upgradeBtn) upgradeBtn.classList.toggle('hidden', pending === 0);

    if (!total) {
        list.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs">${escapeHtml(t('updates.no_addons'))}</div>`;
        return;
    }

    list.innerHTML = sorted.map(a => {
        const iconColor = _ADDON_COLOR_MAP[a.color] || _ADDON_COLOR_MAP.slate;
        const iconHtml = a.image
            ? `<img src="${escapeHtml(a.image)}" alt="" class="w-4 h-4 rounded object-contain" loading="lazy">`
            : `<i class="${escapeHtml(a.icon || 'fas fa-puzzle-piece')} ${iconColor}"></i>`;

        let versionHtml, badge, actionHtml;
        if (a.update_available) {
            versionHtml = `<span class="font-mono text-slate-400">${escapeHtml(a.current || '?')}</span><i class="fas fa-arrow-right text-[8px] text-amber-400 mx-1"></i><span class="font-mono text-amber-400 font-semibold">${escapeHtml(a.latest || '?')}</span>`;
            badge = `<span class="upd-badge upd-badge--update"><i class="fas fa-arrow-up"></i>${escapeHtml(t('updates.badge_update'))}</span>`;
            actionHtml = `<button type="button" data-config-action="updateSingleAddon" data-config-slug="${escapeHtml(a.slug)}" class="upd-row-btn"><i class="fas fa-arrow-up"></i></button>`;
        } else {
            versionHtml = `<span class="font-mono text-slate-400">${escapeHtml(a.current || a.latest || '?')}</span>`;
            badge = `<span class="upd-badge upd-badge--ok"><i class="fas fa-check"></i>${escapeHtml(t('updates.badge_up_to_date'))}</span>`;
            actionHtml = '';
        }

        return `<div class="upd-row${a.update_available ? ' upd-row--outdated' : ''}">
            <div class="upd-row-main">
                <span class="upd-row-icon inline-flex items-center justify-center flex-shrink-0">${iconHtml}</span>
                <span class="upd-row-name">${escapeHtml(a.name)}</span>
            </div>
            <div class="upd-row-version">${versionHtml}</div>
            <div class="upd-row-status">${badge}${actionHtml}</div>
        </div>`;
    }).join('');
}

function _setUpdatesStatus(html, type) {
    const el = document.getElementById('updates-addons-status');
    if (!el) return;
    if (type === 'hidden') { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const colors = {
        info: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
        success: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
        warning: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
        error: 'bg-red-500/10 border-red-500/20 text-red-400',
    };
    el.className = `mb-3 text-[11px] rounded-xl p-3 border ${colors[type] || colors.info}`;
    el.innerHTML = html;
}

// --- Updates interval custom dropdown ---

function _intervalLabel(val) {
    const key = { never: 'updates.interval_never', daily: 'updates.interval_daily', weekly: 'updates.interval_weekly', monthly: 'updates.interval_monthly' }[val];
    return key ? t(key) : val;
}

let _updatesDropdownBound = false;

// Bind once at module load — works even before loadConfig has run
if (typeof document !== 'undefined' && !_updatesDropdownBound) {
    _updatesDropdownBound = true;
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('updates_interval_dropdown');
        if (!dd) return;
        const toggleBtn = e.target.closest('[data-action="toggle-updates-interval"]');
        if (toggleBtn && dd.contains(toggleBtn)) {
            e.preventDefault();
            e.stopPropagation();
            dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
            return;
        }
        const opt = e.target.closest('.dashboard-custom-select__option');
        if (opt && dd.contains(opt)) {
            e.preventDefault();
            e.stopPropagation();
            const value = opt.dataset.value;
            const labelKey = opt.dataset.labelKey;
            const label = labelKey ? t(labelKey) : (opt.textContent.trim());
            setUpdatesInterval(value, label);
            return;
        }
        if (!dd.contains(e.target)) dd.dataset.open = 'false';
    });
}

function _bindUpdatesIntervalDropdownOnce() { /* legacy stub — bind happens at module load */ }

export function toggleUpdatesIntervalDropdown() {
    const dd = document.getElementById('updates_interval_dropdown');
    if (!dd) return;
    dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
}

export function setUpdatesInterval(value, label) {
    const dd = document.getElementById('updates_interval_dropdown');
    const hidden = document.getElementById('updates_addons_check_interval');
    const lbl = label || _intervalLabel(value);
    if (dd) {
        dd.dataset.open = 'false';
        const valueEl = dd.querySelector('.dashboard-custom-select__value');
        if (valueEl) valueEl.textContent = lbl;
        dd.querySelectorAll('.dashboard-custom-select__option').forEach(o => {
            o.dataset.selected = o.dataset.value === value ? 'true' : 'false';
        });
    }
    if (hidden) {
        hidden.value = value;
        try { hidden.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    }
}

export function syncUpdatesIntervalDropdown() {
    _bindUpdatesIntervalDropdownOnce();
    const hidden = document.getElementById('updates_addons_check_interval');
    const dd = document.getElementById('updates_interval_dropdown');
    if (!hidden || !dd) return;
    const val = hidden.value || 'never';
    dd.querySelector('.dashboard-custom-select__value').textContent = _intervalLabel(val);
    dd.querySelectorAll('.dashboard-custom-select__option').forEach(o => {
        o.dataset.selected = o.dataset.value === val ? 'true' : 'false';
    });
}
