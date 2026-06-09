/**
 * Dashboard conditional visibility — screen media queries and panel backgrounds.
 */

import type {
    DashboardPanel,
    DashboardVisibilityConfig,
    DashboardVisibilityDeps,
    DashboardWidget,
} from '../types/dashboard.js';

let _deps: DashboardVisibilityDeps | null = null;
let _screenWatchBound = false;

function deps(): DashboardVisibilityDeps {
    if (!_deps) throw new Error('Dashboard visibility not initialized');
    return _deps;
}

export function initDashboardVisibility(depsIn: DashboardVisibilityDeps): void {
    _deps = depsIn;
}

function dashboardScreenGate(visibility: DashboardVisibilityConfig | null | undefined): boolean {
    if (!visibility || visibility.enabled === false) return true;
    const conditions = Array.isArray(visibility.conditions) ? visibility.conditions : [];
    const screens = conditions.filter((c) => String((c && (c.condition || c.type)) || '').toLowerCase() === 'screen' && (c.media || c.value));
    if (!screens.length) return true;
    return screens.every((c) => {
        const query = String(c.media || c.value || '').trim();
        if (!query) return true;
        try { return window.matchMedia(query).matches; } catch { return true; }
    });
}

export function dashboardElementVisible(obj: DashboardWidget | DashboardPanel | null | undefined): boolean {
    const d = deps();
    if (d.getEditMode()) return true;
    if (!obj) return true;
    if (obj.visible === false) return false;
    return dashboardScreenGate(obj.visibility);
}

export function visibleDashboardWidgets(list: DashboardWidget[] | null | undefined): DashboardWidget[] {
    const d = deps();
    const widgets = Array.isArray(list) ? list : [];
    if (d.getEditMode()) return widgets;
    return widgets.filter(dashboardElementVisible);
}

function hexToRgba(hex: string, alpha: number | undefined): string {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex || '').trim());
    if (!m) return '';
    const r = parseInt(m[1], 16);
    const g = parseInt(m[2], 16);
    const b = parseInt(m[3], 16);
    const a = (typeof alpha === 'number' && alpha >= 0 && alpha <= 1) ? alpha : 1;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function dashboardPanelBackgroundCss(panel: DashboardPanel | null | undefined): string {
    const bg = panel?.background;
    if (!bg || !bg.color) return '';
    const opacity = (typeof bg.opacity === 'number') ? bg.opacity : 1;
    return hexToRgba(bg.color, opacity);
}

export function bindDashboardScreenWatch(): void {
    if (_screenWatchBound) return;
    _screenWatchBound = true;
    const d = deps();
    let raf: number | null = null;
    window.addEventListener('resize', () => {
        if (d.getEditMode()) return;
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            const view = document.getElementById('view-dashboard');
            if (view && !view.classList.contains('hidden')) d.renderDashboard();
        });
    }, { passive: true });
}
