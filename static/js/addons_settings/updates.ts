/**
 * Add-ons settings: Updates hub (Hyve + add-ons) + check interval dropdown.
 */
import { apiCall } from '../api.js';
import { t } from '../lang/index.js';
import { showConfirm, escapeHtml, formatMarkdown } from '../utils.js';
import { isExplicitNonAdmin } from '../user_context.js';
import { translateApiDetail } from '../lang/index.js';
import type { AddonUpdateRow, HyveUpdateStatus } from './types.js';

let _addonUpdatesCache: AddonUpdateRow[] = [];
let _hyveUpdateCache: HyveUpdateStatus | null = null;

interface ReleaseNotesEntry {
    title: string;
    version: string;
    body: string;
    url: string;
}

const _releaseNotesCache = new Map<string, ReleaseNotesEntry>();

function _updatesEl<T extends HTMLElement>(primaryId: string, ...legacyIds: string[]): T | null {
    return (document.getElementById(primaryId)
        ?? legacyIds.map(id => document.getElementById(id)).find(Boolean)
        ?? null) as T | null;
}

function _updatesListEl(): HTMLElement | null {
    return _updatesEl('updates-list', 'updates-addons-list');
}

/** Hide legacy split Hyve/add-ons chrome when rendering the unified list. */
function _normalizeLegacyLayout(): void {
    document.getElementById('updates-panel-hyve')?.classList.add('hidden');
    const legacyHyveList = document.getElementById('updates-hyve-list');
    if (legacyHyveList) legacyHyveList.innerHTML = '';
    const addonsHeading = document.getElementById('updates-panel-addons')?.querySelector('h3');
    addonsHeading?.classList.add('hidden');
}

function _setListLoading(): void {
    const html = `<div class="text-center py-8 text-slate-500 text-xs"><i class="fas fa-spinner fa-spin mr-2"></i>${escapeHtml(t('updates.loading'))}</div>`;
    const list = _updatesListEl();
    if (list) list.innerHTML = html;
}

function _setListError(msg: string): void {
    const html = `<div class="text-center py-8 text-red-400 text-xs"><i class="fas fa-triangle-exclamation mr-2"></i>${msg}</div>`;
    const list = _updatesListEl();
    if (list) list.innerHTML = html;
}

/** Update the iOS-style badge on the Updates hub card with the number of available updates. */
export function updateHeaderUpdatesBadge(count: number | string) {
    const badge = document.getElementById('hub-updates-badge-count');
    if (!badge) return;
    const n = Math.max(0, typeof count === 'number' ? count : parseInt(String(count), 10) || 0);
    if (n <= 0) {
        badge.classList.add('hidden');
        return;
    }
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.classList.remove('hidden');
    badge.style.animation = 'none';
    void badge.offsetWidth;
    badge.style.animation = '';
}

/** Background poll for available updates and refresh the header badge. */
export async function refreshUpdatesHeaderBadge() {
    if (isExplicitNonAdmin()) return;
    try {
        const res = await apiCall('/api/updates/addons');
        if (!res.ok) return;
        const data = await res.json() as { total_updates?: number };
        updateHeaderUpdatesBadge(data?.total_updates || 0);
    } catch (_) {}
}

export async function loadUpdatesAddons() {
    _normalizeLegacyLayout();
    _setListLoading();
    _setUpdatesStatus('', 'hidden');
    _setHyveHint('');
    try {
        const res = await apiCall('/api/updates/addons');
        if (!res.ok) {
            const err = await res.json().catch(() => ({})) as { detail?: unknown };
            throw new Error(translateApiDetail(err.detail) || res.statusText || t('common.error'));
        }
        const data = await res.json() as {
            hyve?: HyveUpdateStatus;
            addons?: AddonUpdateRow[];
            total_updates?: number;
        };
        _hyveUpdateCache = data.hyve || null;
        _addonUpdatesCache = data.addons || [];
        updateHeaderUpdatesBadge(data.total_updates || 0);
        _renderUpdateRows();
    } catch (e) {
        _setListError(escapeHtml(e instanceof Error ? e.message : String(e)));
    }
}

