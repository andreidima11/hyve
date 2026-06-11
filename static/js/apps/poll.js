import { apiCall } from '../api.js';
import { appsState } from './state.js';
import * as render from './render.js';
export async function refreshDetailStatus(slug) {
    try {
        const res = await apiCall(`/api/addons/${encodeURIComponent(slug)}/status`);
        const s = await res.json();
        updateDetailUI(s);
    }
    catch (_) { }
}
function updateDetailUI(s) {
    const st = s?.status || 'stopped';
    const isRunning = st === 'running';
    const badge = document.getElementById('app-detail-badge');
    if (badge)
        badge.innerHTML = render._statusBadge(st);
    const pidEl = document.getElementById('app-detail-pid');
    if (pidEl)
        pidEl.textContent = String(s?.pid ?? '—');
    const upWrap = document.getElementById('app-detail-uptime-wrap');
    const upEl = document.getElementById('app-detail-uptime');
    if (upWrap)
        upWrap.classList.toggle('hidden', !s?.uptime);
    if (upEl)
        upEl.textContent = render._uptime(s?.uptime);
    const startBtn = document.getElementById('app-detail-start');
    const stopBtn = document.getElementById('app-detail-stop');
    const restartBtn = document.getElementById('app-detail-restart');
    if (startBtn) {
        startBtn.disabled = isRunning;
        startBtn.classList.toggle('opacity-40', isRunning);
    }
    if (stopBtn) {
        stopBtn.disabled = !isRunning;
        stopBtn.classList.toggle('opacity-40', !isRunning);
    }
    if (restartBtn) {
        restartBtn.disabled = !isRunning;
        restartBtn.classList.toggle('opacity-40', !isRunning);
    }
}
// ── logs ────────────────────────────────────────────────────────────────
export function startPoll() {
    stopPoll();
    appsState.pollTimer = setInterval(async () => {
        const panel = document.getElementById('cfg-tab-addons');
        if (!panel || panel.classList.contains('hidden')) {
            stopPoll();
            return;
        }
        try {
            // If detail view is open, update that
            const detail = document.getElementById('app-detail');
            if (detail) {
                const slug = detail.dataset.slug;
                if (slug)
                    await refreshDetailStatus(slug);
                return;
            }
            // Otherwise update summary list badges
            const res = await apiCall('/api/addons/process/status');
            const statuses = await res.json();
            document.querySelectorAll('.app-summary').forEach(card => {
                const cardEl = card;
                const slug = cardEl.dataset.slug;
                if (!slug)
                    return;
                const s = statuses[slug];
                if (!s)
                    return;
                const badgeWrap = card.querySelector('.app-summary-badge');
                if (badgeWrap) {
                    const cached = appsState.addonsCache.find(a => a.slug === slug);
                    badgeWrap.innerHTML = render._updateIndicator(cached) + render._statusBadge(s.status || 'stopped') + '<i class="fas fa-chevron-right text-slate-600 text-xs ml-3"></i>';
                }
            });
        }
        catch (_) { }
    }, 5000);
}
export function stopPoll() {
    if (appsState.pollTimer) {
        clearInterval(appsState.pollTimer);
        appsState.pollTimer = null;
    }
}
