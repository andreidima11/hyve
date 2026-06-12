// Per-domain renderers for integration entity controls.
//
// Each renderer receives the entity object (as returned by
// /api/integrations/{slug}/exposed-entities) and must return an HTML string
// representing the primary control surface for that domain (toggle, slider,
// segmented buttons, etc).
//
// All controls use data-entity-action attributes; integrations/event_bindings.js
// Integration entity controls are wired via integrations/event_bindings.js.

import { escapeHtml } from './utils.js';
import { apiCall } from './api.js';
import { t, tState } from './lang/index.js';
import '/static/hyveview/elements/camera_stream.js';
import '/static/hyveview/elements/mammotion_camera.js';
import { cameraIsMammotionEntity, cameraLiveTransport } from './camera_live.js';
import { renderLightControlsMarkup } from './light_controls.js';
import {
    entityStateForDisplay,
    isMomentaryDomain,
    renderSelectControlHtml,
    selectOptionsFromEntity,
} from './entity_constants.js';
import type { HyveEntity, IntegrationDeviceGroup, EntityAttributes } from './types/entity.js';
import type { EntityRegistryEditorOptions, EntityRendererFn } from './types/entity_renderers.js';

function _er(key: string, params?: Record<string, unknown>) {
    return t('entity.render.' + key, params);
}

const DEVICE_CLASS_ICONS: Record<string, string> = {
    temperature: 'fa-temperature-half',
    humidity: 'fa-droplet',
    battery: 'fa-battery-three-quarters',
    illuminance: 'fa-sun',
    power: 'fa-bolt',
    energy: 'fa-plug-circle-bolt',
    voltage: 'fa-bolt-lightning',
    current: 'fa-wave-square',
    pressure: 'fa-gauge',
    co2: 'fa-smog',
    motion: 'fa-person-running',
    occupancy: 'fa-person',
    door: 'fa-door-open',
    window: 'fa-window-maximize',
    smoke: 'fa-fire',
    gas: 'fa-fire-flame-curved',
    moisture: 'fa-water',
    signal_strength: 'fa-signal',
    timestamp: 'fa-clock',
    duration: 'fa-stopwatch',
};

const DOMAIN_ICONS: Record<string, string> = {
    switch: 'fa-toggle-on',
    light: 'fa-lightbulb',
    sensor: 'fa-gauge-high',
    binary_sensor: 'fa-circle-dot',
    number: 'fa-sliders',
    select: 'fa-list',
    fan: 'fa-fan',
    cover: 'fa-blinds',
    lock: 'fa-lock',
    climate: 'fa-temperature-three-quarters',
    button: 'fa-circle-play',
    event: 'fa-bell',
    device: 'fa-microchip',
    camera: 'fa-video',
    image: 'fa-image',
    update: 'fa-cloud-arrow-up',
};

export function getDomainIcon(domain: string, deviceClass = '') {
    return DEVICE_CLASS_ICONS[deviceClass] || DOMAIN_ICONS[domain] || 'fa-circle-nodes';
}

function _attr(s: unknown) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;');
}

function _ctrlAttrs(
    slug: string,
    eid: string,
    action: string,
    payload: Record<string, unknown> | null = null,
    { stop = false }: { stop?: boolean } = {},
) {
    const payloadAttr = payload != null ? ` data-int-payload="${_attr(JSON.stringify(payload))}"` : '';
    const stopAttr = stop ? ' data-entity-stop="1"' : '';
    return `data-entity-action="control" data-int-slug="${_attr(slug)}" data-int-entity-id="${_attr(eid)}" data-int-cmd="${_attr(action)}"${payloadAttr}${stopAttr}`;
}

function _stateLabel(state: unknown, unit = '', domain = '') {
    const text = tState(entityStateForDisplay(domain, state, tState));
    if (!unit) return escapeHtml(text);
    return `${escapeHtml(text)}<span class="text-slate-400 text-base ml-1">${escapeHtml(unit)}</span>`;
}

if (typeof window !== 'undefined' && !window.__previewIntegrationNumberValue) {
    window.__previewIntegrationNumberValue = function(entityId, value, unit = '') {
        const eid = String(entityId || '');
        if (!eid) return;
        window.dispatchEvent(new CustomEvent('entity-state-changed', {
            detail: { type: 'entity', entity_id: eid, state: String(value ?? '') }
        }));
        const suffix = unit ? ` ${unit}` : '';
        try {
            document.querySelectorAll(`[data-number-live-value="${CSS.escape(eid)}"]`).forEach((el) => {
                el.textContent = `${value}${suffix}`;
            });
        } catch (_) {}
    };
}

if (typeof window !== 'undefined' && !window.__hyveCameraFrameReady) {
    window.__hyveCameraFrameReady = function(img: HTMLImageElement) {
        const frame = img?.closest?.('[data-camera-live-shell]') as HTMLElement | null;
        if (!frame) return;
        frame.dataset.loading = 'false';
        img.classList.remove('opacity-0');
        img.classList.add('opacity-100');
        frame.querySelector('[data-camera-loader]')?.classList.remove('is-visible', 'is-error');
    };
}

if (typeof window !== 'undefined' && !window.__hyveCameraFrameFailed) {
    window.__hyveCameraFrameFailed = function(img: HTMLImageElement, fallbackSrc = '') {
        const frame = img?.closest?.('[data-camera-live-shell]') as HTMLElement | null;
        if (fallbackSrc && !img.dataset.fallbackTried) {
            img.dataset.fallbackTried = '1';
            img.src = fallbackSrc;
            return;
        }
        if (frame) {
            frame.dataset.loading = 'failed';
            const loader = frame.querySelector('[data-camera-loader]');
            if (loader) {
                loader.classList.add('is-visible', 'is-error');
                loader.querySelector('.hv-cam-loader')?.classList.add('hidden');
                const label = loader.querySelector('.hv-cam-loading__label');
                if (label) label.textContent = _er('camera_unavailable');
            }
        }
    };
}

