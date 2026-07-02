/**
 * Dashboard widget control actions (brightness, lock, vacuum).
 * Initialized from dashboard.js once core callbacks exist.
 */

import { dashApiError } from './helpers.js';
import { hsvToHex } from '../light_controls.js';
import { DASHBOARD_OPTIMISTIC_GUARD_MS } from './constants.js';
import { deleteOptimisticGuard, setOptimisticGuard } from './control_state.js';
import {
    patchDashboardEntityState,
    restoreDashboardEntitySnapshot,
    snapshotDashboardEntityState,
} from './widget_toggle.js';
import type { DashboardWidgetActionDeps } from '../types/dashboard.js';

let _deps: DashboardWidgetActionDeps | null = null;

let _brightnessDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const _brightnessLastSent = new Map<string, number>();
let _numberDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const _numberLastSent = new Map<string, number>();
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
    const { apiCall, t, showToast, findWidget, tryFastPathForEntities, renderDashboard } = deps();
    const widget = findWidget(widgetId);
    if (!widget) return;
    if (_brightnessLastSent.get(widgetId) === pct) return;
    _brightnessLastSent.set(widgetId, pct);
    const attrs = (widget.attributes || {}) as Record<string, unknown>;
    const caps = (attrs.capabilities || {}) as Record<string, unknown>;
    const scale = Number(caps.brightness_scale) || 254;
    const value = Math.round((pct / 100) * scale);
    const entityId = String(widget.entity_id || '');

    // Optimistic: apply the new state locally right away, roll back on failure.
    const snapshot = snapshotDashboardEntityState(entityId);
    const nextState = pct > 0 ? 'on' : 'off';
    patchDashboardEntityState(entityId, nextState, { brightness: value });
    setOptimisticGuard(entityId, { state: nextState, until: Date.now() + DASHBOARD_OPTIMISTIC_GUARD_MS });
    if (!tryFastPathForEntities([entityId])) renderDashboard();
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
    } catch (e) {
        _brightnessLastSent.delete(widgetId);
        deleteOptimisticGuard(entityId);
        restoreDashboardEntitySnapshot(snapshot);
        if (!tryFastPathForEntities([entityId])) renderDashboard();
        const msg = e instanceof Error ? e.message : t('dashboard.brightness_failed');
        showToast(msg, 'error');
    }
}

export function onDashboardBrightnessInput(event: Event, widgetId: string): void {
    const slider = event.target;
    if (!(slider instanceof HTMLInputElement)) return;
    const pct = Number(slider.value);
    const wrap = slider.closest('.hyve-dashboard-card__brightness, .hyve-light__slider') as HTMLElement | null;
    if (wrap) wrap.style.setProperty('--brightness-pct', `${pct}%`);
    const valueEl = wrap?.querySelector('.hyve-dashboard-card__brightness-value, .hyve-light__brightness-label');
    if (valueEl) valueEl.textContent = `${pct}%`;
    const live = slider.closest('.hyve-light')?.querySelector('[data-live-value]');
    if (live && pct > 0) live.textContent = `${pct}%`;

    if (_brightnessDebounceTimer) clearTimeout(_brightnessDebounceTimer);
    _brightnessDebounceTimer = setTimeout(() => { void sendBrightness(widgetId, pct); }, 220);
}

export function onDashboardBrightnessChange(event: Event, widgetId: string): void {
    if (_brightnessDebounceTimer) { clearTimeout(_brightnessDebounceTimer); _brightnessDebounceTimer = null; }
    const slider = event.target;
    const pct = slider instanceof HTMLInputElement ? Number(slider.value || 0) : 0;
    void sendBrightness(widgetId, pct);
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    const raw = String(hex || '').replace('#', '').trim();
    if (!/^[0-9a-f]{6}$/i.test(raw)) return null;
    return {
        r: parseInt(raw.slice(0, 2), 16),
        g: parseInt(raw.slice(2, 4), 16),
        b: parseInt(raw.slice(4, 6), 16),
    };
}

