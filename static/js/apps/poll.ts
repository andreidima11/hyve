import { apiCall } from '../api.js';
import { escapeHtml } from '../utils.js';
import { t } from '../lang/index.js';

import type { AddonProcessStatus, AddonProcessStatusMap } from '../types/features_apps.js';
import { appsState } from './state.js';
import * as render from './render.js';

export async function refreshDetailStatus(slug: string) {
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/status`);
        const s = await res.json();
        appsState.statusMap[slug] = s;
        updateDetailUI(s);
    } catch (_) {}
}

function updateDetailUI(s: AddonProcessStatus) {
    const detail = document.getElementById('app-detail') as HTMLElement | null;
    const slug = detail?.dataset.slug;
    const cached = slug ? appsState.addonsCache.find(a => a.slug === slug) : undefined;
    const enabled = !!cached?.state?.enabled;

    const st = enabled ? (s?.status || 'stopped') : 'stopped';
    const isRunning = enabled && st === 'running';
    const canStart = enabled && !isRunning;

    const badge = document.getElementById('app-detail-badge');
    if (badge) {
        badge.innerHTML = enabled
            ? render._statusBadge(st)
            : `<span class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-500/15 text-slate-400"><i class="fas fa-circle text-[6px]"></i>${escapeHtml(t('hy.addon_status_disabled'))}</span>`;
    }

    const pidEl = document.getElementById('app-detail-pid');
    if (pidEl) pidEl.textContent = String(s?.pid ?? '—');

    const upWrap = document.getElementById('app-detail-uptime-wrap');
    const upEl = document.getElementById('app-detail-uptime');
    if (upWrap) upWrap.classList.toggle('hidden', !s?.uptime);
    if (upEl) upEl.textContent = render._uptime(s?.uptime);

    const startBtn = document.getElementById('app-detail-start') as HTMLButtonElement | null;
    const stopBtn = document.getElementById('app-detail-stop') as HTMLButtonElement | null;
    const restartBtn = document.getElementById('app-detail-restart') as HTMLButtonElement | null;
    if (startBtn) { startBtn.disabled = !canStart; startBtn.classList.toggle('opacity-40', !canStart); }
    if (stopBtn) { stopBtn.disabled = !isRunning; stopBtn.classList.toggle('opacity-40', !isRunning); }
    if (restartBtn) { restartBtn.disabled = !isRunning; restartBtn.classList.toggle('opacity-40', !isRunning); }
}

export function startPoll() {
    stopPoll();
    appsState.pollTimer = setInterval(async () => {
        const panel = document.getElementById('cfg-tab-addons');
        if (!panel || panel.classList.contains('hidden')) { stopPoll(); return; }

        try {
            const detail = document.getElementById('app-detail') as HTMLElement | null;
            if (detail) {
                const slug = detail.dataset.slug;
                if (slug) await refreshDetailStatus(slug);
                return;
            }

            const res = await apiCall('/api/addons/process/status');
            const statuses = await res.json() as AddonProcessStatusMap;
            appsState.statusMap = statuses;
            document.querySelectorAll('[data-addon-row]').forEach((row) => {
                const rowEl = row as HTMLElement;
                const slug = rowEl.dataset.addonRow;
                if (!slug) return;
                const cached = appsState.addonsCache.find(a => a.slug === slug);
                if (!cached) return;
                const tagsEl = rowEl.querySelector('.hyd-entity-row__tags');
                if (tagsEl) tagsEl.innerHTML = render._addonRowTags(cached, statuses[slug]);
            });
        } catch (_) {}
    }, 5000);
}

export function stopPoll() {
    if (appsState.pollTimer) { clearInterval(appsState.pollTimer); appsState.pollTimer = null; }
}