function _mediaStateBadge(state: unknown) {
    const lower = String(state || '').toLowerCase();
    if (lower === 'streaming' || lower === 'on') {
        return { label: _er('live'), className: 'is-live' };
    }
    if (lower === 'idle' || lower === 'off') {
        return { label: tState(lower === 'off' ? 'off' : 'idle'), className: 'is-idle' };
    }
    if (lower === 'unavailable' || lower === 'unknown') {
        return { label: tState(lower), className: 'is-offline' };
    }
    return { label: tState(state || 'unknown'), className: '' };
}

function renderHeroMedia(entity: HyveEntity, domain: string) {
    const dc = String((entity.attributes as EntityAttributes | undefined)?.device_class || '');
    const icon = getDomainIcon(domain, dc);
    const title = entity.name || entity.entity_id || (domain === 'image' ? _er('image') : _er('camera'));
    const eid = entity.entity_id || '';
    const badge = _mediaStateBadge(entity.state);
    const kicker = domain === 'image' ? _er('image') : _er('camera');
    return `
    <div class="hy-entity-hero hy-entity-hero--media mb-3">
        <div class="hy-entity-hero-icon" aria-hidden="true"><i class="fas ${icon}"></i></div>
        <div class="hy-entity-hero-body">
            <div class="hy-entity-hero-kicker">${escapeHtml(kicker)}</div>
            <div class="hy-entity-hero-title">${escapeHtml(title)}</div>
            <div class="hy-entity-hero-sub mono">${escapeHtml(eid)}</div>
        </div>
        <span class="hy-entity-hero-badge ${badge.className}" data-entity-state="${escapeHtml(eid)}">${escapeHtml(badge.label)}</span>
    </div>`;
}

function renderHero(entity: HyveEntity) {
    const domain = String(entity.domain || '').toLowerCase();
    if (domain === 'camera' || domain === 'image') {
        return renderHeroMedia(entity, domain);
    }

    const caps = ((entity.attributes || {}) as EntityAttributes).capabilities || {};
    const unit = entity.unit || caps.unit || '';
    const dc = String(caps.device_class || (entity.attributes as EntityAttributes | undefined)?.device_class || '');
    const icon = getDomainIcon(domain, dc);
    const state = entity.state;
    const lower = String(state || '').toLowerCase();
    let tone = 'text-slate-100';
    if (domain === 'switch' || domain === 'light' || domain === 'binary_sensor') {
        if (lower === 'on' || lower === 'open' || lower === 'unlocked') tone = 'text-accent';
        else if (lower === 'off' || lower === 'closed' || lower === 'locked') tone = 'text-slate-400';
    }
    const title = escapeHtml(entity.name || entity.entity_id || _er('action'));
    const devName = (entity.attributes || {}).device_name || '';
    const subline = devName && entity.name && !entity.name.toLowerCase().startsWith(String(devName).toLowerCase())
        ? `${escapeHtml(String(devName))} · ${escapeHtml(entity.entity_id || '')}`
        : escapeHtml(entity.entity_id || '');
    const kicker = isMomentaryDomain(domain) ? _er('action') : (domain || '');
    const stateLine = isMomentaryDomain(domain)
        ? `<div class="hy-entity-hero-title">${title}</div>`
        : `<div class="hy-entity-hero-state ${tone}" data-entity-state="${escapeHtml(entity.entity_id || '')}">${_stateLabel(state, unit, domain)}</div>`;
    return `
    <div class="hy-entity-hero mb-3">
        <div class="hy-entity-hero-icon" aria-hidden="true"><i class="fas ${icon}"></i></div>
        <div class="hy-entity-hero-body">
            <div class="hy-entity-hero-kicker">${escapeHtml(kicker)}</div>
            ${stateLine}
            <div class="hy-entity-hero-sub mono">${subline}</div>
        </div>
    </div>`;
}

export function entityUniqueId(entity: HyveEntity | Record<string, unknown> | null | undefined) {
    if (!entity || typeof entity !== 'object') return '';
    const attrs = entity.attributes && typeof entity.attributes === 'object'
        ? entity.attributes as EntityAttributes
        : {};
    return String(entity.unique_id || attrs.registry_unique_id || attrs.unique_id || '').trim();
}

function splitEntityId(entityId: string) {
    const raw = String(entityId || '').trim().toLowerCase();
    if (!raw || !raw.includes('.')) {
        return { domain: 'sensor', objectId: raw.replace(/\./g, '_') };
    }
    const [domain, ...rest] = raw.split('.');
    return { domain: domain || 'sensor', objectId: rest.join('.') };
}

function slugifyObjectId(value: unknown) {
    return String(value || '').trim().toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '') || 'unknown';
}

export function renderEntityRegistrySection(entity: HyveEntity) {
    const uid = entityUniqueId(entity);
    const eid = String(entity?.entity_id || '').trim();
    const { domain, objectId } = splitEntityId(eid);
    const canEdit = !!uid;
    return `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-3 mb-3" data-entity-registry-root>
        <div class="flex items-center gap-2 text-[9px] uppercase tracking-widest text-slate-500">
            <span>${escapeHtml(_er('entity_id'))}</span>
            ${canEdit ? `<button type="button" data-entity-registry-edit class="hover:text-accent transition-colors" title="${escapeHtml(_er('entity_id'))}">
                <i class="fas fa-pen text-[10px]"></i>
            </button>` : ''}
        </div>
        <div data-entity-registry-view class="mt-1">
            <div class="text-sm font-semibold text-slate-100 mono break-all leading-snug" data-entity-registry-display>${escapeHtml(eid)}</div>
            ${uid ? `<div class="text-[9px] text-slate-500 mono break-all mt-1 leading-snug">${escapeHtml(_er('unique_id'))}: ${escapeHtml(uid)}</div>` : ''}
        </div>
        <div data-entity-registry-edit-panel class="hidden mt-2 flex flex-col gap-2">
            <div class="flex items-center gap-1.5">
                <span class="text-[11px] mono text-slate-400 shrink-0">${escapeHtml(domain)}.</span>
                <input type="text" data-entity-registry-object-id value="${_attr(objectId)}"
                    class="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-sm text-slate-100 mono focus:outline-none focus:border-accent/40">
                <button type="button" data-entity-registry-save class="px-2 py-1.5 rounded-lg bg-accent/20 border border-accent/40 text-accent text-[11px] font-semibold hover:bg-accent/30 shrink-0">
                    <i class="fas fa-check"></i>
                </button>
                <button type="button" data-entity-registry-cancel class="px-2 py-1.5 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-[11px] hover:bg-white/10 shrink-0">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <p class="text-[10px] text-slate-500 leading-snug">${escapeHtml(_er('entity_id_hint'))}</p>
        </div>
    </div>`;
}

