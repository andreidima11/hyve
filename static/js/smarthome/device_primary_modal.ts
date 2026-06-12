/**
 * Long-press on device overview status → pick primary entity (multi-switch relays).
 */
import {
    autoPrimaryDeviceEntity,
    getDevicePrimaryEntityOverride,
    primaryEntityCandidates,
} from '../device_primary_entity.js';
import type { PhysicalDeviceGroup } from '../devices_group.js';
import { t } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr } from '../utils.js';

const HOLD_MS = 480;
const MOVE_CANCEL_PX = 10;

let _holdBound = false;
let _holdTimer: ReturnType<typeof setTimeout> | null = null;
let _holdRoot: HTMLElement | null = null;
let _holdStartX = 0;
let _holdStartY = 0;
let _holdMoveListener: ((ev: PointerEvent) => void) | null = null;
let _holdUpListener: ((ev: PointerEvent) => void) | null = null;

function _entityDisplayName(entity: { name?: string; entity_id?: string }): string {
    return String(entity.name || entity.entity_id || '').trim();
}

function _clearHoldListeners() {
    if (_holdTimer) {
        clearTimeout(_holdTimer);
        _holdTimer = null;
    }
    if (_holdMoveListener) {
        document.removeEventListener('pointermove', _holdMoveListener);
        _holdMoveListener = null;
    }
    if (_holdUpListener) {
        document.removeEventListener('pointerup', _holdUpListener);
        document.removeEventListener('pointercancel', _holdUpListener);
        _holdUpListener = null;
    }
    _holdRoot = null;
}

function _cancelHold(ev?: PointerEvent) {
    if (ev?.type === 'pointermove') {
        const dx = ev.clientX - _holdStartX;
        const dy = ev.clientY - _holdStartY;
        if (Math.hypot(dx, dy) <= MOVE_CANCEL_PX) return;
    }
    _clearHoldListeners();
}

export function consumeDevicePrimaryHoldClick(root: HTMLElement | null): boolean {
    if (!root || root.dataset.holdFired !== 'true') return false;
    delete root.dataset.holdFired;
    return true;
}

function _renderPrimaryEntityModalBody(device: PhysicalDeviceGroup): string {
    const candidates = primaryEntityCandidates(device);
    const overrideId = getDevicePrimaryEntityOverride(device.device_key);
    const autoPrimary = autoPrimaryDeviceEntity(device);
    const deviceKey = escapeHtmlAttr(device.device_key);

    const autoSelected = !overrideId;
    const autoDesc = escapeHtml(t('hy.detail_primary_entity_auto_desc'));
    const options = [
        `<button type="button" class="hyd-primary-entity-option"
            data-smarthome-action="selectDevicePrimaryEntity"
            data-device-key="${deviceKey}"
            data-entity-id=""
            data-auto="true"
            data-selected="${autoSelected ? 'true' : 'false'}">
            <span class="hyd-primary-entity-option__body">
                <span class="hyd-primary-entity-option__label">${escapeHtml(t('hy.detail_primary_entity_auto'))}</span>
                <span class="hyd-primary-entity-option__id">${autoDesc}</span>
            </span>
            <span class="hyd-primary-entity-option__check" aria-hidden="true"></span>
        </button>`,
        ...candidates.map((ent) => {
            const eid = String(ent.entity_id || '');
            const selected = overrideId ? eid === overrideId : eid === String(autoPrimary?.entity_id || '');
            const label = _entityDisplayName(ent);
            const sub = eid !== label
                ? `<span class="hyd-primary-entity-option__id mono">${escapeHtml(eid)}</span>`
                : `<span class="hyd-primary-entity-option__id hyd-primary-entity-option__id--placeholder" aria-hidden="true">&nbsp;</span>`;
            return `<button type="button" class="hyd-primary-entity-option"
                data-smarthome-action="selectDevicePrimaryEntity"
                data-device-key="${deviceKey}"
                data-entity-id="${escapeHtmlAttr(eid)}"
                data-selected="${selected ? 'true' : 'false'}">
                <span class="hyd-primary-entity-option__body">
                    <span class="hyd-primary-entity-option__label">${escapeHtml(label)}</span>${sub}
                </span>
                <span class="hyd-primary-entity-option__check" aria-hidden="true"></span>
            </button>`;
        }),
    ];
    return options.join('');
}

export function openDevicePrimaryEntityModal(device: PhysicalDeviceGroup): void {
    const modal = document.getElementById('hy-device-primary-modal');
    const list = document.getElementById('hy-device-primary-entity-list');
    if (!modal || !list) return;
    list.innerHTML = _renderPrimaryEntityModalBody(device);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    modal.setAttribute('aria-hidden', 'false');
}

export function closeDevicePrimaryEntityModal(): void {
    const modal = document.getElementById('hy-device-primary-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modal.setAttribute('aria-hidden', 'true');
}

export function initDevicePrimaryHoldBindings(
    resolveDevice: (deviceKey: string) => PhysicalDeviceGroup | null,
): void {
    if (_holdBound || typeof document === 'undefined') return;
    _holdBound = true;

    document.addEventListener('pointerdown', (event: PointerEvent) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const root = target.closest('[data-smarthome-primary-hold-root]') as HTMLElement | null;
        if (!root) return;
        if (event.button !== 0) return;

        _clearHoldListeners();
        _holdRoot = root;
        _holdStartX = event.clientX;
        _holdStartY = event.clientY;

        _holdMoveListener = (ev: PointerEvent) => _cancelHold(ev);
        _holdUpListener = () => _clearHoldListeners();
        document.addEventListener('pointermove', _holdMoveListener, { passive: true });
        document.addEventListener('pointerup', _holdUpListener, { passive: true });
        document.addEventListener('pointercancel', _holdUpListener, { passive: true });

        _holdTimer = setTimeout(() => {
            _clearHoldListeners();
            const deviceKey = root.dataset.deviceKey || '';
            const device = resolveDevice(deviceKey);
            if (!device) return;
            root.dataset.holdFired = 'true';
            try { navigator.vibrate?.(8); } catch (_) { /* noop */ }
            openDevicePrimaryEntityModal(device);
        }, HOLD_MS);
    }, true);
}
