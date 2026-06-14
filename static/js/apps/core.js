/**
 * Apps page — list, detail, actions.
 */
import { apiCall } from '../api.js';
import { showToast, escapeHtml } from '../utils.js';
import { t, translateApiDetail } from '../lang/index.js';
import { appsState } from './state.js';
import * as render from './render.js';
import { startPoll, refreshDetailStatus } from './poll.js';
import { toggleAddonWatchdog } from './lifecycle.js';
function _wireAddonDetailControls(slug) {
    const cb = document.getElementById(`addon-watchdog-${slug}`);
    if (!cb || cb.dataset.watchdogBound === '1')
        return;
    cb.dataset.watchdogBound = '1';
    cb.addEventListener('change', () => {
        void toggleAddonWatchdog(slug, cb.checked);
    });
}
export async function loadApps() {
    const container = document.getElementById('apps-list');
    if (!container)
        return;
    try {
        const [addonsRes, statusRes] = await Promise.all([
            apiCall('/api/addons'),
            apiCall('/api/addons/process/status'),
        ]);
        const addons = await addonsRes.json();
        const statuses = await statusRes.json();
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
                _wireAddonDetailControls(addon.slug);
                startPoll();
                return;
            }
        }
        container.innerHTML = addons.map(a => render._renderSummaryCard(a, statuses[a.slug])).join('');
        startPoll();
    }
    catch (e) {
        container.innerHTML = `<div class="p-8 text-center text-red-400 text-sm">${escapeHtml(t('common.error'))}: ${escapeHtml(String(e))}</div>`;
    }
}
// ── detail open/close ───────────────────────────────────────────────────
export async function openAppDetail(slug) {
    appsState.openSlug = slug;
    const container = document.getElementById('apps-list');
    if (!container)
        return;
    try {
        const [addonRes, statusRes] = await Promise.all([
            apiCall(`/api/addons/${encodeURIComponent(slug)}`),
            apiCall(`/api/addons/${encodeURIComponent(slug)}/status`),
        ]);
        const addon = await addonRes.json();
        const status = await statusRes.json();
        const idx = appsState.addonsCache.findIndex(a => a.slug === addon.slug);
        if (idx >= 0)
            appsState.addonsCache[idx] = addon;
        else
            appsState.addonsCache.push(addon);
        container.innerHTML = render._renderDetail(addon, status);
        _wireAddonDetailControls(slug);
    }
    catch (e) {
        showToast(t('apps.error_detail', { message: render._errMsg(e) }), 'error');
    }
}
export function closeAppDetail() {
    appsState.openSlug = null;
    loadApps();
}
// ── actions ─────────────────────────────────────────────────────────────
export async function appAction(slug, action) {
    const ev = window.event;
    const btn = ev?.target?.closest?.('button');
    if (btn) {
        btn.disabled = true;
        btn.classList.add('opacity-50');
    }
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/${action}`, { method: 'POST' });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(translateApiDetail(data.detail) || res.statusText || t('common.error'));
        }
        showToast(t('apps.process_action_ok', { slug, action }), 'success');
        // Re-fetch status to update buttons
        await refreshDetailStatus(slug);
    }
    catch (e) {
        showToast(t('apps.process_action_error', { slug, message: render._errMsg(e) }), 'error');
    }
    finally {
        if (btn) {
            btn.disabled = false;
            btn.classList.remove('opacity-50');
        }
    }
}
