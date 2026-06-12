/**
 * Integration exposed devices grid, live updates, device/entity modals.
 */
import { apiCall } from '../api.js';
import {
    initIntegrationsLiveWs,
    refreshIntegrationsLiveConnection,
    subscribeIntegrationsLive,
} from '../integrations_live_ws.js';
import { t, translateApiDetail, tState } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr, showToast } from '../utils.js';
import { renderEntityModal, getDomainIcon, wireEntityRegistryEditor } from '../entity_renderers.js';
import {
    ACTIVE_STATES,
    CONTROLLABLE,
    entityStateForDisplay,
    renderSelectControlHtml,
} from '../entity_constants.js';
import { appendMediaQueryToken, getCameraStreamToken, startCameraPreviewRefresh, stopCameraPreviewRefresh } from '../camera_auth.js';
import { integrationSlugsMatch } from '../integration_sources.js';
import type { ExposedDevicesState, IntegrationDeviceSection } from '../types/features_integrations_settings.js';
import type { IntegrationDeviceGroup, HyveEntity } from '../types/entity.js';
import { errMsg, integrationApiError, isActiveState } from './utils.js';
import {
    integrationDefinition,
    integrationEntitySourceSlug,
    integrationIdForSourceSlug,
    integrationLabel,
    supportsIntegrationEntitySync,
} from './catalog_meta.js';
import { syncConfiguredIntegration } from './catalog.js';
import { navigateToSmartHomeSource } from './entities_sync.js';

let _exposedDevicesState: ExposedDevicesState = { slug: null, devices: [] };
let _integrationExposedLiveSlug: string | null = null;
let _integrationExposedLiveUnsub: (() => void) | null = null;

function _ensureIntegrationExposedLiveSubscription(): void {
    if (_integrationExposedLiveUnsub) return;
    initIntegrationsLiveWs({ apiCall });
    _integrationExposedLiveUnsub = subscribeIntegrationsLive({
        id: 'integration-exposed',
        isActive: () => {
            const section = document.getElementById('integration-exposed-entities-section');
            return !!(section && !section.classList.contains('hidden') && _integrationExposedLiveSlug);
        },
        onItems: (items) => _applyIntegrationExposedLiveItems(items as Record<string, unknown>[]),
        onRemoved: () => {},
    });
}

function _disconnectIntegrationExposedLive(): void {
    _integrationExposedLiveSlug = null;
    refreshIntegrationsLiveConnection();
}

function _patchIntegrationExposedEntityState(item: Record<string, unknown>): void {
    if (!item || !item.entity_id) return;
    const eid = item.entity_id;
    const dom = String(item.domain || String(item.entity_id || '').split('.')[0] || '').toLowerCase();
    const state = entityStateForDisplay(dom, item.state, tState);
    const unit = item.unit ? ` ${item.unit}` : '';
    const stateLower = state.toLowerCase();
    const isOn = isActiveState(stateLower);
    const isOff = ['off', 'closed', 'locked', 'idle', 'docked', 'paused'].includes(stateLower);
    const tone = isOn ? 'text-accent' : (isOff ? 'text-slate-400' : 'text-slate-200');

    if (_exposedDevicesState?.devices) {
        for (const dev of _exposedDevicesState.devices) {
            const ent = (dev.entities || []).find(e => e.entity_id === eid);
            if (ent) {
                ent.state = state;
                if (item.unit) ent.unit = String(item.unit);
                break;
            }
        }
    }

    const modalStates = document.querySelectorAll(`[data-entity-state="${CSS.escape(String(eid))}"]`);
    for (const el of modalStates) {
        el.textContent = `${state}${unit}`;
        el.classList.remove('text-accent', 'text-slate-400', 'text-slate-200');
        el.classList.add(tone);
        const row = el.closest('[data-entity-list] > div') as HTMLElement | null;
        if (row) {
            row.classList.remove('hy-row-flash');
            void row.offsetWidth;
            row.classList.add('hy-row-flash');
        }
    }
}

function _applyIntegrationExposedLiveItems(items: Record<string, unknown>[]): void {
    if (!Array.isArray(items)) return;
    for (const item of items) {
        if (!item || !item.entity_id) continue;
        _patchIntegrationExposedEntityState(item);
    }
}

function _connectIntegrationExposedLive(slug: string): void {
    const section = document.getElementById('integration-exposed-entities-section');
    if (!section || section.classList.contains('hidden')) {
        _disconnectIntegrationExposedLive();
        return;
    }
    _integrationExposedLiveSlug = slug;
    _ensureIntegrationExposedLiveSubscription();
    refreshIntegrationsLiveConnection();
}
// Page index per slug for the device grid.
const _DEVICE_PAGE_SIZE = 6;
const _devicePageState = new Map<string, number>();