export async function sendLightColor(widgetId: string, hex: string): Promise<void> {
    const { apiCall, t, showToast, findWidget, tryFastPathForEntities, renderDashboard } = deps();
    const widget = findWidget(widgetId);
    if (!widget) return;
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    const entityId = String(widget.entity_id || '');

    const snapshot = snapshotDashboardEntityState(entityId);
    patchDashboardEntityState(entityId, 'on', {
        color: { r: rgb.r, g: rgb.g, b: rgb.b },
        rgb_color: [rgb.r, rgb.g, rgb.b],
    });
    setOptimisticGuard(entityId, { state: 'on', until: Date.now() + DASHBOARD_OPTIMISTIC_GUARD_MS });
    if (!tryFastPathForEntities([entityId])) renderDashboard();
    try {
        const slug = String(widget.source || 'zigbee2mqtt');
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/control`, {
            method: 'POST',
            body: {
                entity_id: widget.entity_id,
                action: 'set',
                data: { state: 'ON', color: rgb },
            },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError((err as { detail?: unknown }).detail, 'dashboard.color_failed'));
        }
    } catch (e) {
        deleteOptimisticGuard(entityId);
        restoreDashboardEntitySnapshot(snapshot);
        if (!tryFastPathForEntities([entityId])) renderDashboard();
        const msg = e instanceof Error ? e.message : t('dashboard.color_failed');
        showToast(msg, 'error');
    }
}

let _colorTempDebounceTimer: ReturnType<typeof setTimeout> | null = null;

async function sendLightColorTemp(widgetId: string, value: number): Promise<void> {
    const { apiCall, t, showToast, findWidget, tryFastPathForEntities, renderDashboard } = deps();
    const widget = findWidget(widgetId);
    if (!widget) return;
    const entityId = String(widget.entity_id || '');

    const snapshot = snapshotDashboardEntityState(entityId);
    patchDashboardEntityState(entityId, 'on', { color_temp: value });
    setOptimisticGuard(entityId, { state: 'on', until: Date.now() + DASHBOARD_OPTIMISTIC_GUARD_MS });
    if (!tryFastPathForEntities([entityId])) renderDashboard();
    try {
        const slug = String(widget.source || 'zigbee2mqtt');
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/control`, {
            method: 'POST',
            body: {
                entity_id: widget.entity_id,
                action: 'set_color_temp',
                data: { color_temp: value },
            },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError((err as { detail?: unknown }).detail, 'dashboard.color_temp_failed'));
        }
    } catch (e) {
        deleteOptimisticGuard(entityId);
        restoreDashboardEntitySnapshot(snapshot);
        if (!tryFastPathForEntities([entityId])) renderDashboard();
        const msg = e instanceof Error ? e.message : t('dashboard.color_temp_failed');
        showToast(msg, 'error');
    }
}

export function onDashboardLightColorChange(event: Event, widgetId: string): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const hex = String(input.value || '').trim();
    if (!hex) return;
    void sendLightColor(widgetId, hex);
}

export function onDashboardLightColorTempInput(event: Event, widgetId: string): void {
    const slider = event.target;
    if (!(slider instanceof HTMLInputElement)) return;
    const value = Number(slider.value);
    const label = slider.closest('.hyve-light__control')?.querySelector('[data-color-temp-label]');
    if (label) label.textContent = String(value);
    if (_colorTempDebounceTimer) clearTimeout(_colorTempDebounceTimer);
    _colorTempDebounceTimer = setTimeout(() => { void sendLightColorTemp(widgetId, value); }, 220);
}

export function onDashboardLightColorTempChange(event: Event, widgetId: string): void {
    if (_colorTempDebounceTimer) { clearTimeout(_colorTempDebounceTimer); _colorTempDebounceTimer = null; }
    const slider = event.target;
    const value = slider instanceof HTMLInputElement ? Number(slider.value || 0) : 0;
    void sendLightColorTemp(widgetId, value);
}

