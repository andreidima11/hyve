/**
 * Apps page — list, detail, actions.
 */
import { apiCall } from '../api.js';
import { showToast, escapeHtml } from '../utils.js';
import { t, translateApiDetail } from '../lang/index.js';
import { listShellErrorHtml, listShellLoadingHtml, wireConfigListSearch } from '../config/list_shell.js';
import type {
    AddonCatalogEntry,
    AddonProcessStatus,
    AddonProcessStatusMap,
} from '../types/features_apps.js';

import { appsState } from './state.js';
import * as render from './render.js';
import { startPoll, stopPoll, refreshDetailStatus } from './poll.js';
import { toggleAddonWatchdog } from './lifecycle.js';

if (typeof window !== 'undefined') {
    window.addEventListener('hyve:i18n-bundles-loaded', () => {
        if (document.getElementById('apps-list') && appsState.addonsCache.length) {
            render._renderAppsList();
        }
    });
}

function _wireAddonDetailControls(slug: string) {
    const cb = document.getElementById(`addon-watchdog-${slug}`) as HTMLInputElement | null;
    if (!cb || cb.dataset.watchdogBound === '1') return;
    cb.dataset.watchdogBound = '1';
    cb.addEventListener('change', () => {
        void toggleAddonWatchdog(slug, cb.checked);
    });
}

function _syncAppsSubviewChrome(mode: 'list' | 'detail') {
    const isDetail = mode === 'detail';
    document.getElementById('config-standalone')?.classList.toggle('hyd-config-standalone--subview', isDetail);
    document.getElementById('cfg-tab-addons')?.classList.toggle('hyd-config-page--detail', isDetail);
}

function _setAppsViewMode(mode: 'list' | 'detail') {
    document.getElementById('apps-list-chrome')?.classList.toggle('hidden', mode === 'detail');
    document.getElementById('apps-list-shell')?.classList.toggle('hidden', mode === 'detail');
    const detailView = document.getElementById('apps-detail-view');
    if (detailView) detailView.classList.toggle('hidden', mode !== 'detail');
    _syncAppsSubviewChrome(mode);
}

export function resetAppsDetailView() {
    appsState.openSlug = null;
    _setAppsViewMode('list');
    const detailView = document.getElementById('apps-detail-view');
    if (detailView) detailView.innerHTML = '';
}

function _ensureAppsSearch() {
    wireConfigListSearch('apps-search', (query) => {
        appsState.listFilter = query;
        render._renderAppsList();
    });
}

export async function loadApps() {
    const container = document.getElementById('apps-list');
    if (!container) return;

    _ensureAppsSearch();
    _setAppsViewMode('list');

    if (!appsState.addonsCache.length) {
        container.innerHTML = listShellLoadingHtml(escapeHtml(t('config.addons_loading')));
    }

    try {
        const [addonsRes, statusRes] = await Promise.all([
            apiCall('/api/addons'),
            apiCall('/api/addons/process/status'),
        ]);
        const addons = await addonsRes.json() as AddonCatalogEntry[];
        const statuses = await statusRes.json() as AddonProcessStatusMap;

        appsState.addonsCache = addons;
        appsState.statusMap = statuses;

        if (!addons.length) {
            render._renderAppsList();
            return;
        }

        if (appsState.openSlug) {
            const addon = addons.find(a => a.slug === appsState.openSlug);
            if (addon) {
                await _showAppDetail(addon, statuses[addon.slug]);
                return;
            }
        }

        render._renderAppsList();
        startPoll();
    } catch (e) {
        if (container) {
            container.innerHTML = listShellErrorHtml(escapeHtml(e instanceof Error ? e.message : String(e)));
        }
    }
}

async function _showAppDetail(addon: AddonCatalogEntry, status: AddonProcessStatus | undefined) {
    const detailView = document.getElementById('apps-detail-view');
    if (!detailView) return;
    _setAppsViewMode('detail');
    detailView.innerHTML = `<div class="hyd-config-page">${render._renderDetail(addon, status)}</div>`;
    _wireAddonDetailControls(addon.slug);
    startPoll();
}

// ── detail open/close ───────────────────────────────────────────────────

export async function openAppDetail(slug: string) {
    appsState.openSlug = slug;

    try {
        const [addonRes, statusRes] = await Promise.all([
            apiCall(`/api/addons/${encodeURIComponent(slug)}`),
            apiCall(`/api/addons/${encodeURIComponent(slug)}/status`),
        ]);
        const addon = await addonRes.json() as AddonCatalogEntry;
        const status = await statusRes.json() as AddonProcessStatus;
        const idx = appsState.addonsCache.findIndex(a => a.slug === addon.slug);
        if (idx >= 0) appsState.addonsCache[idx] = addon;
        else appsState.addonsCache.push(addon);
        appsState.statusMap[addon.slug] = status;

        await _showAppDetail(addon, status);
    } catch (e) {
        showToast(t('apps.error_detail', { message: render._errMsg(e) }), 'error');
    }
}

export function closeAppDetail() {
    appsState.openSlug = null;
    loadApps();
}

// ── actions ─────────────────────────────────────────────────────────────

export async function appAction(slug: string, action: string) {
    const ev = window.event as MouseEvent | undefined;
    const btn = (ev?.target as HTMLElement | null)?.closest?.('button') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.classList.add('opacity-50'); }

    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/${action}`, { method: 'POST' });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(translateApiDetail(data.detail) || res.statusText || t('common.error'));
        }
        showToast(t('apps.process_action_ok', { slug, action }), 'success');
        await refreshDetailStatus(slug);
    } catch (e) {
        showToast(t('apps.process_action_error', { slug, message: render._errMsg(e) }), 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-50'); }
    }
}