function _renderDevicesSection(section: HTMLElement, group: IntegrationDeviceSection, slug: string, baseOffset: number, opts: Record<string, unknown>) {
    const pageSize = _DEVICE_PAGE_SIZE;
    const showEntryLabel = !!(opts && opts.showEntryLabel);
    const pages = Math.max(1, Math.ceil(group.devices.length / pageSize));
    const stateKey = `${slug}::${group.key}`;
    let page = _devicePageState.get(stateKey) || 0;
    if (page >= pages) page = pages - 1;
    if (page < 0) page = 0;
    _devicePageState.set(stateKey, page);

    const start = page * pageSize;
    const slice = group.devices.slice(start, start + pageSize);
    const cardsHtml = slice
        .map((d: IntegrationDeviceGroup, j: number) => _devCardHtml(d, baseOffset + start + j, slug, showEntryLabel))
        .join('');

    const pagerHtml = pages > 1
        ? `<div class="flex items-center justify-between gap-2 mt-1 pt-2 border-t border-white/5" data-device-pager>
            <button type="button" data-device-page-prev ${page === 0 ? 'disabled' : ''}
                class="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:cursor-not-allowed">
                <i class="fas fa-chevron-left mr-1"></i>${escapeHtml(t('common.prev'))}
            </button>
            <span class="text-[11px] text-slate-500 mono">${escapeHtml(t('integrations.devices_pager', { page: page + 1, pages, count: group.devices.length }))}</span>
            <button type="button" data-device-page-next ${page >= pages - 1 ? 'disabled' : ''}
                class="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:cursor-not-allowed">
                ${escapeHtml(t('common.next'))}<i class="fas fa-chevron-right ml-1"></i>
            </button>
        </div>`
        : '';

    section.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2" style="column-gap:1.5rem;row-gap:1.25rem;">${cardsHtml}</div>
        ${pagerHtml}`;

    const prev = section.querySelector('[data-device-page-prev]');
    const next = section.querySelector('[data-device-page-next]');
    if (prev) (prev as HTMLElement).onclick = () => {
        _devicePageState.set(stateKey, Math.max(0, (_devicePageState.get(stateKey) || 0) - 1));
        _renderDevicesSection(section, group, slug, baseOffset, opts);
    };
    if (next) (next as HTMLElement).onclick = () => {
        _devicePageState.set(stateKey, Math.min(pages - 1, (_devicePageState.get(stateKey) || 0) + 1));
        _renderDevicesSection(section, group, slug, baseOffset, opts);
    };
}

function _z2mDeviceVisualHtml(d: IntegrationDeviceGroup, { size = 'card' }: { size?: string } = {}) {
    const url = String(d?.image_url || '').trim();
    const box = size === 'modal' ? 'w-10 h-10 rounded-xl' : 'w-8 h-8 rounded-lg';
    const iconSize = size === 'modal' ? 'text-base' : 'text-sm';
    const fallback = `<i class="fas fa-microchip text-accent/70 ${iconSize} shrink-0"></i>`;
    if (!url) return fallback;
    const src = escapeHtmlAttr(appendMediaQueryToken(url));
    return `<span class="relative inline-flex ${box} shrink-0 items-center justify-center bg-accent/10 border border-accent/20 overflow-hidden">
        <img src="${src}" alt="" class="w-full h-full object-contain p-0.5" loading="lazy"
            onerror="this.style.display='none';var f=this.nextElementSibling;if(f)f.style.display='flex'">
        <span class="hidden absolute inset-0 items-center justify-center">${fallback}</span>
    </span>`;
}

function _devCardHtml(d: IntegrationDeviceGroup, idx: number, slug: string, showEntryLabel = true) {
    const name = escapeHtml(d.name || d.device_id || t('integrations.device'));
    const ents = Array.isArray(d.entities) ? d.entities : [];
    const total = ents.length;
    const sub = [d.model, d.manufacturer].filter(Boolean).join(' · ');
    // Domain tally chips
    const tally: Record<string, number> = {};
    const _domOf = (ent: HyveEntity) => String(ent.domain || String(ent.entity_id || '').split('.')[0] || 'other').toLowerCase();
    for (const ent of ents) {
        const dom = _domOf(ent) || 'other';
        tally[dom] = (tally[dom] || 0) + 1;
    }
    const chips = Object.entries(tally).slice(0, 4).map(([dom, n]) => {
        const ic = getDomainIcon(dom);
        return `<span class="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-white/[0.04] border border-white/5 text-slate-400 uppercase tracking-wider"><i class="fas ${ic} text-[9px]"></i>${escapeHtml(dom)}<span class="text-slate-300">${n}</span></span>`;
    }).join('');
    // Primary readout: battery / state count (no on-count badge)
    let primary = `<span class="text-[10px] text-slate-500">${escapeHtml(t('integrations.entities_short', { count: total }))}</span>`;
    const sslug = escapeHtmlAttr(String(slug || ''));
    const entryTitle = (showEntryLabel && d.entry_title) ? escapeHtml(d.entry_title) : '';
    const entryHeader = entryTitle
        ? `<div class="flex items-center gap-1.5 mb-2 px-1 text-[10px] uppercase tracking-widest text-slate-500">
            <i class="fas fa-plug text-[9px] opacity-70"></i>
            <span class="truncate">${entryTitle}</span>
        </div>`
        : '';
    return `
    <div class="flex flex-col min-w-0">
        ${entryHeader}
        <div class="bg-white/[0.03] border border-white/5 rounded-xl p-4 hover:bg-white/[0.06] hover:border-accent/20 transition-all cursor-pointer overflow-hidden"
             data-entity-action="openDeviceModal" data-int-index="${idx}" data-int-slug="${sslug}">
            <div class="flex items-start justify-between gap-3 min-w-0">
                <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 min-w-0">
                        ${_z2mDeviceVisualHtml(d, { size: 'card' })}
                        <div class="text-[13px] font-semibold text-slate-100 fade-edge-r min-w-0 flex-1">${name}</div>
                    </div>
                    ${sub ? `<div class="text-[11px] text-slate-500 truncate mt-1">${escapeHtml(sub)}</div>` : ''}
                </div>
                <div class="shrink-0">${primary}</div>
            </div>
            ${chips ? `<div class="flex items-center gap-1.5 mt-3 flex-wrap min-w-0">${chips}</div>` : ''}
        </div>
    </div>`;
}

export async function loadIntegrationExposedEntities(integrationId: string) {
    const section = document.getElementById('integration-exposed-entities-section');
    const caption = document.getElementById('integration-exposed-entities-caption');
    const grid    = document.getElementById('integration-exposed-entities-grid');
    const empty   = document.getElementById('integration-exposed-entities-empty');
    const error   = document.getElementById('integration-exposed-entities-error');
    const openBtn = document.getElementById('integration-exposed-entities-open');
    const syncBtn = document.getElementById('integration-exposed-entities-sync');
    if (!section || !grid || !empty || !openBtn || !error) return null;

    const sourceSlug = integrationEntitySourceSlug(integrationId);
    if (!supportsIntegrationEntitySync(sourceSlug)) {
        section.classList.add('hidden');
        _disconnectIntegrationExposedLive();
        return null;
    }
    section.classList.remove('hidden');
    grid.innerHTML = '';
    grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-3';
    empty.classList.add('hidden');
    error.classList.add('hidden');
    if (caption) caption.textContent = t('common.loading_devices');

    openBtn.onclick = () => {
        navigateToSmartHomeSource(sourceSlug);
    };
    if (syncBtn) {
        const supportsSync = supportsIntegrationEntitySync(sourceSlug);
        syncBtn.classList.toggle('hidden', !supportsSync);
        syncBtn.classList.toggle('inline-flex', supportsSync);
        syncBtn.onclick = supportsSync ? async () => {
            await syncConfiguredIntegration(integrationId, syncBtn as HTMLButtonElement);
            await loadIntegrationExposedEntities(integrationId);
        } : null;
    }

    try {
        await getCameraStreamToken().catch(() => {});
        const res = await apiCall(`/api/integrations/${encodeURIComponent(sourceSlug)}/devices`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(translateApiDetail(data.detail) || translateApiDetail(data.message) || t('integrations.devices_load_error'));
        const devices = Array.isArray(data.devices) ? data.devices : [];
        const totalEnts = devices.reduce((s: number, d: IntegrationDeviceGroup) => s + ((d.entities && d.entities.length) || 0), 0);
        const meta = integrationDefinition(integrationId);
        const label = integrationLabel(meta) || integrationId;
        if (caption) caption.textContent = t('integrations.devices_caption', { label, devices: devices.length, entities: totalEnts });

        if (!devices.length) {
            _exposedDevicesState = { slug: sourceSlug, devices: [] };
            empty.classList.remove('hidden');
            return 0;
        }
        // Single continuous grid: cards flow one after another regardless of
        // entry. When more than one entry is in play, each card shows its
        // own entry title as a small caption below it. Sort so devices from
        // the same entry stay adjacent.
        const entryKeys = new Set(devices.map((d: IntegrationDeviceGroup) => d.entry_id || ''));
        const showEntryLabel = entryKeys.size > 1;
        const sorted = devices.slice().sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
            const ta = String(a.entry_title || '');
            const tb = String(b.entry_title || '');
            if (ta !== tb) return ta.localeCompare(tb);
            return String(a.name || '').localeCompare(String(b.name || ''));
        });
        _exposedDevicesState = { slug: sourceSlug, devices: sorted };
        grid.className = 'flex flex-col gap-3';
        grid.innerHTML = '';
        const section = document.createElement('div');
        section.className = 'space-y-3';
        section.dataset.entryKey = '__all__';
        section.dataset.baseOffset = '0';
        grid.appendChild(section);
        _renderDevicesSection(
            section,
            { key: '__all__', title: '', devices: sorted },
            sourceSlug,
            0,
            { showEntryLabel },
        );
        _connectIntegrationExposedLive(sourceSlug);
        return devices.length;
    } catch (err) {
        if (caption) caption.textContent = '';
        error.textContent = errMsg(err) || t('integrations.devices_load_error');
        error.classList.remove('hidden');
        return null;
    }
}
function _entityIcon(eid: string, domain: string): string {
    const dom = String(domain || String(eid || '').split('.')[0] || '').toLowerCase();
    return getDomainIcon(dom);
}

function _intCtrlAttrs(slug: string, eid: string, action: string, payload: Record<string, unknown> | null = null, { stop = false }: { stop?: boolean } = {}) {
    const payloadAttr = payload != null ? ` data-int-payload="${escapeHtmlAttr(JSON.stringify(payload))}"` : '';
    const stopAttr = stop ? ' data-entity-stop="1"' : '';
    return `data-entity-action="control" data-int-slug="${escapeHtmlAttr(slug)}" data-int-entity-id="${escapeHtmlAttr(eid)}" data-int-cmd="${escapeHtmlAttr(action)}"${payloadAttr}${stopAttr}`;
}

function _renderEntityControlRow(ent: HyveEntity, slug: string): string {
    const eid = String(ent.entity_id || '');
    const name = escapeHtml(String(ent.name || ent.friendly_name || eid));
    const dom = String(ent.domain || String(eid).split('.')[0] || '').toLowerCase();
    const state = entityStateForDisplay(dom, ent.state, tState);
    const unit = ent.unit ? ` ${escapeHtml(String(ent.unit))}` : '';
    const lower = state.toLowerCase();
    const isOn = isActiveState(lower);
    const isOff = ['off', 'closed', 'locked', 'idle', 'docked', 'paused'].includes(lower);
    const tone = isOn ? 'text-accent' : (isOff ? 'text-slate-400' : 'text-slate-200');
    const icon = _entityIcon(eid, dom);
    const eidA = escapeHtmlAttr(eid);
    const sA = escapeHtmlAttr(slug);

    let control = '';
    const attrs = (ent.attributes || {}) as Record<string, unknown>;
    const caps = (attrs.capabilities || {}) as Record<string, unknown>;
    const controllable = ent.controllable !== false && (CONTROLLABLE as readonly string[]).includes(dom);
    if (controllable && (dom === 'switch' || dom === 'light' || dom === 'input_boolean' || dom === 'fan' || dom === 'humidifier' || dom === 'water_heater' || dom === 'climate')) {
        const action = isOn ? 'turn_off' : 'turn_on';
        control = `<button type="button" role="switch" aria-checked="${isOn}"
            class="px-3 py-1.5 rounded-full text-[11px] font-bold border transition-colors shrink-0 ${isOn ? 'bg-accent/20 border-accent/40 text-accent' : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10'}"
            ${_intCtrlAttrs(slug, eid, action, null, { stop: true })}>
            ${isOn ? escapeHtml(tState('on')).toUpperCase() : escapeHtml(tState('off')).toUpperCase()}
        </button>`;
    } else if (controllable && (dom === 'cover' || dom === 'lock')) {
        const action = isOn ? (dom === 'lock' ? 'lock' : 'close_cover') : (dom === 'lock' ? 'unlock' : 'open_cover');
        control = `<button type="button"
            class="px-3 py-1.5 rounded-full text-[11px] font-bold border bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 shrink-0"
            ${_intCtrlAttrs(slug, eid, action, null, { stop: true })}>
            ${escapeHtml(action.replace('_', ' '))}
        </button>`;
    } else if (controllable && dom === 'vacuum') {
        const stateLbl = tState(lower);
        const vBtn = (vacAction: string, ic: string, title: string) => `<button type="button" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"
            class="w-8 h-8 rounded-full border bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-accent shrink-0 flex items-center justify-center transition-colors"
            ${_intCtrlAttrs(slug, eid, vacAction, null, { stop: true })}>
            <i class="fas ${ic} text-[11px]"></i>
        </button>`;
        control = `<div class="flex items-center gap-1.5 shrink-0">
            <span class="text-[10px] mono ${tone} mr-0.5">${escapeHtml(stateLbl)}</span>
            ${vBtn('start', 'fa-play', t('entity.render.vacuum_start'))}
            ${vBtn('stop', 'fa-stop', t('entity.render.vacuum_stop'))}
            ${vBtn('return_to_base', 'fa-house', t('entity.render.vacuum_dock'))}
        </div>`;
    } else if (controllable && dom === 'lawn_mower') {
        const stateLbl = tState(lower);
        const mBtn = (mowAction: string, ic: string, title: string) => `<button type="button" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"
            class="w-8 h-8 rounded-full border bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-accent shrink-0 flex items-center justify-center transition-colors"
            ${_intCtrlAttrs(slug, eid, mowAction, null, { stop: true })}>
            <i class="fas ${ic} text-[11px]"></i>
        </button>`;
        control = `<div class="flex items-center gap-1.5 shrink-0">
            <span class="text-[10px] mono ${tone} mr-0.5">${escapeHtml(stateLbl)}</span>
            ${mBtn('start', 'fa-play', t('entity.render.lawn_mower_start'))}
            ${mBtn('pause', 'fa-pause', t('entity.render.lawn_mower_pause'))}
            ${mBtn('stop', 'fa-stop', t('entity.render.stop'))}
            ${mBtn('return_to_base', 'fa-house', t('entity.render.lawn_mower_dock'))}
        </div>`;
    } else if (dom === 'number' && Number.isFinite(Number(ent.state))) {
        const min = caps.min ?? 0, max = caps.max ?? 100, step = caps.step ?? 1;
        const val = Number(ent.state);
        control = `<input type="range" min="${min}" max="${max}" step="${step}" value="${val}"
            class="w-24 md:w-32 shrink-0 accent-accent"
            ${_intCtrlAttrs(slug, eid, 'set')} data-int-input="valueFloat" data-entity-stop="1">`;
    } else if (dom === 'select') {
        const selectHtml = renderSelectControlHtml(
            slug,
            eid,
            attrs,
            caps as import('../types/entity.js').EntityCapabilities,
            String(ent.state ?? ''),
            _intCtrlAttrs,
            escapeHtmlAttr,
            escapeHtml,
        );
        if (selectHtml) {
            control = `<div class="int-entity-row__select-wrap">${selectHtml}</div>`;
        }
    } else if (controllable && dom === 'button') {
        control = `<button type="button"
            class="px-3 py-1.5 rounded-lg bg-accent/15 border border-accent/30 text-accent text-[11px] font-semibold shrink-0"
            title="${escapeHtml(t('entity.render.send'))}" aria-label="${escapeHtml(t('entity.render.send'))}"
            ${_intCtrlAttrs(slug, eid, 'press', null, { stop: true })}>
            <i class="fas fa-bolt mr-1"></i>${escapeHtml(t('entity.render.send'))}
        </button>`;
    }

    const encoded = encodeURIComponent(JSON.stringify(ent)).replace(/'/g, '%27');
    const stateHtml = `<span class="text-[11px] mono ${tone} truncate max-w-[9rem] text-right justify-self-end" data-entity-state="${eidA}">${escapeHtml(state)}${unit}</span>`;
    const controlHtml = control || stateHtml;
    return `<div class="int-entity-row px-3 py-3 bg-white/[0.03] border border-white/5 rounded-xl cursor-pointer hover:bg-white/[0.06] hover:border-accent/20 transition-colors"
        data-entity-action="openCard" data-int-encoded="${encoded}">
        <i class="fas ${icon} text-accent/70 text-sm w-4 text-center shrink-0"></i>
        <div class="int-entity-row__label">
            <div class="text-[12px] font-semibold text-slate-100 truncate">${name}</div>
            <div class="text-[10px] text-slate-500 mono truncate">${escapeHtml(eid)}</div>
        </div>
        ${controlHtml}
    </div>`;
}

// Pagination for the entity list inside the device-detail modal.
const _ENTITY_PAGE_SIZE = 5;
const _entityPageState = new Map<string, number>(); // key: `${slug}::${deviceId}` -> page index (0-based)

function _entityPageKey(slug: string, deviceId: string): string { return `${slug}::${deviceId}`; }

function _renderPaginatedEntityList(ents: HyveEntity[], slug: string, deviceId: string): string {
    const total = ents.length;
    const pageSize = _ENTITY_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const key = _entityPageKey(slug, deviceId);
    let page = _entityPageState.get(key) || 0;
    if (page >= pages) page = pages - 1;
    if (page < 0) page = 0;
    _entityPageState.set(key, page);

    const start = page * pageSize;
    const slice = ents.slice(start, start + pageSize);
    const rows = `<div class="space-y-2" data-entity-list>${slice.map(e => _renderEntityControlRow(e, slug)).join('')}</div>`;

    if (pages <= 1) return rows;

    const sA = escapeHtmlAttr(slug);
    const dA = escapeHtmlAttr(deviceId);
    const prevDisabled = page === 0;
    const nextDisabled = page >= pages - 1;
    const pager = `
    <div class="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-white/5" data-entity-pager>
        <button type="button" data-entity-page-prev
            ${prevDisabled ? 'disabled' : ''}
            class="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:cursor-not-allowed">
            <i class="fas fa-chevron-left mr-1"></i>${escapeHtml(t('common.prev'))}
        </button>
        <span class="text-[11px] text-slate-500 mono">${escapeHtml(t('integrations.entities_pager', { page: page + 1, pages, count: total }))}</span>
        <button type="button" data-entity-page-next
            ${nextDisabled ? 'disabled' : ''}
            data-slug="${sA}" data-device="${dA}"
            class="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-white/[0.04] text-slate-300 hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:cursor-not-allowed">
            ${escapeHtml(t('common.next'))}<i class="fas fa-chevron-right ml-1"></i>
        </button>
    </div>`;
    return rows + pager;
}

function _wireEntityListPagination(body: HTMLElement, ents: HyveEntity[], slug: string, deviceId: string): void {
    const key = _entityPageKey(slug, deviceId);
    const pages = Math.max(1, Math.ceil(ents.length / _ENTITY_PAGE_SIZE));
    const rerender = () => {
        const list = _renderPaginatedEntityList(ents, slug, deviceId);
        const oldList = body.querySelector('[data-entity-list]');
        const oldPager = body.querySelector('[data-entity-pager]');
        if (oldPager) oldPager.remove();
        if (oldList) {
            const wrap = document.createElement('div');
            wrap.innerHTML = list;
            oldList.replaceWith(...wrap.childNodes);
        }
        _wireEntityListPagination(body, ents, slug, deviceId);
    };
    const prev = body.querySelector('[data-entity-page-prev]');
    const next = body.querySelector('[data-entity-page-next]');
    if (prev) (prev as HTMLButtonElement).onclick = () => {
        const p = (_entityPageState.get(key) || 0) - 1;
        _entityPageState.set(key, Math.max(0, p));
        rerender();
    };
    if (next) (next as HTMLButtonElement).onclick = () => {
        const p = (_entityPageState.get(key) || 0) + 1;
        _entityPageState.set(key, Math.min(pages - 1, p));
        rerender();
    };
}

function _patchExposedEntityId(oldEntityId: string, newEntityId: string, uniqueId: string): void {
    const state = _exposedDevicesState;
    if (!state?.devices) return;
    for (const dev of state.devices) {
        for (const ent of dev.entities || []) {
            if (ent.entity_id === oldEntityId || (uniqueId && ent.unique_id === uniqueId)) {
                ent.entity_id = newEntityId;
            }
        }
    }
}

function _openIntegrationEntityDetailModal(entity: HyveEntity, slug: string): void {
    const modal = document.getElementById('entity-detail-modal');
    const iconEl = document.getElementById('entity-detail-modal-icon');
    const labelEl = document.getElementById('entity-detail-modal-label');
    const body = document.getElementById('entity-detail-modal-body');
    if (!modal || !body || !entity) return;

    stopCameraPreviewRefresh();
    modal.querySelectorAll('hv-camera-stream').forEach(el => {
        try { (el as HTMLElement & { pauseStream?: () => void }).pauseStream?.(); } catch (_) {}
    });

    const dom = String(entity.domain || String(entity.entity_id || '').split('.')[0] || '').toLowerCase();
    const entAttrs = (entity.attributes || {}) as Record<string, unknown>;
    const entCaps = (entAttrs.capabilities || {}) as Record<string, unknown>;
    const dc = String(entCaps.device_class || entAttrs.device_class || '');
    const icon = getDomainIcon(dom, dc);
    if (iconEl) iconEl.className = `fas ${icon}`;
    if (labelEl) labelEl.textContent = String(entity.name || entity.entity_id || 'Entity');

    const entitySlug = slug || _exposedDevicesState?.slug || String(entity.source || '');
    body.innerHTML = renderEntityModal(entity, entitySlug);
    wireEntityRegistryEditor(body, entity, {
        onUpdated: ({ oldEntityId, newEntityId, uniqueId }) => {
            _patchExposedEntityId(oldEntityId, newEntityId, uniqueId);
            _openIntegrationEntityDetailModal(entity, entitySlug);
        },
    });
    if (modal.parentNode !== document.body) document.body.appendChild(modal);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    startCameraPreviewRefresh();
}

export function openIntegrationEntityCard(encoded: string) {
    let entity: HyveEntity | null = null;
    try {
        entity = JSON.parse(decodeURIComponent(encoded)) as HyveEntity;
    } catch (_) {
        return;
    }
    if (!entity || !entity.entity_id) return;
    _openIntegrationEntityDetailModal(entity, _exposedDevicesState?.slug || String(entity.source || ''));
};

export function openIntegrationDeviceModal(idx: number, slug: string) {
    const state = _exposedDevicesState;
    if (!state || !integrationSlugsMatch(state.slug || '', slug)) return;
    const dev = state.devices[idx];
    if (!dev) return;
    const modal = document.getElementById('entity-detail-modal');
    const iconEl = document.getElementById('entity-detail-modal-icon');
    const labelEl = document.getElementById('entity-detail-modal-label');
    const body = document.getElementById('entity-detail-modal-body');
    if (!modal || !body) return;
    if (iconEl) iconEl.className = 'fas fa-microchip';
    if (labelEl) labelEl.textContent = t('common.device');

    const name = escapeHtml(dev.name || dev.device_id || (t('common.device')));
    const sub = [dev.model, dev.manufacturer].filter(Boolean).join(' · ');
    const ents = (dev.entities || []).slice().sort((a, b) => {
        const order: Record<string, number> = { switch: 0, light: 1, cover: 2, lock: 3, climate: 4, number: 5, select: 6, button: 7, event: 8, binary_sensor: 9, sensor: 10 };
        const da = String(a.entity_id || '').split('.')[0];
        const db = String(b.entity_id || '').split('.')[0];
        const oa = order[da] ?? 99, ob = order[db] ?? 99;
        if (oa !== ob) return oa - ob;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });

    const sA = escapeHtmlAttr(slug);
    const didA = escapeHtmlAttr(dev.device_id || '');
    const curA = escapeHtmlAttr(dev.name || dev.device_id || '');

    const hero = `
    <div class="rounded-2xl bg-white/5 border border-white/10 p-3 mb-3 flex items-start gap-3">
        ${_z2mDeviceVisualHtml(dev, { size: 'modal' })}
        <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-[9px] uppercase tracking-widest text-slate-500">
                <span>Dispozitiv</span>
                <button type="button" id="entity-detail-rename-btn" class="hover:text-accent transition-colors" title="${escapeHtml(t('integrations.rename_device_title'))}">
                    <i class="fas fa-pen text-[10px]"></i>
                </button>
            </div>
            <div id="entity-detail-name-view" class="text-sm font-semibold text-slate-100 mt-0.5 break-words leading-snug">${name}</div>
            <div id="entity-detail-name-edit" class="hidden mt-1 flex flex-col gap-2">
                <div class="flex items-center gap-2">
                    <input type="text" id="entity-detail-name-input" value="${curA}"
                        class="flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-accent/40">
                    <button type="button" id="entity-detail-name-save" class="px-2 py-1 rounded-lg bg-accent/20 border border-accent/40 text-accent text-[11px] font-semibold hover:bg-accent/30 shrink-0">
                        <i class="fas fa-check"></i>
                    </button>
                    <button type="button" id="entity-detail-name-cancel" class="px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-[11px] hover:bg-white/10 shrink-0">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <label class="flex items-start gap-2 text-[10px] text-slate-400 cursor-pointer select-none">
                    <input type="checkbox" id="entity-detail-ha-rename" checked
                        class="mt-0.5 rounded border-white/20 bg-white/5 text-accent focus:ring-accent/40">
                    <span>
                        <span class="text-slate-300">${escapeHtml(t('integrations.update_entity_ids'))}</span>
                        <span class="block text-slate-500 mt-0.5">${escapeHtml(t('integrations.update_entity_ids_hint'))}</span>
                    </span>
                </label>
            </div>
            ${sub ? `<div class="text-[10px] text-slate-500 break-words mt-0.5">${escapeHtml(sub)}</div>` : ''}
            <div class="text-[9px] text-slate-500 mono break-all mt-1 leading-snug">${escapeHtml(dev.device_id || '')}</div>
        </div>
        <div class="text-right shrink-0">
            <div class="text-lg font-semibold text-slate-200 mono leading-none">${ents.length}</div>
            <div class="text-[9px] uppercase tracking-wider text-slate-500 mt-0.5">${escapeHtml(t('integrations.entities_label'))}</div>
        </div>
    </div>`;
    const list = ents.length
        ? _renderPaginatedEntityList(ents, slug, dev.device_id || '')
        : `<div class="text-[11px] text-slate-500 text-center py-6">${escapeHtml(t('integrations.no_controls'))}</div>`;
    body.innerHTML = hero + list;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    _wireEntityListPagination(body, ents, slug, dev.device_id || '');

    // Wire inline rename UI
    const view = body.querySelector('#entity-detail-name-view');
    const edit = body.querySelector('#entity-detail-name-edit');
    const input = body.querySelector('#entity-detail-name-input') as HTMLInputElement | null;
    const renameBtn = body.querySelector('#entity-detail-rename-btn') as HTMLButtonElement | null;
    const saveBtn = body.querySelector('#entity-detail-name-save') as HTMLButtonElement | null;
    const cancelBtn = body.querySelector('#entity-detail-name-cancel') as HTMLButtonElement | null;
    const showEdit = () => { view?.classList.add('hidden'); edit?.classList.remove('hidden'); input?.focus(); input?.select(); };
    const hideEdit = () => { edit?.classList.add('hidden'); view?.classList.remove('hidden'); };
    if (renameBtn) renameBtn.onclick = showEdit;
    if (cancelBtn) cancelBtn.onclick = hideEdit;
    const submit = () => {
        const haRename = body.querySelector('#entity-detail-ha-rename') as HTMLInputElement | null;
        const updateIds = haRename ? haRename.checked : true;
        renameIntegrationDevice(
            slug,
            dev.device_id || '',
            dev.name || dev.device_id || '',
            input?.value || '',
            updateIds,
        );
    };
    if (saveBtn) saveBtn.onclick = submit;
    if (input) input.onkeydown = (ev: KeyboardEvent) => {
        if (ev.key === 'Enter') { ev.preventDefault(); submit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); hideEdit(); }
    };
};

export async function controlIntegrationEntity(slug: string, entityId: string, action: string, btn: HTMLElement | null, data: Record<string, unknown> | null) {
    if (btn) { (btn as HTMLButtonElement).disabled = true; btn.dataset._prev = btn.innerHTML || ''; }
    // Optimistic local update so the UI reacts instantly without waiting for
    // the server to round-trip a full re-fetch.
    let prevState = null;
    let touchedEnt = null;
    let touchedIdx = -1;
    if (_exposedDevicesState.slug && integrationSlugsMatch(_exposedDevicesState.slug, slug)) {
        for (let i = 0; i < _exposedDevicesState.devices.length; i++) {
            const found = (_exposedDevicesState.devices[i].entities || []).find(e => e.entity_id === entityId);
            if (found) { touchedEnt = found; touchedIdx = i; break; }
        }
        if (touchedEnt) {
            prevState = touchedEnt.state;
            if (action === 'turn_on' || action === 'open_cover' || action === 'unlock') touchedEnt.state = 'on';
            else if (action === 'turn_off' || action === 'close_cover' || action === 'lock') touchedEnt.state = 'off';
            else if (action === 'set' && data && data.value !== undefined) touchedEnt.state = String(data.value);
            const modal = document.getElementById('entity-detail-modal');
            if (modal && !modal.classList.contains('hidden') && touchedIdx >= 0) {
                openIntegrationDeviceModal(touchedIdx, slug);
            }
        }
    }
    try {
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/control`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_id: entityId, action, data: data || {} }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(integrationApiError(out.detail, 'integrations.action_failed'));
    } catch (err) {
        // Rollback optimistic update
        if (touchedEnt) {
            touchedEnt.state = prevState;
            const modal = document.getElementById('entity-detail-modal');
            if (modal && !modal.classList.contains('hidden') && touchedIdx >= 0) {
                openIntegrationDeviceModal(touchedIdx, slug);
            }
        }
        if (typeof showToast === 'function') showToast(errMsg(err) || t('common.error'), 'error', 2500);
    } finally {
        if (btn) { (btn as HTMLButtonElement).disabled = false; }
    }
};