export async function saveEntityRegistryId(entity: HyveEntity, objectIdInput: string) {
    const uid = entityUniqueId(entity);
    if (!uid) throw new Error('missing unique_id');
    const { domain } = splitEntityId(entity.entity_id);
    const objectId = slugifyObjectId(objectIdInput);
    const nextEntityId = `${domain}.${objectId}`;
    if (nextEntityId === entity.entity_id) return { entry: null, entity_id: nextEntityId, unchanged: true };

    const res = await apiCall(
        `/api/integrations/entities/registry/${encodeURIComponent(uid)}`,
        { method: 'PATCH', body: { entity_id: nextEntityId } },
    );
    const out = await res.json().catch(() => ({})) as { detail?: string; message?: string; entry?: { entity_id?: string } };
    if (!res.ok) {
        throw new Error(out.detail || out.message || _er('entity_id_save_failed'));
    }
    return {
        entry: out.entry || null,
        entity_id: out.entry?.entity_id || nextEntityId,
        unchanged: false,
    };
}

export function wireEntityRegistryEditor(
    container: ParentNode | null | undefined,
    entity: HyveEntity,
    options: EntityRegistryEditorOptions = {},
) {
    if (!container || !entity) return;
    const root = container.querySelector('[data-entity-registry-root]');
    if (!root) return;

    const uid = entityUniqueId(entity);
    if (!uid) return;

    const view = root.querySelector('[data-entity-registry-view]');
    const panel = root.querySelector('[data-entity-registry-edit-panel]');
    const display = root.querySelector('[data-entity-registry-display]');
    const input = root.querySelector('[data-entity-registry-object-id]') as HTMLInputElement | null;
    const editBtn = root.querySelector('[data-entity-registry-edit]') as HTMLButtonElement | null;
    const saveBtn = root.querySelector('[data-entity-registry-save]') as HTMLButtonElement | null;
    const cancelBtn = root.querySelector('[data-entity-registry-cancel]') as HTMLButtonElement | null;

    const showView = () => {
        view?.classList.remove('hidden');
        panel?.classList.add('hidden');
    };
    const showEdit = () => {
        view?.classList.add('hidden');
        panel?.classList.remove('hidden');
        input?.focus();
        input?.select();
    };

    if (editBtn) editBtn.onclick = showEdit;
    if (cancelBtn) cancelBtn.onclick = showView;

    const submit = async () => {
        if (!input || saveBtn?.disabled) return;
        const oldEntityId = entity.entity_id;
        if (saveBtn) saveBtn.disabled = true;
        try {
            const result = await saveEntityRegistryId(entity, input?.value || '');
            if (result.unchanged) {
                showView();
                return;
            }
            entity.entity_id = result.entity_id;
            if (display) display.textContent = result.entity_id;
            const { domain, objectId } = splitEntityId(result.entity_id);
            if (input) input.value = objectId;
            showView();
            options.onUpdated?.({
                entity,
                oldEntityId,
                newEntityId: result.entity_id,
                uniqueId: uid,
                entry: result.entry,
            });
            if (options.toast !== false && options.toast !== 'false') {
                const { showToast } = await import('./utils.js');
                showToast(_er('entity_id_updated'), 'success', 2200);
            }
        } catch (err) {
            const { showToast } = await import('./utils.js');
            showToast(err instanceof Error ? err.message : _er('entity_id_save_failed'), 'error', 3200);
        } finally {
            if (saveBtn) (saveBtn as HTMLButtonElement).disabled = false;
        }
    };

    if (saveBtn) saveBtn.onclick = submit;
    if (input) {
        input.onkeydown = (ev: KeyboardEvent) => {
            if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
            else if (ev.key === 'Escape') { ev.preventDefault(); showView(); }
        };
    }
}

function renderSwitch(entity: HyveEntity, slug: string) {
    const eid = entity.entity_id;
    const isOn = String(entity.state || '').toLowerCase() === 'on';
    return `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-4 mb-3">
        <div class="flex items-center justify-between gap-4">
            <div class="min-w-0">
                <div class="text-[11px] uppercase tracking-wider text-slate-400">${escapeHtml(_er('state'))}</div>
                <div class="text-sm font-semibold text-slate-100 mt-0.5">${escapeHtml(isOn ? tState('on') : tState('off'))}</div>
            </div>
            <button type="button"
                    role="switch" aria-checked="${isOn}"
                    class="app-toggle-switch shrink-0" data-entity-toggle="${escapeHtml(eid)}" data-on="${isOn}"
                    ${_ctrlAttrs(slug, eid, isOn ? 'turn_off' : 'turn_on')}>
                <span class="app-toggle-thumb"></span>
            </button>
        </div>
    </div>`;
}

function renderLight(entity: HyveEntity, slug: string) {
    const eid = entity.entity_id;
    const isOn = String(entity.state || '').toLowerCase() === 'on';
    const controls = renderLightControlsMarkup(
        entity,
        slug,
        _ctrlAttrs,
        escapeHtml,
        _attr,
        { brightness: _er('brightness'), color: _er('color'), color_temp: _er('color_temp'), hue: _er('hue') },
    );
    return `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-4 mb-3">
        <div class="flex items-center justify-between gap-4">
            <div class="min-w-0">
                <div class="text-[11px] uppercase tracking-wider text-slate-400">${escapeHtml(_er('light'))}</div>
                <div class="text-sm font-semibold text-slate-100 mt-0.5">${escapeHtml(isOn ? _er('light_on') : _er('light_off'))}</div>
            </div>
            <button type="button" role="switch" aria-checked="${isOn}"
                    class="app-toggle-switch shrink-0" data-entity-toggle="${escapeHtml(eid)}" data-on="${isOn}"
                    ${_ctrlAttrs(slug, eid, isOn ? 'turn_off' : 'turn_on')}>
                <span class="app-toggle-thumb"></span>
            </button>
        </div>
        ${controls}
    </div>`;
}