export async function checkAddonUpdates() {
    const btn = _updatesEl<HTMLButtonElement>('updates-check-btn', 'updates-addons-check-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('updates.check_btn'))}</span>`; }
    _setUpdatesStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('updates.checking'))}`, 'info');
    try {
        const results = await Promise.allSettled([
            apiCall('/api/updates/hyve/check', { method: 'POST' }),
            apiCall('/api/updates/addons/check', { method: 'POST' }),
        ]);
        await loadUpdatesAddons();
        const hyvePending = _hyveUpdateCache?.update_available ? 1 : 0;
        const addonPending = _addonUpdatesCache.filter(a => a.update_available).length;
        const total = hyvePending + addonPending;
        const checkFailed = results.some(r => r.status === 'rejected'
            || (r.status === 'fulfilled' && !r.value.ok));
        if (_hyveUpdateCache?.error?.key) {
            _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(translateApiDetail(_hyveUpdateCache.error))}`, 'error');
        } else if (checkFailed && total === 0) {
            _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(t('updates.check_failed'))}`, 'error');
        } else if (total > 0) {
            _setUpdatesStatus(`<i class="fas fa-arrow-up mr-1.5"></i>${escapeHtml(t('updates.n_updates_available', { count: total }))}`, 'warning');
        } else {
            _setUpdatesStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('updates.all_up_to_date'))}`, 'success');
        }
    } catch (e) {
        _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-rotate"></i><span>${escapeHtml(t('updates.check_btn'))}</span>`; }
    }
}

export async function applyHyveUpdate() {
    const hyve = _hyveUpdateCache;
    if (!hyve?.update_available) return;
    const latest = hyve.latest || hyve.tag || '?';
    if (!(await showConfirm(t('updates.confirm_update_hyve', { version: latest })))) return;

    const upgradeBtn = document.getElementById('updates-hyve-upgrade-btn') as HTMLButtonElement | null;
    if (upgradeBtn) {
        upgradeBtn.disabled = true;
        upgradeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i>`;
    }
    _setUpdatesStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('updates.hyve_installing'))}`, 'info');
    try {
        const res = await apiCall('/api/updates/hyve/apply', { method: 'POST', timeout: 300000 });
        const data = await res.json().catch(() => ({})) as { detail?: unknown; version?: string };
        if (!res.ok) {
            throw new Error(translateApiDetail(data.detail) || t('updates.save_error'));
        }
        _setUpdatesStatus(`<i class="fas fa-circle-check mr-1.5"></i>${escapeHtml(t('updates.hyve_updated_restarting', { version: data.version || latest }))}`, 'success');
    } catch (e) {
        _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    } finally {
        if (upgradeBtn) {
            upgradeBtn.disabled = false;
            upgradeBtn.innerHTML = `<i class="fas fa-arrow-up"></i>`;
        }
    }
}

export async function updateAllAddons() {
    const pending = _addonUpdatesCache.filter(a => a.update_available);
    if (!pending.length) return;
    if (!(await showConfirm(t('updates.confirm_update_addons', { count: pending.length })))) return;
    await _runAddonUpdate({ all: true });
}

export async function updateSingleAddon(slug: string) {
    const addon = _addonUpdatesCache.find(a => a.slug === slug);
    const name = addon ? addon.name : slug;
    if (!(await showConfirm(t('updates.confirm_update_addon', { name })))) return;
    await _runAddonUpdate({ slugs: [slug] });
}

async function _runAddonUpdate(body: { all?: boolean; slugs?: string[] }) {
    const upgradeBtn = _updatesEl<HTMLButtonElement>('updates-upgrade-all-btn', 'updates-addons-upgrade-btn');
    if (upgradeBtn) { upgradeBtn.disabled = true; upgradeBtn.innerHTML = `<i class="fas fa-spinner fa-spin"></i><span>${escapeHtml(t('updates.upgrade_btn_loading'))}</span>`; }
    _setUpdatesStatus(`<i class="fas fa-spinner fa-spin mr-1.5"></i>${escapeHtml(t('updates.installing'))}`, 'info');
    try {
        const res = await apiCall('/api/updates/addons/update', { method: 'POST', body });
        const data = await res.json() as {
            status?: string;
            updated?: unknown[];
            message?: string;
            failed?: Array<{ slug?: string; error?: string }>;
        };
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
        _setUpdatesStatus(`<i class="fas fa-triangle-exclamation mr-1.5"></i>${escapeHtml(e instanceof Error ? e.message : String(e))}`, 'error');
    } finally {
        if (upgradeBtn) { upgradeBtn.disabled = false; upgradeBtn.innerHTML = `<i class="fas fa-arrow-up"></i><span>${escapeHtml(t('updates.upgrade_all_btn'))}</span>`; }
    }
}

const _ADDON_COLOR_MAP: Record<string, string> = {
    cyan: 'text-cyan-400', blue: 'text-blue-400', purple: 'text-purple-400',
    fuchsia: 'text-fuchsia-400', amber: 'text-amber-400', red: 'text-red-400',
    green: 'text-green-400', emerald: 'text-emerald-400', slate: 'text-slate-400',
    indigo: 'text-indigo-400', rose: 'text-rose-400',
};

