/** Pull-to-refresh for the dashboard view (mobile + trackpad). */

import type { DashboardPullRefreshDeps } from '../types/dashboard.js';

export function initDashboardPullToRefresh(deps: DashboardPullRefreshDeps): void {
    const {
        loadDashboard,
        selectDashboardPage,
        setRefreshIndicator,
        showToast,
        t,
        getCurrentPageId,
    } = deps;

    const view = document.getElementById('view-dashboard');
    if (!view || view.dataset.ptrInit === '1') return;
    const dashboardView: HTMLElement = view;
    dashboardView.dataset.ptrInit = '1';

    const THRESHOLD = 70;
    const MAX_PULL = 110;
    const TRIGGER_OPACITY_AT = 30;

    let startY = 0;
    let pulling = false;
    let triggered = false;
    let indicator: HTMLElement | null = null;
    let refreshing = false;

    function ensureIndicator(): HTMLElement {
        if (indicator) return indicator;
        if (!document.getElementById('dashboard-ptr-style')) {
            const style = document.createElement('style');
            style.id = 'dashboard-ptr-style';
            style.textContent = `
                #dashboard-ptr-indicator {
                    position: absolute;
                    top: 0;
                    left: 50%;
                    width: 44px;
                    height: 44px;
                    transform: translate(-50%, -120%) scale(0.85);
                    transform-origin: 50% 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 9999px;
                    background: var(--surface-glass-heavy, rgba(15,23,42,0.85));
                    backdrop-filter: blur(14px) saturate(140%);
                    -webkit-backdrop-filter: blur(14px) saturate(140%);
                    border: 1px solid var(--border-medium, rgba(255,255,255,0.1));
                    box-shadow: 0 10px 30px rgba(0,0,0,0.35), 0 2px 6px rgba(0,0,0,0.18);
                    color: var(--accent, #38bdf8);
                    pointer-events: none;
                    z-index: 50;
                    opacity: 0;
                    transition: opacity 160ms ease, transform 200ms cubic-bezier(.2,.8,.2,1);
                }
                #dashboard-ptr-indicator[data-state="armed"] {
                    border-color: var(--accent, #38bdf8);
                    box-shadow: 0 10px 30px rgba(0,0,0,0.35), 0 0 0 4px var(--accent-soft, rgba(56,189,248,0.18));
                }
                #dashboard-ptr-ring {
                    position: absolute;
                    inset: 0;
                    width: 100%;
                    height: 100%;
                    transform: rotate(-90deg);
                }
                #dashboard-ptr-ring .track {
                    stroke: var(--border-medium, rgba(255,255,255,0.12));
                    fill: none;
                    stroke-width: 2.5;
                }
                #dashboard-ptr-ring .progress {
                    stroke: var(--accent, #38bdf8);
                    fill: none;
                    stroke-width: 2.5;
                    stroke-linecap: round;
                    stroke-dasharray: 119.38;
                    stroke-dashoffset: 119.38;
                    transition: stroke-dashoffset 120ms ease, opacity 160ms ease;
                    filter: drop-shadow(0 0 6px var(--accent-glow, transparent));
                }
                #dashboard-ptr-icon {
                    position: relative;
                    font-size: 0.85rem;
                    line-height: 1;
                    transition: transform 200ms cubic-bezier(.2,.8,.2,1), opacity 160ms ease;
                    color: var(--accent, #38bdf8);
                }
                #dashboard-ptr-indicator[data-state="refreshing"] #dashboard-ptr-ring .progress {
                    animation: dashboard-ptr-spin 0.9s linear infinite;
                    stroke-dasharray: 30 89.38;
                    stroke-dashoffset: 0;
                }
                #dashboard-ptr-indicator[data-state="refreshing"] #dashboard-ptr-icon {
                    opacity: 0;
                    transform: scale(0.6);
                }
                @keyframes dashboard-ptr-spin {
                    from { transform: rotate(-90deg); }
                    to { transform: rotate(270deg); }
                }
            `;
            document.head.appendChild(style);
        }
        indicator = document.createElement('div');
        indicator.id = 'dashboard-ptr-indicator';
        indicator.setAttribute('aria-hidden', 'true');
        indicator.innerHTML = `
            <svg id="dashboard-ptr-ring" viewBox="0 0 44 44">
                <circle class="track" cx="22" cy="22" r="19"></circle>
                <circle class="progress" cx="22" cy="22" r="19"></circle>
            </svg>
            <i class="fas fa-arrow-down" id="dashboard-ptr-icon"></i>
        `;
        if (getComputedStyle(dashboardView).position === 'static') dashboardView.style.position = 'relative';
        dashboardView.appendChild(indicator);
        return indicator;
    }

    function setIndicator(dist: number, isTriggered: boolean): void {
        const el = ensureIndicator();
        if (el.dataset.state === 'refreshing') return;
        const capped = Math.min(dist, MAX_PULL);
        const progress = Math.min(1, dist / THRESHOLD);
        const scale = 0.85 + 0.15 * progress;
        el.style.transform = `translate(-50%, ${capped - 28}px) scale(${scale.toFixed(3)})`;
        el.style.opacity = dist > TRIGGER_OPACITY_AT ? String(0.55 + 0.45 * progress) : '0';
        el.dataset.state = isTriggered ? 'armed' : 'pulling';
        const ring = el.querySelector('#dashboard-ptr-ring .progress') as SVGCircleElement | null;
        if (ring) ring.style.strokeDashoffset = String(119.38 * (1 - progress));
        const icon = document.getElementById('dashboard-ptr-icon');
        if (icon) icon.style.transform = isTriggered ? 'rotate(180deg)' : `rotate(${progress * 180}deg)`;
    }

    function hideIndicator(): void {
        if (!indicator) return;
        indicator.style.opacity = '0';
        indicator.style.transform = 'translate(-50%, -120%) scale(0.85)';
        indicator.dataset.state = '';
        const ring = indicator.querySelector('#dashboard-ptr-ring .progress') as SVGCircleElement | null;
        if (ring) ring.style.strokeDashoffset = '119.38';
    }

    function showSpinner(): void {
        const el = ensureIndicator();
        el.style.opacity = '1';
        el.style.transform = 'translate(-50%, 16px) scale(1)';
        el.dataset.state = 'refreshing';
    }

    function resetSpinner(): void {
        if (!indicator) return;
        indicator.dataset.state = '';
        const icon = document.getElementById('dashboard-ptr-icon');
        if (icon) {
            icon.className = 'fas fa-arrow-down';
            icon.style.transform = '';
            icon.style.opacity = '';
        }
        const ring = indicator.querySelector('#dashboard-ptr-ring .progress') as SVGCircleElement | null;
        if (ring) ring.style.strokeDashoffset = '119.38';
    }

    async function doRefresh(): Promise<void> {
        if (refreshing) return;
        refreshing = true;
        showSpinner();
        const safety = setTimeout(() => {
            try {
                refreshing = false;
                setRefreshIndicator(false);
                hideIndicator();
                resetSpinner();
            } catch { /* ignore */ }
        }, 12000);
        try {
            const pid = getCurrentPageId();
            if (pid) {
                await selectDashboardPage(pid);
            } else {
                await loadDashboard();
            }
        } catch (err) {
            console.error('[dashboard] pull-to-refresh failed:', err);
            try {
                const message = err instanceof Error ? err.message : t('common.error');
                showToast(t('dashboard.refresh_failed', { message }), 'error');
            } catch { /* ignore */ }
        } finally {
            clearTimeout(safety);
            refreshing = false;
            setTimeout(() => {
                setRefreshIndicator(false);
                hideIndicator();
                resetSpinner();
            }, 250);
        }
    }

    dashboardView.addEventListener('touchstart', (ev) => {
        if (dashboardView.scrollTop > 0) { pulling = false; return; }
        if (!ev.touches?.length) return;
        startY = ev.touches[0].clientY;
        pulling = true;
        triggered = false;
    }, { passive: true });

    dashboardView.addEventListener('touchmove', (ev) => {
        if (!pulling) return;
        if (dashboardView.scrollTop > 0) { pulling = false; hideIndicator(); return; }
        const dy = ev.touches[0].clientY - startY;
        if (dy <= 0) { hideIndicator(); return; }
        if (ev.cancelable) ev.preventDefault();
        const dist = Math.pow(dy, 0.85);
        triggered = dist >= THRESHOLD;
        setIndicator(dist, triggered);
    }, { passive: false });

    dashboardView.addEventListener('touchend', () => {
        if (!pulling) return;
        pulling = false;
        if (triggered) {
            triggered = false;
            void doRefresh();
        } else {
            hideIndicator();
        }
    }, { passive: true });

    let wheelAccum = 0;
    let wheelTimer: ReturnType<typeof setTimeout> | null = null;
    dashboardView.addEventListener('wheel', (ev) => {
        if (dashboardView.scrollTop > 0 || ev.deltaY >= 0) {
            wheelAccum = 0;
            return;
        }
        if (ev.cancelable) ev.preventDefault();
        wheelAccum += Math.abs(ev.deltaY);
        const progress = Math.min(1, wheelAccum / 240);
        setIndicator(progress * THRESHOLD * 1.05, progress >= 1);
        if (wheelTimer) clearTimeout(wheelTimer);
        wheelTimer = setTimeout(() => {
            if (wheelAccum >= 240) {
                void doRefresh();
            } else {
                hideIndicator();
            }
            wheelAccum = 0;
        }, 180);
    }, { passive: false });
}