function renderNumber(entity: HyveEntity, slug: string) {
    const eid = entity.entity_id;
    const caps = ((entity.attributes || {}) as EntityAttributes).capabilities || {};
    const min = caps.min ?? 0;
    const max = caps.max ?? 100;
    const step = caps.step ?? 1;
    const value = Number(entity.state);
    const current = Number.isFinite(value) ? value : min;
    const unit = entity.unit || caps.unit || '';
    return `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-4 mb-3" data-number-control-wrap="${escapeHtml(eid)}">
        <div class="flex items-center justify-between text-[11px] text-slate-400 mb-2">
            <span>${escapeHtml(_er('value'))}</span>
            <span class="mono text-slate-200 text-sm" data-entity-state="${escapeHtml(eid)}" data-number-live-value="${escapeHtml(eid)}">${escapeHtml(String(current))}${unit ? ' ' + escapeHtml(unit) : ''}</span>
        </div>
        <input type="range" min="${min}" max="${max}" step="${step}" value="${current}"
               class="cfg-range w-full" data-entity-control="${escapeHtml(eid)}"
               ${_ctrlAttrs(slug, eid, 'set')} data-int-input="valueFloat" data-int-input-preview="1" data-int-unit="${_attr(unit)}" data-entity-stop="1">
        <div class="hidden"></div>
        <div class="flex items-center justify-between text-[10px] text-slate-500 mt-1.5 mono">
            <span>${min}${unit ? ' ' + escapeHtml(unit) : ''}</span>
            <span>${max}${unit ? ' ' + escapeHtml(unit) : ''}</span>
        </div>
    </div>`;
}

function renderSelect(entity: HyveEntity, slug: string) {
    const eid = entity.entity_id || '';
    const attrs = (entity.attributes || {}) as EntityAttributes;
    const caps = attrs.capabilities || {};
    const selectHtml = renderSelectControlHtml(
        slug,
        eid,
        attrs as Record<string, unknown>,
        caps,
        String(entity.state ?? ''),
        _ctrlAttrs,
        _attr,
        escapeHtml,
    );
    if (!selectHtml) return '';
    return `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-4 mb-3">
        ${selectHtml}
    </div>`;
}

function renderButton(entity: HyveEntity, slug: string) {
    const eid = entity.entity_id;
    const attrs = entity.attributes || {};
    const ptzAction = attrs.tapo_feature || '';
    const ptzUi = ({
        ptz_up: { icon: 'fa-chevron-up', label: _er('up') },
        ptz_down: { icon: 'fa-chevron-down', label: _er('down') },
        ptz_left: { icon: 'fa-chevron-left', label: _er('left') },
        ptz_right: { icon: 'fa-chevron-right', label: _er('right') },
    } as Record<string, { icon: string; label: string }>)[String(ptzAction)];
    if (attrs.tapo_button_kind === 'ptz' && ptzUi) {
        return `
        <div class="rounded-2xl bg-white/5 border border-white/10 p-4 mb-3 flex items-center justify-between gap-3">
            <div>
                <div class="text-[11px] uppercase tracking-wider text-slate-400">${escapeHtml(_er('pan_tilt'))}</div>
                <div class="text-sm font-semibold text-slate-100 mt-0.5">${escapeHtml(ptzUi.label)}</div>
            </div>
            <button type="button" class="hy-ptz-btn hy-ptz-btn--inline"
                    title="${escapeHtml(ptzUi.label)}" aria-label="${escapeHtml(ptzUi.label)}"
                    ${_ctrlAttrs(slug, eid, 'press')}>
                <i class="fas ${ptzUi.icon}"></i>
            </button>
        </div>`;
    }
    return `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-4 mb-3 flex items-center justify-between gap-3">
        <div class="text-[11px] uppercase tracking-wider text-slate-400">${escapeHtml(_er('action'))}</div>
        <button type="button" class="px-4 py-2 rounded-xl bg-accent/15 border border-accent/30 text-accent text-xs font-semibold hover:bg-accent/25"
                ${_ctrlAttrs(slug, eid, 'press')}>
            <i class="fas fa-bolt mr-1"></i>${escapeHtml(_er('send'))}
        </button>
    </div>`;
}

function renderLock(entity: HyveEntity, slug: string) {
    const eid = entity.entity_id;
    const isLocked = String(entity.state || '').toLowerCase() === 'locked' || String(entity.state || '').toLowerCase() === 'off';
    return `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-4 mb-3 flex items-center justify-between gap-3">
        <div>
            <div class="text-[11px] uppercase tracking-wider text-slate-400">${escapeHtml(_er('lock'))}</div>
            <div class="text-sm font-semibold text-slate-100 mt-0.5">${escapeHtml(isLocked ? _er('locked') : _er('unlocked'))}</div>
        </div>
        <button type="button" class="px-4 py-2 rounded-xl text-xs font-semibold border ${isLocked ? 'bg-emerald-500/15 border-emerald-400/30 text-emerald-300' : 'bg-rose-500/15 border-rose-400/30 text-rose-300'}"
                ${_ctrlAttrs(slug, eid, isLocked ? 'turn_off' : 'turn_on')}>
            <i class="fas ${isLocked ? 'fa-lock-open' : 'fa-lock'} mr-1"></i>${escapeHtml(isLocked ? _er('unlock_action') : _er('lock_action'))}
        </button>
    </div>`;
}

function renderCover(entity: HyveEntity, slug: string) {
    const eid = entity.entity_id;
    return `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-4 mb-3">
        <div class="text-[11px] uppercase tracking-wider text-slate-400 mb-2">${escapeHtml(_er('cover'))}</div>
        <div class="flex gap-2">
            <button type="button" class="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-slate-200 text-xs hover:bg-white/10"
                    ${_ctrlAttrs(slug, eid, 'turn_on')}><i class="fas fa-arrow-up mr-1"></i>${escapeHtml(_er('up'))}</button>
            <button type="button" class="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-slate-200 text-xs hover:bg-white/10"
                    ${_ctrlAttrs(slug, eid, 'set', { value: 'STOP' })}><i class="fas fa-stop mr-1"></i>${escapeHtml(_er('stop'))}</button>
            <button type="button" class="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-slate-200 text-xs hover:bg-white/10"
                    ${_ctrlAttrs(slug, eid, 'turn_off')}><i class="fas fa-arrow-down mr-1"></i>${escapeHtml(_er('down'))}</button>
        </div>
    </div>`;
}