function _displayVersion(value: unknown): string {
    const raw = String(value ?? '').trim();
    if (!raw || raw.length > 64) return '?';
    if (raw.includes('<') || raw.toUpperCase().includes('DOCTYPE')) return '?';
    return raw;
}

function _cacheHyveReleaseNotes(hyve: HyveUpdateStatus): void {
    const version = _displayVersion(hyve.latest || hyve.tag || hyve.current);
    _releaseNotesCache.set('hyve', {
        title: 'Hyve',
        version,
        body: String(hyve.release_notes || '').trim(),
        url: String(hyve.release_url || '').trim(),
    });
}

function _hasReleaseNotes(target: string): boolean {
    const entry = _releaseNotesCache.get(target);
    if (!entry) return false;
    return !!(entry.body || entry.url);
}

function _releaseNotesBtnHtml(target: string): string {
    if (!_hasReleaseNotes(target)) return '';
    return `<button type="button" data-config-action="showUpdateReleaseNotes" data-config-target="${escapeHtml(target)}" class="upd-row-btn" title="${escapeHtml(t('updates.release_notes_btn'))}"><i class="fas fa-file-lines"></i></button>`;
}

function _ensureReleaseNotesModal(): HTMLElement {
    let modal = document.getElementById('update-release-notes-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'update-release-notes-modal';
    modal.className = 'modal-overlay app-modal fixed inset-0 z-[80] hidden flex items-center justify-center p-2 sm:p-4';
    modal.innerHTML = `
        <div class="glass app-modal-panel app-modal-content max-w-2xl w-full max-h-[85vh] flex flex-col">
            <div class="app-modal-header flex-shrink-0">
                <div class="min-w-0">
                    <h3 id="update-release-notes-title" class="text-sm font-bold text-accent uppercase tracking-widest flex items-center gap-2">
                        <i class="fas fa-file-lines"></i>
                        <span></span>
                    </h3>
                    <p id="update-release-notes-subtitle" class="app-modal-subtitle"></p>
                </div>
                <button type="button" class="app-modal-close" data-config-action="closeUpdateReleaseNotes" aria-label="Close">
                    <i class="fas fa-xmark"></i>
                </button>
            </div>
            <div id="update-release-notes-body" class="app-modal-body overflow-y-auto prose prose-invert prose-sm max-w-none text-slate-300"></div>
            <div id="update-release-notes-footer" class="flex-shrink-0 px-4 pb-4 pt-2 border-t border-white/[0.06] hidden">
                <a id="update-release-notes-link" href="#" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1.5 text-[11px] font-semibold text-accent hover:text-accent-hover">
                    <i class="fas fa-arrow-up-right-from-square"></i><span></span>
                </a>
            </div>
        </div>`;
    modal.addEventListener('click', (e) => {
        if (e.target === modal) hideUpdateReleaseNotes();
    });
    modal.querySelector('.app-modal-panel')?.addEventListener('click', (e) => e.stopPropagation());
    modal.querySelector('[data-config-action="closeUpdateReleaseNotes"]')?.addEventListener('click', (e) => {
        e.preventDefault();
        hideUpdateReleaseNotes();
    });
    document.body.appendChild(modal);
    return modal;
}

export function showUpdateReleaseNotes(target = 'hyve'): void {
    const entry = _releaseNotesCache.get(target);
    if (!entry) return;
    const modal = _ensureReleaseNotesModal();
    const titleSpan = modal.querySelector('#update-release-notes-title span');
    const subtitle = modal.querySelector('#update-release-notes-subtitle');
    const body = modal.querySelector('#update-release-notes-body');
    const footer = modal.querySelector('#update-release-notes-footer');
    const link = modal.querySelector('#update-release-notes-link') as HTMLAnchorElement | null;
    const linkLabel = modal.querySelector('#update-release-notes-link span');

    if (titleSpan) titleSpan.textContent = t('updates.release_notes_title', { name: entry.title });
    if (subtitle) {
        subtitle.textContent = entry.version && entry.version !== '?'
            ? t('updates.release_notes_version', { version: entry.version })
            : '';
    }
    if (body) {
        body.innerHTML = entry.body
            ? formatMarkdown(entry.body)
            : `<p class="text-slate-500 text-sm">${escapeHtml(t('updates.release_notes_empty'))}</p>`;
    }
    if (footer && link && linkLabel) {
        if (entry.url) {
            link.href = entry.url;
            linkLabel.textContent = t('updates.release_notes_github');
            footer.classList.remove('hidden');
        } else {
            footer.classList.add('hidden');
            link.href = '#';
        }
    }
    modal.classList.remove('hidden');
}

export function hideUpdateReleaseNotes(): void {
    document.getElementById('update-release-notes-modal')?.classList.add('hidden');
}

function _hyveRowHtml(hyve: HyveUpdateStatus): string {
    _cacheHyveReleaseNotes(hyve);
    const current = _displayVersion(hyve.current);
    const latest = _displayVersion(hyve.latest);
    let versionHtml: string;
    let badge: string;
    let actionHtml = _releaseNotesBtnHtml('hyve');
    let rowClass = 'upd-row';

    if (hyve.error?.key) {
        versionHtml = `<span class="font-mono text-slate-400">${escapeHtml(current)}</span>`;
        badge = `<span class="upd-badge upd-badge--warn"><i class="fas fa-triangle-exclamation"></i>${escapeHtml(t('updates.badge_check_failed'))}</span>`;
        rowClass += ' upd-row--outdated';
    } else if (hyve.update_available) {
        versionHtml = `<span class="font-mono text-slate-400">${escapeHtml(current)}</span><i class="fas fa-arrow-right text-[8px] text-amber-400 mx-1"></i><span class="font-mono text-amber-400 font-semibold">${escapeHtml(latest)}</span>`;
        badge = `<span class="upd-badge upd-badge--update"><i class="fas fa-arrow-up"></i>${escapeHtml(t('updates.badge_update'))}</span>`;
        rowClass += ' upd-row--outdated';
        if (hyve.git_available) {
            actionHtml += `<button type="button" data-config-action="applyHyveUpdate" id="updates-hyve-upgrade-btn" class="upd-row-btn" title="${escapeHtml(t('updates.hyve_upgrade_btn'))}"><i class="fas fa-arrow-up"></i></button>`;
        }
    } else {
        versionHtml = `<span class="font-mono text-slate-400">${escapeHtml(current)}</span>`;
        badge = `<span class="upd-badge upd-badge--ok"><i class="fas fa-check"></i>${escapeHtml(t('updates.badge_up_to_date'))}</span>`;
    }

    return `<div class="${rowClass}">
        <div class="upd-row-main">
            <span class="upd-row-icon inline-flex items-center justify-center flex-shrink-0"><i class="fas fa-house text-accent"></i></span>
            <span class="upd-row-name">Hyve</span>
        </div>
        <div class="upd-row-version">${versionHtml}</div>
        <div class="upd-row-status">${badge}${actionHtml}</div>
    </div>`;
}

function _addonRowHtml(a: AddonUpdateRow): string {
    const iconColor = _ADDON_COLOR_MAP[a.color || ''] || _ADDON_COLOR_MAP.slate;
    const iconHtml = a.image
        ? `<img src="${escapeHtml(a.image)}" alt="" class="w-4 h-4 rounded object-contain" loading="lazy">`
        : `<i class="${escapeHtml(a.icon || 'fas fa-puzzle-piece')} ${iconColor}"></i>`;

    let versionHtml: string;
    let badge: string;
    let actionHtml: string;
    if (a.update_available) {
        versionHtml = `<span class="font-mono text-slate-400">${escapeHtml(_displayVersion(a.current))}</span><i class="fas fa-arrow-right text-[8px] text-amber-400 mx-1"></i><span class="font-mono text-amber-400 font-semibold">${escapeHtml(_displayVersion(a.latest))}</span>`;
        badge = `<span class="upd-badge upd-badge--update"><i class="fas fa-arrow-up"></i>${escapeHtml(t('updates.badge_update'))}</span>`;
        actionHtml = `<button type="button" data-config-action="updateSingleAddon" data-config-slug="${escapeHtml(a.slug)}" class="upd-row-btn" title="${escapeHtml(t('updates.upgrade_btn'))}"><i class="fas fa-arrow-up"></i></button>`;
    } else {
        versionHtml = `<span class="font-mono text-slate-400">${escapeHtml(_displayVersion(a.current || a.latest))}</span>`;
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
}

function _renderUpdateRows() {
    _normalizeLegacyLayout();
    const list = _updatesListEl();
    if (!list) return;

    const hyve = _hyveUpdateCache;
    const sorted = [..._addonUpdatesCache].sort((a, b) => {
        if (!!a.update_available !== !!b.update_available) return a.update_available ? -1 : 1;
        return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    });

    const addonTotal = sorted.length;
    const addonPending = sorted.filter(a => a.update_available).length;
    const totalItems = (hyve ? 1 : 0) + addonTotal;

    const countEl = _updatesEl('updates-count', 'updates-addons-count');
    if (countEl) {
        countEl.textContent = totalItems
            ? t('updates.items_count', { count: totalItems })
            : t('updates.no_addons');
    }

    const upgradeBtn = _updatesEl('updates-upgrade-all-btn', 'updates-addons-upgrade-btn');
    if (upgradeBtn) upgradeBtn.classList.toggle('hidden', addonPending === 0);

    if (!hyve && !addonTotal) {
        list.innerHTML = `<div class="text-center py-8 text-slate-500 text-xs">${escapeHtml(t('updates.no_addons'))}</div>`;
        _setHyveHint('');
        return;
    }

    const rows: string[] = [];
    if (hyve) rows.push(_hyveRowHtml(hyve));
    rows.push(...sorted.map(_addonRowHtml));
    list.innerHTML = rows.join('');

    const hints: string[] = [];
    if (hyve && !hyve.git_available) hints.push(t('updates.hyve_hint_not_git'));
    _setHyveHint(hints.length ? hints.join(' · ') : '');
}

function _setUpdatesStatus(html: string, type: 'hidden' | 'info' | 'success' | 'warning' | 'error') {
    const el = _updatesEl('updates-status', 'updates-addons-status');
    if (!el) return;
    if (type === 'hidden') { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const colors: Record<string, string> = {
        info: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
        success: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
        warning: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
        error: 'bg-red-500/10 border-red-500/20 text-red-400',
    };
    el.className = `text-[11px] rounded-xl p-3 border ${colors[type] || colors.info}`;
    el.innerHTML = html;
}

function _setHyveHint(text: string) {
    const el = document.getElementById('updates-hyve-hint');
    if (!el) return;
    if (!text) {
        el.classList.add('hidden');
        el.textContent = '';
        return;
    }
    el.classList.remove('hidden');
    el.textContent = text;
}

// --- Updates interval custom dropdown ---

function _intervalLabel(val: string) {
    const key = ({ never: 'updates.interval_never', daily: 'updates.interval_daily', weekly: 'updates.interval_weekly', monthly: 'updates.interval_monthly' } as Record<string, string>)[val];
    return key ? t(key) : val;
}

let _updatesDropdownBound = false;

if (typeof document !== 'undefined' && !_updatesDropdownBound) {
    _updatesDropdownBound = true;
    document.addEventListener('click', (e) => {
        const dd = document.getElementById('updates_interval_dropdown');
        if (!dd) return;
        const target = e.target;
        if (!(target instanceof Element)) return;
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
            const value = (opt as HTMLElement).dataset.value || '';
            const labelKey = (opt as HTMLElement).dataset.labelKey;
            const label = labelKey ? t(labelKey) : (opt.textContent || '').trim();
            setUpdatesInterval(value, label);
            return;
        }
        if (!dd.contains(target)) dd.dataset.open = 'false';
    });
}

function _bindUpdatesIntervalDropdownOnce() { /* legacy stub */ }

export function toggleUpdatesIntervalDropdown() {
    const dd = document.getElementById('updates_interval_dropdown');
    if (!dd) return;
    dd.dataset.open = dd.dataset.open === 'true' ? 'false' : 'true';
}

export function setUpdatesInterval(value: string, label?: string) {
    const dd = document.getElementById('updates_interval_dropdown');
    const hidden = document.getElementById('updates_addons_check_interval') as HTMLInputElement | null;
    const lbl = label || _intervalLabel(value);
    if (dd) {
        dd.dataset.open = 'false';
        const valueEl = dd.querySelector('.dashboard-custom-select__value');
        if (valueEl) valueEl.textContent = lbl;
        dd.querySelectorAll('.dashboard-custom-select__option').forEach(o => {
            const opt = o as HTMLElement;
            opt.dataset.selected = opt.dataset.value === value ? 'true' : 'false';
        });
    }
    if (hidden) {
        hidden.value = value;
        try { hidden.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    }
}

export function syncUpdatesIntervalDropdown() {
    _bindUpdatesIntervalDropdownOnce();
    const hidden = document.getElementById('updates_addons_check_interval') as HTMLInputElement | null;
    const dd = document.getElementById('updates_interval_dropdown');
    if (!hidden || !dd) return;
    const val = hidden.value || 'never';
    const valueEl = dd.querySelector('.dashboard-custom-select__value');
    if (valueEl) valueEl.textContent = _intervalLabel(val);
    dd.querySelectorAll('.dashboard-custom-select__option').forEach(o => {
        const opt = o as HTMLElement;
        opt.dataset.selected = opt.dataset.value === val ? 'true' : 'false';
    });
}
