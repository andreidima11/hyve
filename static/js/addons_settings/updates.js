/**
 * Add-ons settings: Updates hub + check interval dropdown.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { showConfirm, escapeHtml } from '../utils.js';
import { isExplicitNonAdmin } from '../user_context.js';
let _addonUpdatesCache = [];
/** Update the iOS-style badge on the Updates hub card with the number of available updates. */
export function updateHeaderUpdatesBadge(count) {
    const badge = document.getElementById('hub-updates-badge-count');
    if (!badge)
        return;
    const n = Math.max(0, typeof count === 'number' ? count : parseInt(String(count), 10) || 0);
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
    if (isExplicitNonAdmin())
        return;
    try {
        const res = await apiCall('/api/updates/addons');
        if (!res.ok)
            return;
        const data = await res.json();
        updateHeaderUpdatesBadge(data?.total_updates || 0);
    }
    catch (_) { }
}
export async function loadUpdatesAddons() {
    const list = document.getElementById('updates-addons-list');
    if (!list)
        return;
    list.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs"><i class="fas fa-spinner fa-spin mr-2"></i>${escapeHtml(t('updates.loading'))}</div>`;
    _setUpdatesStatus('', 'hidden');
    try {
        const res = await apiCall('/api/updates/addons');
        const data = await res.json();
        _addonUpdatesCache = data.addons || [];
        updateHeaderUpdatesBadge(data.total_updates || 0);
        _renderAddonUpdateRows();
    }
    catch (e) {
        list.innerHTML = `<div class="text-center py-8 text-red-400 text-xs"><i class="fas fa-triangle-exclamation mr-2"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}</div>`;
    }
}
export async function checkAddonUpdates() {
    const btn = document.getElementById('updates-addons-check-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('updates.check_btn'))}</span>`;
    }
    _setUpdatesStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('updates.checking'))}`, 'info');
    try {
        await apiCall('/api/updates/addons/check', { method: 'POST' });
        // Reload the full list so badges/state reflect the recomputed result.
        await loadUpdatesAddons();
        const count = _addonUpdatesCache.filter(a => a.update_available).length;
        if (count > 0) {
            _setUpdatesStatus(`<i class="fas fa-arrow-up mr-1.5"></i>${escapeHtml(t('updates.n_updates_available', { count }))}`, 'warning');
        }
        else {
            _setUpdatesStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('updates.all_up_to_date'))}`, 'success');
        }
    }
    catch (e) {
        _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
    finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="fas fa-rotate"></i><span>${escapeHtml(t('updates.check_btn'))}</span>`;
        }
    }
}
export async function updateAllAddons() {
    const pending = _addonUpdatesCache.filter(a => a.update_available);
    if (!pending.length)
        return;
    if (!(await showConfirm(t('updates.confirm_update_addons', { count: pending.length }))))
        return;
    await _runAddonUpdate({ all: true });
}
export async function updateSingleAddon(slug) {
    const addon = _addonUpdatesCache.find(a => a.slug === slug);
    const name = addon ? addon.name : slug;
    if (!(await showConfirm(t('updates.confirm_update_addon', { name }))))
        return;
    await _runAddonUpdate({ slugs: [slug] });
}
async function _runAddonUpdate(body) {
    const upgradeBtn = document.getElementById('updates-addons-upgrade-btn');
    if (upgradeBtn) {
        upgradeBtn.disabled = true;
        upgradeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('updates.upgrade_btn_loading'))}</span>`;
    }
    _setUpdatesStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('updates.installing'))}`, 'info');
    try {
        const res = await apiCall('/api/updates/addons/update', { method: 'POST', body });
        const data = await res.json();
        if (data.status === 'ok') {
            _setUpdatesStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('updates.addons_updated', { count: (data.updated || []).length }))}`, 'success');
        }
        else if (data.status === 'partial') {
            _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(data.message || '')}`, 'warning');
        }
        else {
            let html = `<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(data.message || t('updates.save_error'))}`;
            if (data.failed && data.failed.length) {
                html += `<ul class="mt-2 ml-4 list-disc text-[10px] space-y-0.5">`;
                for (const f of data.failed)
                    html += `<li><strong>${escapeHtml(f.slug)}</strong> — ${escapeHtml(f.error || '')}</li>`;
                html += `</ul>`;
            }
            _setUpdatesStatus(html, 'error');
        }
        await loadUpdatesAddons();
    }
    catch (e) {
        _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    }
    finally {
        if (upgradeBtn) {
            upgradeBtn.disabled = false;
            upgradeBtn.innerHTML = `<i class="fas fa-arrow-up"></i><span>${escapeHtml(t('updates.upgrade_all_btn'))}</span>`;
        }
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
    if (!list)
        return;
    const sorted = [..._addonUpdatesCache].sort((a, b) => {
        if (!!a.update_available !== !!b.update_available)
            return a.update_available ? -1 : 1;
        return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });
    const total = sorted.length;
    const pending = sorted.filter(a => a.update_available).length;
    const countEl = document.getElementById('updates-addons-count');
    if (countEl)
        countEl.textContent = t('updates.addons_count', { count: total });
    const upgradeBtn = document.getElementById('updates-addons-upgrade-btn');
    if (upgradeBtn)
        upgradeBtn.classList.toggle('hidden', pending === 0);
    if (!total) {
        list.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs">${escapeHtml(t('updates.no_addons'))}</div>`;
        return;
    }
    list.innerHTML = sorted.map(a => {
        const iconColor = _ADDON_COLOR_MAP[a.color || ''] || _ADDON_COLOR_MAP.slate;
        const iconHtml = a.image
            ? `<img src="${escapeHtml(a.image)}" alt="" class="w-4 h-4 rounded object-contain" loading="lazy">`
            : `<i class="${escapeHtml(a.icon || 'fas fa-puzzle-piece')} ${iconColor}"></i>`;
        let versionHtml, badge, actionHtml;
        if (a.update_available) {
            versionHtml = `<span class="font-mono text-slate-400">${escapeHtml(a.current || '?')}</span><i class="fas fa-arrow-right text-[8px] text-amber-400 mx-1"></i><span class="font-mono text-amber-400 font-semibold">${escapeHtml(a.latest || '?')}</span>`;
            badge = `<span class="upd-badge upd-badge--update"><i class="fas fa-arrow-up"></i>${escapeHtml(t('updates.badge_update'))}</span>`;
            actionHtml = `<button type="button" data-config-action="updateSingleAddon" data-config-slug="${escapeHtml(a.slug)}" class="upd-row-btn"><i class="fas fa-arrow-up"></i></button>`;
        }
        else {
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
    if (!el)
        return;
    if (type === 'hidden') {
        el.classList.add('hidden');
        return;
    }
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
        if (!dd)
            return;
        const target = e.target;
        if (!(target instanceof Element))
            return;
        const toggleBtn = target.closest('[data-action="toggle-updates-interval"]');
        if (toggleBtn && dd.contains(toggleBtn)) {
            e.preventDefault();
            e.stopPropagation();
            dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
            return;
        }
        const opt = target.closest('.dashboard-custom-select__option');
        if (opt && dd.contains(opt)) {
            e.preventDefault();
            e.stopPropagation();
            const value = opt.dataset.value || '';
            const labelKey = opt.dataset.labelKey;
            const label = labelKey ? t(labelKey) : (opt.textContent || '').trim();
            setUpdatesInterval(value, label);
            return;
        }
        if (!dd.contains(target))
            dd.dataset.open = 'false';
    });
}
function _bindUpdatesIntervalDropdownOnce() { }
export function toggleUpdatesIntervalDropdown() {
    const dd = document.getElementById('updates_interval_dropdown');
    if (!dd)
        return;
    dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
}
export function setUpdatesInterval(value, label) {
    const dd = document.getElementById('updates_interval_dropdown');
    const hidden = document.getElementById('updates_addons_check_interval');
    const lbl = label || _intervalLabel(value);
    if (dd) {
        dd.dataset.open = 'false';
        const valueEl = dd.querySelector('.dashboard-custom-select__value');
        if (valueEl)
            valueEl.textContent = lbl;
        dd.querySelectorAll('.dashboard-custom-select__option').forEach(o => {
            const opt = o;
            opt.dataset.selected = opt.dataset.value === value ? 'true' : 'false';
        });
    }
    if (hidden) {
        hidden.value = value;
        try {
            hidden.dispatchEvent(new Event('change', { bubbles: true }));
        }
        catch (_) { }
    }
}
export function syncUpdatesIntervalDropdown() {
    _bindUpdatesIntervalDropdownOnce();
    const hidden = document.getElementById('updates_addons_check_interval');
    const dd = document.getElementById('updates_interval_dropdown');
    if (!hidden || !dd)
        return;
    const val = hidden.value || 'never';
    const valueEl = dd.querySelector('.dashboard-custom-select__value');
    if (valueEl)
        valueEl.textContent = _intervalLabel(val);
    dd.querySelectorAll('.dashboard-custom-select__option').forEach(o => {
        const opt = o;
        opt.dataset.selected = opt.dataset.value === val ? 'true' : 'false';
    });
}