function _mobilityActionBtn(slug: string, eid: string, action: string, icon: string, label: string) {
    return `<button type="button" class="flex-1 px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-slate-200 text-xs hover:bg-white/10 hover:text-accent"
        ${_ctrlAttrs(slug, eid, action, null, { stop: true })}>
        <i class="fas ${icon} mr-1"></i>${escapeHtml(label)}
    </button>`;
}

function renderLawnMower(entity: HyveEntity, slug: string) {
    const eid = entity.entity_id || '';
    return `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-4 mb-3">
        <div class="text-[11px] uppercase tracking-wider text-slate-400 mb-2">${escapeHtml(_er('action'))}</div>
        <div class="grid grid-cols-2 gap-2">
            ${_mobilityActionBtn(slug, eid, 'start', 'fa-play', _er('lawn_mower_start'))}
            ${_mobilityActionBtn(slug, eid, 'pause', 'fa-pause', _er('lawn_mower_pause'))}
            ${_mobilityActionBtn(slug, eid, 'stop', 'fa-stop', _er('stop'))}
            ${_mobilityActionBtn(slug, eid, 'return_to_base', 'fa-house', _er('lawn_mower_dock'))}
        </div>
    </div>`;
}

function renderVacuum(entity: HyveEntity, slug: string) {
    const eid = entity.entity_id || '';
    return `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-4 mb-3">
        <div class="text-[11px] uppercase tracking-wider text-slate-400 mb-2">${escapeHtml(_er('action'))}</div>
        <div class="grid grid-cols-2 gap-2">
            ${_mobilityActionBtn(slug, eid, 'start', 'fa-play', _er('vacuum_start'))}
            ${_mobilityActionBtn(slug, eid, 'stop', 'fa-stop', _er('vacuum_stop'))}
            ${_mobilityActionBtn(slug, eid, 'return_to_base', 'fa-house', _er('vacuum_dock'))}
            ${_mobilityActionBtn(slug, eid, 'locate', 'fa-location-crosshairs', _er('vacuum_locate'))}
        </div>
    </div>`;
}

function renderSensor(entity: HyveEntity /*, slug */) {
    // Sensors are read-only — the hero already shows the value. No control card.
    const attrs = entity.attributes || {};
    const raw = attrs.raw_state;
    if (!raw || typeof raw !== 'object') return '';
    const interesting = Object.entries(raw)
        .filter(([k, v]) => v != null && typeof v !== 'object' && k !== 'state')
        .slice(0, 8);
    if (!interesting.length) return '';
    return `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-4 mb-3">
        <div class="text-[11px] uppercase tracking-wider text-slate-400 mb-2">${escapeHtml(_er('telemetry'))}</div>
        <div class="grid grid-cols-2 gap-2">
            ${interesting.map(([k, v]) => `
                <div class="bg-white/5 rounded-lg px-2.5 py-1.5">
                    <div class="text-[9px] uppercase tracking-wider text-slate-500">${escapeHtml(k)}</div>
                    <div class="text-[12px] mono text-slate-100 truncate">${escapeHtml(String(v))}</div>
                </div>
            `).join('')}
        </div>
    </div>`;
}

function _cameraHasPtz(attrs: Record<string, unknown>) {
    if (!attrs || typeof attrs !== 'object') return false;
    const caps = (attrs.capabilities && typeof attrs.capabilities === 'object' ? attrs.capabilities : {}) as Record<string, unknown>;
    return !!(attrs.ptz_supported || caps.ptz);
}

function _renderCameraPtzPad(entity: HyveEntity, slug: string) {
    const attrs = entity.attributes || {};
    if (!_cameraHasPtz(attrs)) return '';
    const eid = entity.entity_id || '';
    const btn = (action: string, icon: string, title: string) => `<button type="button" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"
        class="hy-ptz-btn"
        ${_ctrlAttrs(slug, eid, action, null, { stop: true })}>
        <i class="fas ${icon}"></i>
    </button>`;
    return `
    <div class="hy-ptz-pad mb-3">
        <div class="hy-ptz-pad-label">${escapeHtml(_er('pan_tilt'))}</div>
        <div class="hy-ptz-grid" role="group" aria-label="${escapeHtml(_er('ptz_aria'))}">
            <span class="hy-ptz-spacer" aria-hidden="true"></span>
            ${btn('ptz_up', 'fa-chevron-up', _er('up'))}
            <span class="hy-ptz-spacer" aria-hidden="true"></span>
            ${btn('ptz_left', 'fa-chevron-left', _er('left'))}
            <span class="hy-ptz-center" aria-hidden="true"><i class="fas fa-up-down-left-right"></i></span>
            ${btn('ptz_right', 'fa-chevron-right', _er('right'))}
            <span class="hy-ptz-spacer" aria-hidden="true"></span>
            ${btn('ptz_down', 'fa-chevron-down', _er('down'))}
            <span class="hy-ptz-spacer" aria-hidden="true"></span>
        </div>
    </div>`;
}

function renderCamera(entity: HyveEntity, slug: string) {
    const eid = entity.entity_id || '';
    if (!eid) return '';
    const title = entity.name || eid;
    const attrs = entity.attributes || {};
    const safeTitle = escapeHtml(title);
    if (cameraIsMammotionEntity(eid, attrs)) {
        return `
    <div class="hy-entity-camera-shell mb-3">
        <hv-mammotion-camera entity="${escapeHtml(eid)}" alt="${safeTitle}" autoplay="true" force-active="true"></hv-mammotion-camera>
    </div>
    ${_renderCameraPtzPad(entity, slug)}`;
    }
    const transport = cameraLiveTransport(attrs);
    const useGo2rtc = transport === 'go2rtc';
    const hasAudio = !!attrs.has_audio;
    const streamAttrs = [
        'class="relative block aspect-video hy-card-camera__stage"',
        `entity="${escapeHtml(eid)}"`,
        'mode="live"',
        `alt="${safeTitle}"`,
        'force-active',
    ];
    if (useGo2rtc) streamAttrs.push('go2rtc');
    if (transport === 'webm') streamAttrs.push('webm');
    if (hasAudio) streamAttrs.push('show-mute');
    else streamAttrs.push('muted');
    return `
    <div class="hy-entity-camera-shell mb-3">
        <hv-camera-stream ${streamAttrs.join(' ')}></hv-camera-stream>
    </div>
    ${_renderCameraPtzPad(entity, slug)}`;
}

