/**
 * Dashboard widget control actions (brightness, lock, vacuum).
 * Initialized from dashboard.js once core callbacks exist.
 */
import { dashApiError } from './helpers.js';
let _deps = null;
let _brightnessDebounceTimer = null;
const _brightnessLastSent = new Map();
const _vacuumResyncTimers = new Map();
const VACUUM_OPTIMISTIC_STATE = {
    start: 'cleaning',
    pause: 'paused',
    stop: 'idle',
    return_to_base: 'returning',
    locate: null,
};
export function initDashboardWidgetActions(deps) {
    _deps = deps;
}
function deps() {
    if (!_deps)
        throw new Error('Dashboard widget actions not initialized');
    return _deps;
}
function scheduleVacuumResync(slug) {
    if (!slug)
        return;
    const existing = _vacuumResyncTimers.get(slug);
    if (existing)
        existing.forEach((id) => clearTimeout(id));
    const fire = async () => {
        try {
            await deps().apiCall(`/api/integrations/sync/${encodeURIComponent(slug)}`, { method: 'POST' });
        }
        catch { /* best effort */ }
    };
    const timers = [setTimeout(fire, 3000), setTimeout(fire, 9000)];
    _vacuumResyncTimers.set(slug, timers);
}
async function sendBrightness(widgetId, pct) {
    const { apiCall, t, showToast, findWidget } = deps();
    const widget = findWidget(widgetId);
    if (!widget)
        return;
    if (_brightnessLastSent.get(widgetId) === pct)
        return;
    _brightnessLastSent.set(widgetId, pct);
    const attrs = (widget.attributes || {});
    const caps = (attrs.capabilities || {});
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
            throw new Error(dashApiError(err.detail, 'dashboard.brightness_failed'));
        }
        widget.current_state = pct > 0 ? 'on' : 'off';
        widget.attributes = { ...attrs, brightness: value };
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : t('dashboard.brightness_failed');
        showToast(msg, 'error');
    }
}
export function onDashboardBrightnessInput(event, widgetId) {
    const slider = event.target;
    if (!(slider instanceof HTMLInputElement))
        return;
    const pct = Number(slider.value);
    const wrap = slider.closest('.hyve-dashboard-card__brightness');
    if (wrap)
        wrap.style.setProperty('--brightness-pct', `${pct}%`);
    const valueEl = wrap?.querySelector('.hyve-dashboard-card__brightness-value');
    if (valueEl)
        valueEl.textContent = `${pct}%`;
    if (_brightnessDebounceTimer)
        clearTimeout(_brightnessDebounceTimer);
    _brightnessDebounceTimer = setTimeout(() => { void sendBrightness(widgetId, pct); }, 220);
}
export function onDashboardBrightnessChange(event, widgetId) {
    if (_brightnessDebounceTimer) {
        clearTimeout(_brightnessDebounceTimer);
        _brightnessDebounceTimer = null;
    }
    const slider = event.target;
    const pct = slider instanceof HTMLInputElement ? Number(slider.value || 0) : 0;
    void sendBrightness(widgetId, pct);
}
export async function onDashboardLockAction(widgetId, action) {
    const { apiCall, t, showToast, findWidget, tryFastPathForEntities, renderDashboard } = deps();
    const widget = findWidget(widgetId);
    if (!widget)
        return;
    try {
        const slug = String(widget.source || 'zigbee2mqtt');
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/control`, {
            method: 'POST',
            body: { entity_id: widget.entity_id, action, data: {} },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError(err.detail, 'dashboard.action_failed'));
        }
        widget.current_state = action === 'lock' ? 'locked' : 'unlocked';
        if (!tryFastPathForEntities([String(widget.entity_id || '')]))
            renderDashboard();
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : t('dashboard.action_failed');
        showToast(msg, 'error');
    }
}
export async function onDashboardVacuumAction(widgetId, action) {
    const { apiCall, t, showToast, findWidget, tryFastPathForEntities, renderDashboard } = deps();
    const widget = findWidget(widgetId);
    if (!widget)
        return;
    try {
        const slug = String(widget.source || 'xiaomi_home');
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/control`, {
            method: 'POST',
            body: { entity_id: widget.entity_id, action, data: {} },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError(err.detail, 'dashboard.action_failed'));
        }
        const optimistic = VACUUM_OPTIMISTIC_STATE[action];
        if (optimistic) {
            widget.current_state = optimistic;
            const attrs = { ...(widget.attributes || {}) };
            delete attrs.status;
            widget.attributes = attrs;
            if (!tryFastPathForEntities([String(widget.entity_id || '')]))
                renderDashboard();
        }
        scheduleVacuumResync(slug);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : t('dashboard.action_failed');
        showToast(msg, 'error');
    }
}
