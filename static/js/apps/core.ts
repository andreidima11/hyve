/**
 * Apps page — list, detail, actions.
 */
import { apiCall } from '../api.js';
import { showToast, escapeHtml, showConfirm } from '../utils.js';
import { t, translateApiDetail } from '../lang/index.js';
import { switchTab, openConfigSection } from '../nav_bridge.js';
import type {
    AddonCatalogEntry,
    AddonColorKey,
    AddonConfigField,
    AddonPreflightCheck,
    AddonProcessStatus,
    AddonProcessStatusMap,
    AddonSerialPort,
} from '../types/features_apps.js';

import { appsState } from './state.js';
import * as render from './render.js';
import { startPoll, stopPoll, refreshDetailStatus } from './poll.js';

export async function loadApps() {
    const container = document.getElementById('apps-list');
    if (!container) return;

    try {
        const [addonsRes, statusRes] = await Promise.all([
            apiCall('/api/addons'),
            apiCall('/api/addons/process/status'),
        ]);
        const addons = await addonsRes.json() as AddonCatalogEntry[];
        const statuses = await statusRes.json() as AddonProcessStatusMap;

        appsState.addonsCache = addons;

        if (!addons.length) {
            container.innerHTML = `<div class="p-8 text-center text-slate-500 text-sm">${escapeHtml(t('hy.addon_list_empty'))}</div>`;
            return;
        }

        // If a detail was open, re-open it; otherwise show list
        if (appsState.openSlug) {
            const addon = addons.find(a => a.slug === appsState.openSlug);
            if (addon) {
                container.innerHTML = render._renderDetail(addon, statuses[addon.slug]);
                startPoll();
                return;
            }
        }

        container.innerHTML = addons.map(a => render._renderSummaryCard(a, statuses[a.slug])).join('');
        startPoll();
    } catch (e) {
        container.innerHTML = `<div class="p-8 text-center text-red-400 text-sm">${escapeHtml(t('common.error'))}: ${escapeHtml(String(e))}</div>`;
    }
}


// ── detail open/close ───────────────────────────────────────────────────

export async function openAppDetail(slug: string) {
    appsState.openSlug = slug;
    const container = document.getElementById('apps-list');
    if (!container) return;

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

        container.innerHTML = render._renderDetail(addon, status);
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
        // Re-fetch status to update buttons
        await refreshDetailStatus(slug);
    } catch (e) {
        showToast(t('apps.process_action_error', { slug, message: render._errMsg(e) }), 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-50'); }
    }
}