const RENDERERS: Record<string, EntityRendererFn> = {
    switch: renderSwitch,
    outlet: renderSwitch,
    plug: renderSwitch,
    light: renderLight,
    number: renderNumber,
    select: renderSelect,
    button: renderButton,
    lock: renderLock,
    cover: renderCover,
    fan: renderSwitch,
    sensor: renderSensor,
    binary_sensor: renderSensor,
    camera: renderCamera,
    lawn_mower: renderLawnMower,
    vacuum: renderVacuum,
};

export function renderEntityModal(entity: HyveEntity, slug: string) {
    if (!entity || typeof entity !== 'object') return '';
    const domain = String(entity.domain || '').toLowerCase();
    const renderer = RENDERERS[domain];
    let body = renderHero(entity);
    body += renderEntityRegistrySection(entity);
    if (renderer) {
        try { body += renderer(entity, slug) || ''; } catch (e) { console.warn('renderer failed', e); }
    }

    // Attributes (collapsed)
    const attrs = entity.attributes || {};
    const flatAttrs = Object.entries(attrs)
        .filter(([k, v]) => k !== 'capabilities' && k !== 'raw_state' && v != null && typeof v !== 'object')
        .slice(0, 30);
    if (flatAttrs.length) {
        body += `
        <details class="rounded-2xl bg-white/5 border border-white/10 p-3 mb-3">
            <summary class="text-[11px] uppercase tracking-wider text-slate-400 cursor-pointer select-none">${escapeHtml(_er('attributes'))}</summary>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-3">
                ${flatAttrs.map(([k, v]) => `
                    <div class="flex items-center justify-between gap-2 px-2 py-1 bg-white/[0.03] rounded">
                        <span class="text-[10px] text-slate-500 uppercase tracking-wider truncate">${escapeHtml(k)}</span>
                        <span class="text-[11px] mono text-slate-200 truncate">${escapeHtml(String(v))}</span>
                    </div>
                `).join('')}
            </div>
        </details>`;
    }

    // Raw JSON (collapsed, for debugging)
    body += `
    <details class="rounded-2xl bg-white/5 border border-white/10 p-3">
        <summary class="text-[11px] uppercase tracking-wider text-slate-400 cursor-pointer select-none">${escapeHtml(_er('raw_json'))}</summary>
        <pre class="text-[10px] text-slate-400 mono whitespace-pre-wrap break-all mt-2 max-h-64 overflow-auto">${escapeHtml(JSON.stringify(entity, null, 2))}</pre>
    </details>`;

    return body;
}

