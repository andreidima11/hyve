/**
 * Dashboard widget control actions (brightness, lock, vacuum).
 * Initialized from dashboard.js once core callbacks exist.
 */

import { dashApiError } from './helpers.js';
import type { DashboardWidgetActionDeps } from '../types/dashboard.js';

let _deps: DashboardWidgetActionDeps | null = null;

let _brightnessDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const _brightnessLastSent = new Map<string, number>();
const _vacuumResyncTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
const _lawnMowerResyncTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

const VACUUM_OPTIMISTIC_STATE: Record<string, string | null> = {
    start: 'cleaning',
    pause: 'paused',
    stop: 'idle',
    return_to_base: 'returning',
    locate: null,
};

const LAWN_MOWER_OPTIMISTIC_STATE: Record<string, string | null> = {
    start: 'mowing',
    pause: 'paused',
    stop: 'idle',
    return_to_base: 'returning',
};

export function initDashboardWidgetActions(deps: DashboardWidgetActionDeps): void {
    _deps = deps;
}

function deps(): DashboardWidgetActionDeps {
    if (!_deps) throw new Error('Dashboard widget actions not initialized');
    return _deps;
}

function scheduleVacuumResync(slug: string): void {
    if (!slug) return;
    const existing = _vacuumResyncTimers.get(slug);
    if (existing) existing.forEach((id) => clearTimeout(id));
    const fire = async () => {
        try { await deps().apiCall(`/api/integrations/sync/${encodeURIComponent(slug)}`, { method: 'POST' }); }
        catch { /* best effort */ }
    };
    const timers = [setTimeout(fire, 3000), setTimeout(fire, 9000)];
    _vacuumResyncTimers.set(slug, timers);
}

function scheduleLawnMowerResync(slug: string): void {
    if (!slug) return;
    const existing = _lawnMowerResyncTimers.get(slug);
    if (existing) existing.forEach((id) => clearTimeout(id));
    const fire = async () => {
        try { await deps().apiCall(`/api/integrations/sync/${encodeURIComponent(slug)}`, { method: 'POST' }); }
        catch { /* best effort */ }
    };
    const timers = [setTimeout(fire, 3000), setTimeout(fire, 9000)];
    _lawnMowerResyncTimers.set(slug, timers);
}

async function sendBrightness(widgetId: string, pct: number): Promise<void> {
    const { apiCall, t, showToast, findWidget } = deps();
    const widget = findWidget(widgetId);
    if (!widget) return;
    if (_brightnessLastSent.get(widgetId) === pct) return;
    _brightnessLastSent.set(widgetId, pct);
    const attrs = (widget.attributes || {}) as Record<string, unknown>;
    const caps = (attrs.capabilities || {}) as Record<string, unknown>;
    const scale = Number(caps.brightness_scale) || 254;
    const value = Math.round((pct / 100) * scale);
    try {
        const slug = String(widget.source || 'zigbee2mqtt');
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/control`, {
            method: 'POST',
            body: {
                entity_id: widget.entity_id,
                action: 'set_brightness',
                data: { brightness: value, brightness_pct: pct },
            },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError((err as { detail?: unknown }).detail, 'dashboard.brightness_failed'));
        }
        widget.current_state = pct > 0 ? 'on' : 'off';
        widget.attributes = { ...attrs, brightness: value };
    } catch (e) {
        const msg = e instanceof Error ? e.message : t('dashboard.brightness_failed');
        showToast(msg, 'error');
    }
}

export function onDashboardBrightnessInput(event: Event, widgetId: string): void {
    const slider = event.target;
    if (!(slider instanceof HTMLInputElement)) return;
    const pct = Number(slider.value);
    const wrap = slider.closest('.hyve-dashboard-card__brightness') as HTMLElement | null;
    if (wrap) wrap.style.setProperty('--brightness-pct', `${pct}%`);
    const valueEl = wrap?.querySelector('.hyve-dashboard-card__brightness-value');
    if (valueEl) valueEl.textContent = `${pct}%`;

    if (_brightnessDebounceTimer) clearTimeout(_brightnessDebounceTimer);
    _brightnessDebounceTimer = setTimeout(() => { void sendBrightness(widgetId, pct); }, 220);
}

export function onDashboardBrightnessChange(event: Event, widgetId: string): void {
    if (_brightnessDebounceTimer) { clearTimeout(_brightnessDebounceTimer); _brightnessDebounceTimer = null; }
    const slider = event.target;
    const pct = slider instanceof HTMLInputElement ? Number(slider.value || 0) : 0;
    void sendBrightness(widgetId, pct);
}

export async function onDashboardLockAction(widgetId: string, action: string): Promise<void> {
    const { apiCall, t, showToast, findWidget, tryFastPathForEntities, renderDashboard } = deps();
    const widget = findWidget(widgetId);
    if (!widget) return;
    try {
        const slug = String(widget.source || 'zigbee2mqtt');
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/control`, {
            method: 'POST',
            body: { entity_id: widget.entity_id, action, data: {} },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError((err as { detail?: unknown }).detail, 'dashboard.action_failed'));
        }
        widget.current_state = action === 'lock' ? 'locked' : 'unlocked';
        if (!tryFastPathForEntities([String(widget.entity_id || '')])) renderDashboard();
    } catch (e) {
        const msg = e instanceof Error ? e.message : t('dashboard.action_failed');
        showToast(msg, 'error');
    }
}

export async function onDashboardVacuumAction(widgetId: string, action: string): Promise<void> {
    const { apiCall, t, showToast, findWidget, tryFastPathForEntities, renderDashboard } = deps();
    const widget = findWidget(widgetId);
    if (!widget) return;
    try {
        const slug = String(widget.source || 'xiaomi_home');
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/control`, {
            method: 'POST',
            body: { entity_id: widget.entity_id, action, data: {} },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError((err as { detail?: unknown }).detail, 'dashboard.action_failed'));
        }
        const optimistic = VACUUM_OPTIMISTIC_STATE[action];
        if (optimistic) {
            widget.current_state = optimistic;
            const attrs = { ...((widget.attributes || {}) as Record<string, unknown>) };
            delete attrs.status;
            widget.attributes = attrs;
            if (!tryFastPathForEntities([String(widget.entity_id || '')])) renderDashboard();
        }
        scheduleVacuumResync(slug);
    } catch (e) {
        const msg = e instanceof Error ? e.message : t('dashboard.action_failed');
        showToast(msg, 'error');
    }
}

export async function onDashboardLawnMowerAction(widgetId: string, action: string): Promise<void> {
    const { apiCall, t, showToast, findWidget, tryFastPathForEntities, renderDashboard } = deps();
    const widget = findWidget(widgetId);
    if (!widget) return;
    try {
        const slug = String(widget.source || 'mammotion');
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/control`, {
            method: 'POST',
            body: { entity_id: widget.entity_id, action, data: {} },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError((err as { detail?: unknown }).detail, 'dashboard.action_failed'));
        }
        const optimistic = LAWN_MOWER_OPTIMISTIC_STATE[action];
        if (optimistic) {
            widget.current_state = optimistic;
            const attrs = { ...((widget.attributes || {}) as Record<string, unknown>) };
            delete attrs.status;
            widget.attributes = attrs;
            if (!tryFastPathForEntities([String(widget.entity_id || '')])) renderDashboard();
        }
        scheduleLawnMowerResync(slug);
    } catch (e) {
        const msg = e instanceof Error ? e.message : t('dashboard.action_failed');
        showToast(msg, 'error');
    }
}