let _hueDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function onDashboardLightHueInput(event: Event, widgetId: string): void {
    const slider = event.target;
    if (!(slider instanceof HTMLInputElement)) return;
    const hue = Number(slider.value) || 0;
    if (_hueDebounceTimer) clearTimeout(_hueDebounceTimer);
    _hueDebounceTimer = setTimeout(() => { void sendLightColor(widgetId, hsvToHex(hue, 100, 100)); }, 260);
}

export function onDashboardLightHueChange(event: Event, widgetId: string): void {
    if (_hueDebounceTimer) { clearTimeout(_hueDebounceTimer); _hueDebounceTimer = null; }
    const slider = event.target;
    if (!(slider instanceof HTMLInputElement)) return;
    const hue = Number(slider.value) || 0;
    void sendLightColor(widgetId, hsvToHex(hue, 100, 100));
}

function widgetNumberCaps(widget: Record<string, unknown> | null | undefined) {
    const attrs = (widget?.attributes || {}) as Record<string, unknown>;
    const caps = (attrs.capabilities || {}) as Record<string, unknown>;
    return {
        min: Number(caps.min ?? 0),
        max: Number(caps.max ?? 100),
        step: Number(caps.step ?? 1) || 1,
    };
}

async function sendNumberValue(widgetId: string, value: number): Promise<void> {
    const { apiCall, t, showToast, findWidget, tryFastPathForEntities, renderDashboard } = deps();
    const widget = findWidget(widgetId);
    if (!widget) return;
    const { min, max } = widgetNumberCaps(widget);
    const clamped = Math.min(max, Math.max(min, value));
    if (_numberLastSent.get(widgetId) === clamped) return;
    _numberLastSent.set(widgetId, clamped);
    try {
        const slug = String(widget.source || 'zigbee2mqtt');
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/control`, {
            method: 'POST',
            body: {
                entity_id: widget.entity_id,
                action: 'set',
                data: { value: clamped },
            },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError((err as { detail?: unknown }).detail, 'dashboard.action_failed'));
        }
        widget.current_state = String(clamped);
        if (!tryFastPathForEntities([String(widget.entity_id || '')])) renderDashboard();
    } catch (e) {
        const msg = e instanceof Error ? e.message : t('dashboard.action_failed');
        showToast(msg, 'error');
    }
}

export function onDashboardNumberInput(event: Event, widgetId: string): void {
    const slider = event.target;
    if (!(slider instanceof HTMLInputElement)) return;
    const value = Number(slider.value);
    const wrap = slider.closest('.hyve-dashboard-card--number');
    const live = wrap?.querySelector('[data-live-value]');
    if (live) live.textContent = String(value);

    if (_numberDebounceTimer) clearTimeout(_numberDebounceTimer);
    _numberDebounceTimer = setTimeout(() => { void sendNumberValue(widgetId, value); }, 220);
}

export function onDashboardNumberChange(event: Event, widgetId: string): void {
    if (_numberDebounceTimer) { clearTimeout(_numberDebounceTimer); _numberDebounceTimer = null; }
    const slider = event.target;
    const value = slider instanceof HTMLInputElement ? Number(slider.value || 0) : 0;
    void sendNumberValue(widgetId, value);
}

export async function onDashboardSelectChange(event: Event, widgetId: string): Promise<void> {
    const { apiCall, t, showToast, findWidget, tryFastPathForEntities, renderDashboard } = deps();
    const widget = findWidget(widgetId);
    if (!widget) return;
    const select = event.target;
    const value = select instanceof HTMLSelectElement ? String(select.value || '') : '';
    if (!value) return;
    try {
        const slug = String(widget.source || 'zigbee2mqtt');
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/control`, {
            method: 'POST',
            body: {
                entity_id: widget.entity_id,
                action: 'set',
                data: { value },
            },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError((err as { detail?: unknown }).detail, 'dashboard.action_failed'));
        }
        widget.current_state = value;
        if (!tryFastPathForEntities([String(widget.entity_id || '')])) renderDashboard();
    } catch (e) {
        const msg = e instanceof Error ? e.message : t('dashboard.action_failed');
        showToast(msg, 'error');
    }
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