export function renderEntityCard(entity: HyveEntity, slug: string) {
    const caps = ((entity.attributes || {}) as EntityAttributes).capabilities || {};
    const dc = caps.device_class || '';
    const icon = getDomainIcon(entity.domain || '', dc);
    const title = entity.name || entity.entity_id || 'Entity';
    const domain = String(entity.domain || '').toLowerCase();
    const state = entityStateForDisplay(domain, entity.state, tState);
    const unit = entity.unit ? ` ${escapeHtml(String(entity.unit))}` : '';
    const lower = state.toLowerCase();
    const isOn = lower === 'on' || lower === 'open' || lower === 'unlocked';
    const isOff = lower === 'off' || lower === 'closed' || lower === 'locked';
    const tone = isOn ? 'text-accent' : (isOff ? 'text-slate-400' : 'text-slate-200');
    const eid = entity.entity_id || '';
    const encoded = encodeURIComponent(JSON.stringify(entity)).replace(/'/g, '%27');

    // Inline toggle for switches/lights
    let inlineCtl = '';
    if (entity.controllable && domain === 'button') {
        inlineCtl = `<button type="button" class="px-2.5 py-1 rounded-lg bg-accent/15 border border-accent/30 text-accent text-[10px] font-semibold shrink-0"
            ${_ctrlAttrs(slug, eid, 'press', null, { stop: true })} title="${escapeHtml(_er('send'))}">
            <i class="fas fa-bolt"></i>
        </button>`;
    } else if (entity.controllable && (entity.domain === 'switch' || entity.domain === 'light' || entity.domain === 'fan' || entity.domain === 'outlet' || entity.domain === 'plug')) {
        inlineCtl = `<button type="button" role="switch" aria-checked="${isOn}"
            class="app-toggle-switch shrink-0" data-entity-toggle="${escapeHtml(eid)}" data-on="${isOn}"
            ${_ctrlAttrs(slug, eid, isOn ? 'turn_off' : 'turn_on', null, { stop: true })}>
            <span class="app-toggle-thumb"></span>
        </button>`;
    }

    return `<div class="bg-white/[0.03] border border-white/5 rounded-xl p-3 hover:bg-white/[0.06] hover:border-accent/20 transition-all cursor-pointer"
            data-entity-action="openCard" data-int-encoded="${encoded}">
        <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                    <i class="fas ${icon} text-accent/70 text-sm"></i>
                    <div class="text-[12px] font-semibold text-slate-100 truncate">${escapeHtml(title)}</div>
                </div>
                <div class="text-[10px] text-slate-500 mono truncate mt-1">${escapeHtml(eid)}</div>
            </div>
            ${inlineCtl}
        </div>
        <div class="flex items-center justify-between gap-3 mt-2.5 pt-2.5 border-t border-white/5">
            <span class="text-[10px] uppercase tracking-widest text-slate-500">${escapeHtml(entity.domain || '')}</span>
            <span class="text-[12px] mono ${tone} truncate" data-entity-state="${escapeHtml(eid)}">${escapeHtml(state)}${unit}</span>
        </div>
    </div>`;
}

export function groupEntitiesByDevice(entities: HyveEntity[]): IntegrationDeviceGroup[] {
    const groups = new Map<string, IntegrationDeviceGroup>();
    for (const ent of entities) {
        const key = (ent.attributes || {}).device_id
            || (ent.attributes || {}).device_name
            || ent.entity_id
            || '_';
        if (!groups.has(key)) {
            groups.set(key, {
                device_id: key,
                device_name: (ent.attributes || {}).device_name || '',
                device_model: (ent.attributes || {}).device_model || '',
                device_manufacturer: (ent.attributes || {}).device_manufacturer || '',
                entities: [],
            });
        }
        groups.get(key)!.entities.push(ent);
    }
    return Array.from(groups.values()).sort((a, b) => {
        const an = (a.device_name || a.device_id || '').toLowerCase();
        const bn = (b.device_name || b.device_id || '').toLowerCase();
        return an.localeCompare(bn);
    });
}

// One card per physical device. Summarizes entity count and primary state
// (number of switches that are on, etc). Click → opens the device modal.
export function renderDeviceCard(group: IntegrationDeviceGroup, slug: string) {
    const name = group.device_name || group.device_id || 'Device';
    const model = group.device_model || '';
    const manuf = group.device_manufacturer || '';
    const ents = group.entities || [];
    const total = ents.length;

    // Primary stats: how many controllable on/off, sensor summary.
    const switches = ents.filter(e => e.controllable && (e.domain === 'switch' || e.domain === 'light' || e.domain === 'fan' || e.domain === 'outlet' || e.domain === 'plug'));
    const onCount = switches.filter(e => String(e.state || '').toLowerCase() === 'on').length;
    const linkSensor = ents.find(e => /linkquality|signal/i.test(e.entity_id || '') || ((e.attributes || {}).capabilities || {}).device_class === 'signal_strength');
    const battery = ents.find(e => ((e.attributes || {}).capabilities || {}).device_class === 'battery');

    // Domain-tally chips
    const tally = ents.reduce((acc: Record<string, number>, e) => {
        const d = e.domain || 'other';
        acc[d] = (acc[d] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);
    const chips = Object.entries(tally).slice(0, 4).map(([d, n]) =>
        `<span class="text-[9px] px-1.5 py-0.5 rounded bg-white/[0.04] border border-white/5 text-slate-400 uppercase tracking-wider">${escapeHtml(d)} ${n}</span>`
    ).join('');

    let primaryReadout = '';
    if (switches.length) {
        const allOff = onCount === 0;
        const allOn = onCount === switches.length;
        const tone = allOn ? 'text-accent' : (allOff ? 'text-slate-400' : 'text-amber-300');
        primaryReadout = `<span class="text-sm mono ${tone}">${onCount}/${switches.length} ON</span>`;
    } else if (linkSensor) {
        primaryReadout = `<span class="text-sm mono text-slate-300"><i class="fas fa-signal text-[10px] mr-1"></i>${escapeHtml(String(linkSensor.state ?? '—'))}</span>`;
    } else {
        primaryReadout = `<span class="text-sm mono text-slate-400">${total} entități</span>`;
    }

    let batteryBadge = '';
    if (battery && battery.state != null && battery.state !== '') {
        const pct = Number(battery.state);
        const tone = pct >= 50 ? 'text-emerald-300' : (pct >= 20 ? 'text-amber-300' : 'text-rose-300');
        batteryBadge = `<span class="text-[10px] mono ${tone} ml-2"><i class="fas fa-battery-three-quarters text-[9px] mr-1"></i>${escapeHtml(String(pct))}%</span>`;
    }

    const subtitle = [model, manuf].filter(Boolean).join(' · ');
    const encoded = encodeURIComponent(JSON.stringify(group)).replace(/'/g, '%27');

    return `<div class="bg-white/[0.03] border border-white/5 rounded-xl p-4 hover:bg-white/[0.06] hover:border-accent/20 transition-all cursor-pointer"
            data-device-card="${escapeHtml(group.device_id || '')}"
            data-entity-action="openDeviceCard" data-int-encoded="${encoded}" data-int-slug="${_attr(slug)}">
        <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                    <i class="fas fa-microchip text-accent/70 text-sm"></i>
                    <div class="text-[13px] font-semibold text-slate-100 truncate">${escapeHtml(name)}</div>
                    ${batteryBadge}
                </div>
                ${subtitle ? `<div class="text-[10px] text-slate-500 truncate mt-0.5">${escapeHtml(subtitle)}</div>` : ''}
            </div>
            ${primaryReadout}
        </div>
        <div class="flex items-center gap-1 mt-3 pt-3 border-t border-white/5 flex-wrap">
            ${chips || `<span class="text-[10px] text-slate-500">${total} entități</span>`}
        </div>
    </div>`;
}

// One row inside the device modal — entity icon + title + state + inline control.
function renderDeviceEntityRow(entity: HyveEntity, slug: string) {
    const caps = ((entity.attributes || {}) as EntityAttributes).capabilities || {};
    const dc = caps.device_class || '';
    const icon = getDomainIcon(entity.domain || '', dc);
    const title = entity.name || entity.entity_id || 'Entity';
    const eid = entity.entity_id || '';
    const dom = String(entity.domain || '').toLowerCase();
    const state = entityStateForDisplay(dom, entity.state, tState);
    const unit = entity.unit ? ` ${escapeHtml(String(entity.unit))}` : '';
    const lower = state.toLowerCase();
    const isOn = lower === 'on' || lower === 'open' || lower === 'unlocked';
    const isOff = lower === 'off' || lower === 'closed' || lower === 'locked';
    const tone = isOn ? 'text-accent' : (isOff ? 'text-slate-400' : 'text-slate-200');

    let control = '';
    if (entity.controllable) {
        if (dom === 'switch' || dom === 'light' || dom === 'fan' || dom === 'outlet' || dom === 'plug') {
            control = `<button type="button" role="switch" aria-checked="${isOn}"
                class="app-toggle-switch shrink-0" data-entity-toggle="${escapeHtml(eid)}" data-on="${isOn}"
                ${_ctrlAttrs(slug, eid, isOn ? 'turn_off' : 'turn_on', null, { stop: true })}>
                <span class="app-toggle-thumb"></span>
            </button>`;
        } else if (dom === 'number') {
            const min = caps.min ?? 0;
            const max = caps.max ?? 100;
            const step = caps.step ?? 1;
            const val = Number.isFinite(Number(entity.state)) ? Number(entity.state) : min;
            const unitText = entity.unit || caps.unit || '';
            control = `<input type="range" min="${min}" max="${max}" step="${step}" value="${val}"
                class="cfg-range w-32 shrink-0" data-entity-control="${escapeHtml(eid)}"
                ${_ctrlAttrs(slug, eid, 'set')} data-int-input="valueFloat" data-int-input-preview="1" data-int-unit="${_attr(unitText)}" data-entity-stop="1">`;
        } else if (dom === 'select') {
            const selectHtml = renderSelectControlHtml(
                slug,
                eid,
                (entity.attributes || {}) as Record<string, unknown>,
                caps,
                String(entity.state ?? ''),
                _ctrlAttrs,
                _attr,
                escapeHtml,
            );
            if (selectHtml) {
                control = `<div class="int-entity-row__select-wrap">${selectHtml}</div>`;
            }
        } else if (dom === 'button') {
            control = `<button type="button" class="px-3 py-1 rounded-lg bg-accent/15 border border-accent/30 text-accent text-[11px] font-semibold shrink-0"
                ${_ctrlAttrs(slug, eid, 'press', null, { stop: true })}>
                <i class="fas fa-bolt"></i>
            </button>`;
        } else if (dom === 'vacuum' || dom === 'lawn_mower') {
            const vBtn = (vacAction: string, ic: string, title: string) => `<button type="button" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"
                class="w-8 h-8 rounded-full border bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-accent shrink-0 flex items-center justify-center transition-colors"
                ${_ctrlAttrs(slug, eid, vacAction, null, { stop: true })}>
                <i class="fas ${ic} text-[11px]"></i>
            </button>`;
            const startLabel = dom === 'lawn_mower' ? _er('lawn_mower_start') : _er('vacuum_start');
            const dockLabel = dom === 'lawn_mower' ? _er('lawn_mower_dock') : _er('vacuum_dock');
            control = `<div class="flex items-center gap-1.5 shrink-0">
                ${vBtn('start', 'fa-play', startLabel)}
                ${dom === 'lawn_mower' ? vBtn('pause', 'fa-pause', _er('lawn_mower_pause')) : ''}
                ${vBtn('stop', 'fa-stop', _er('stop'))}
                ${vBtn('return_to_base', 'fa-house', dockLabel)}
            </div>`;
        }
    }

    const encoded = encodeURIComponent(JSON.stringify(entity)).replace(/'/g, '%27');
    const stateHtml = `<span class="text-[12px] mono ${tone} truncate max-w-[9rem] shrink-0" data-entity-state="${escapeHtml(eid)}">${escapeHtml(state)}${unit}</span>`;
    const controlHtml = control || stateHtml;
    return `<div class="int-entity-row px-3 py-2.5 bg-white/[0.03] border border-white/5 rounded-xl hover:bg-white/[0.06] hover:border-accent/20 transition-colors cursor-pointer"
        data-entity-action="openCard" data-int-encoded="${encoded}">
        <i class="fas ${icon} text-accent/70 text-sm w-4 text-center shrink-0"></i>
        <div class="int-entity-row__label">
            <div class="text-[12px] font-semibold text-slate-100 truncate">${escapeHtml(title)}</div>
            <div class="text-[9px] text-slate-500 mono uppercase tracking-wider truncate">${escapeHtml(entity.domain || '')}</div>
        </div>
        ${controlHtml}
    </div>`;
}

export function renderDeviceModal(group: IntegrationDeviceGroup, slug: string) {
    if (!group || !Array.isArray(group.entities)) return '';
    const name = group.device_name || group.device_id || 'Device';
    const subtitle = [group.device_model, group.device_manufacturer].filter(Boolean).join(' · ');
    const ents = group.entities.slice().sort((a, b) => {
        // Sort by domain priority, then by name
        const order: Record<string, number> = { switch: 0, light: 1, fan: 2, cover: 3, lock: 4, climate: 5, number: 6, select: 7, button: 8, binary_sensor: 9, sensor: 10 };
        const oa = order[String(a.domain)] ?? 99;
        const ob = order[String(b.domain)] ?? 99;
        if (oa !== ob) return oa - ob;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });

    const hero = `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-4 mb-3 flex items-start gap-3">
        <div class="w-11 h-11 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center shrink-0">
            <i class="fas fa-plug text-accent text-base"></i>
        </div>
        <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-[10px] uppercase tracking-widest text-slate-500">
                <span>Dispozitiv</span>
                <button type="button" class="hover:text-accent transition-colors" title="Redenumește dispozitivul"
                    data-entity-action="renameDevice" data-int-slug="${_attr(slug)}" data-int-device-id="${_attr(group.device_id || '')}" data-int-device-name="${_attr(name)}">
                    <i class="fas fa-pen text-[10px]"></i>
                </button>
            </div>
            <div class="text-base sm:text-lg font-semibold text-slate-100 mt-1 break-words leading-snug">${escapeHtml(name)}</div>
            ${subtitle ? `<div class="text-[10px] text-slate-500 break-words mt-1">${escapeHtml(subtitle)}</div>` : ''}
            <div class="text-[10px] text-slate-500 mono break-all mt-1 leading-snug">${escapeHtml(group.device_id || '')}</div>
        </div>
        <div class="text-right shrink-0">
            <div class="text-xl font-semibold text-slate-200 mono leading-none">${ents.length}</div>
            <div class="text-[9px] uppercase tracking-wider text-slate-500 mt-1">entități</div>
        </div>
    </div>`;

    const list = `<div class="space-y-1.5">${ents.map(e => renderDeviceEntityRow(e, slug)).join('')}</div>`;
    return hero + list;
}