export async function renameIntegrationDevice(slug: string, deviceId: string, currentName: string, providedName?: string, homeassistantRename = true) {
    let next = providedName;
    if (next == null) {
        next = window.prompt(t('integrations.device_rename_prompt'), currentName || '') ?? undefined;
        if (next == null) return;
    }
    const trimmed = String(next).trim();
    if (!trimmed || trimmed === currentName) return;
    try {
        const res = await apiCall(`/api/integrations/${encodeURIComponent(slug)}/device/${encodeURIComponent(deviceId)}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: trimmed,
                current_name: currentName || deviceId,
                homeassistant_rename: homeassistantRename !== false,
            }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(integrationApiError(out.detail, 'integrations.device_rename_failed'));
        // Backend purges stale MQTT discovery + force-sync; reload device list so
        // entity rows match the new friendly name (not only the card title).
        const section = document.getElementById('integration-exposed-entities-section');
        if (section && !section.classList.contains('hidden')) {
            const integrationId = integrationIdForSourceSlug(slug);
            if (integrationId) {
                try { await loadIntegrationExposedEntities(integrationId); } catch (_) {}
            }
        } else if (_exposedDevicesState.slug && integrationSlugsMatch(_exposedDevicesState.slug, slug)) {
            const idx = _exposedDevicesState.devices.findIndex(d => (d.device_id || '') === deviceId);
            if (idx >= 0) {
                _exposedDevicesState.devices[idx].name = trimmed;
                const grid = document.getElementById('integration-exposed-entities-grid');
                if (grid) grid.innerHTML = _exposedDevicesState.devices.map((d, i) => _devCardHtml(d, i, slug)).join('');
                const modal = document.getElementById('entity-detail-modal');
                if (modal && !modal.classList.contains('hidden')) {
                    openIntegrationDeviceModal(idx, slug);
                }
            }
        }
        if (typeof showToast === 'function') {
            showToast(t('integrations.device_rename_synced') || t('integrations.device_rename_ok'), 'success', 2200);
        }
    } catch (err) {
        if (typeof showToast === 'function') showToast(errMsg(err) || t('common.error'), 'error', 3000);
    }
};
