/**
 * Smarthome UI event delegation — modals + dynamically rendered device list.
 */
import { consumeDevicePrimaryHoldClick } from './device_primary_modal.js';
const _ROOTS = '#view-smarthome, #entity-detail-modal, #derived-modal, #hy-row-actions-modal, #hy-alias-modal, #hy-device-primary-modal';
let _handlers = null;
let _bound = false;
let _lightBrightnessTimer = null;
function _lightControlPayload(el) {
    const kind = el.dataset.smarthomeLightInput || '';
    const entityId = el.dataset.smarthomeEntityId || '';
    if (!entityId || !kind)
        return null;
    if (kind === 'brightness') {
        const scale = Number(el.dataset.smarthomeLightScale || 254) || 254;
        const pct = Number(el.value);
        const brightness = Math.round((pct / 100) * scale);
        const label = document.querySelector(`[data-smarthome-light-brightness-label="${CSS.escape(entityId)}"]`);
        if (label)
            label.textContent = `${Math.round(pct)}%`;
        return { action: 'set_brightness', data: { brightness, brightness_pct: pct } };
    }
    if (kind === 'color_temp') {
        const colorTemp = Number(el.value);
        const strong = el.closest('.hy-detail-light-row')?.querySelector('strong');
        if (strong)
            strong.textContent = String(colorTemp);
        return { action: 'set_color_temp', data: { color_temp: colorTemp } };
    }
    if (kind === 'color') {
        const hex = String(el.value || '').replace('#', '');
        if (hex.length !== 6)
            return null;
        const r = parseInt(hex.slice(0, 2), 16);
        const g = parseInt(hex.slice(2, 4), 16);
        const b = parseInt(hex.slice(4, 6), 16);
        return { action: 'set', data: { state: 'ON', color: { r, g, b } } };
    }
    return null;
}
function _sendLightControl(el) {
    const source = el.dataset.smarthomeSource || '';
    const entityId = el.dataset.smarthomeEntityId || '';
    const payload = _lightControlPayload(el);
    if (!source || !entityId || !payload)
        return;
    void _handlers?.controlDeviceEntity?.(source, entityId, payload.action, el, payload.data);
}
function _handleLightControlInput(el) {
    if (el.dataset.smarthomeLightInput !== 'brightness')
        return;
    _lightControlPayload(el);
    if (_lightBrightnessTimer)
        clearTimeout(_lightBrightnessTimer);
    _lightBrightnessTimer = setTimeout(() => _sendLightControl(el), 220);
}
function _handleLightControlChange(el) {
    if (el.dataset.smarthomeLightInput === 'brightness' && _lightBrightnessTimer) {
        clearTimeout(_lightBrightnessTimer);
        _lightBrightnessTimer = null;
    }
    _sendLightControl(el);
}
function _inSmarthome(el) {
    return !!el?.closest(_ROOTS);
}
function _entityId(el) {
    const host = el.closest('[data-smarthome-entity-id]');
    return String(el.dataset.smarthomeEntityId || (host instanceof HTMLElement ? host.dataset.smarthomeEntityId : '') || '').trim();
}
function _delegatedEvent(event, el) {
    return { ...event, currentTarget: el, target: event.target };
}
function _run(action, el, event) {
    if (!_handlers || !_inSmarthome(el))
        return;
    if (el.dataset.smarthomeBackdropDismiss === 'true' && event.target !== el)
        return;
    if (el.dataset.smarthomeStopPropagation === 'true')
        event.stopPropagation();
    switch (action) {
        case 'switchDerivedView':
            _handlers.switchDerivedView?.(el.dataset.smarthomeView || '', event, el);
            return;
        case 'switchDerivedBuilder':
            _handlers.switchDerivedBuilder?.(el.dataset.smarthomeBuilder || '', event, el);
            return;
        case 'openDerivedModal': {
            // Toolbar button is the action host; on rows, ignore nested controls (checkbox, alias).
            if (event.target instanceof Element && el !== event.target.closest('button, input, a, label')) {
                const nested = event.target.closest('button, input, a, label');
                if (nested && el.contains(nested))
                    return;
            }
            _handlers.openDerivedModal?.(_entityId(el), event, el);
            return;
        }
        case 'haRowClick':
            _handlers.handleHaRowClick?.(_delegatedEvent(event, el));
            return;
        case 'openAliasModal':
            event.stopPropagation();
            _handlers.openAliasModal?.(_entityId(el), event, el);
            return;
        case 'sortDevices':
            _handlers.sortDevicesBy?.(el.dataset.smarthomeSort || 'name', event, el);
            return;
        case 'setDevicesPage':
            _handlers.setDevicesPage?.(Number(el.dataset.smarthomePage || 0), event, el);
            return;
        case 'togglePicker':
            _handlers.toggleSmarthomePicker?.(_delegatedEvent(event, el));
            return;
        case 'selectPickerOption':
            _handlers.selectSmarthomePickerOption?.(_delegatedEvent(event, el));
            return;
        case 'openAliasModalFromDetail':
            _handlers.openAliasModalFromDetail?.(_entityId(el), event, el);
            return;
        case 'controlDevice': {
            const holdRoot = el.closest('[data-smarthome-primary-hold-root]');
            if (consumeDevicePrimaryHoldClick(holdRoot))
                return;
            _handlers.controlDeviceEntity?.(el.dataset.smarthomeSource || '', _entityId(el), el.dataset.smarthomeDeviceAction || '', el, {});
            return;
        }
        case 'openDeviceDetail': {
            if (event.target instanceof Element) {
                const blocked = event.target.closest('button, input, a, label, [data-smarthome-stop-propagation="true"]');
                if (blocked && el.contains(blocked) && blocked !== el)
                    return;
            }
            event.stopPropagation();
            const key = el.dataset.deviceKey || '';
            if (key)
                _handlers.openDeviceDetail?.(key, event, el);
            return;
        }
        case 'closeDeviceDetail':
            _handlers.closeDeviceDetail?.(event, el);
            return;
        case 'openEntityDetail': {
            event.stopPropagation();
            const eid = el.dataset.smarthomeEntityId || _entityId(el);
            if (eid)
                _handlers.openEntityDetail?.(eid, event, el);
            return;
        }
        case 'closeEntityDetail':
            _handlers.closeEntityDetail?.(event, el);
            return;
        case 'renameDeviceDetail':
            event.stopPropagation();
            _handlers.renameDeviceDetail?.(event, el);
            return;
        case 'closeDevicePrimaryModal':
            _handlers.closeDevicePrimaryModal?.(event, el);
            return;
        case 'selectDevicePrimaryEntity': {
            event.stopPropagation();
            const auto = el.dataset.auto === 'true';
            const entityId = auto ? null : (el.dataset.entityId || null);
            _handlers.selectDevicePrimaryEntity?.(el.dataset.deviceKey || '', entityId, event, el);
            return;
        }
        case 'filterEntityCategory':
            event.preventDefault();
            _handlers.filterEntityCategory?.(el.dataset.smarthomeCategory || 'all', event, el);
            return;
        case 'removeAliasRow':
            el.closest('.flex.gap-2.items-center')?.remove();
            return;
        default: {
            const fn = _handlers[action];
            if (typeof fn === 'function')
                fn(event, el);
        }
    }
}
function _onClick(event) {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const el = target.closest('[data-smarthome-action]');
    if (!(el instanceof HTMLElement))
        return;
    _run(el.dataset.smarthomeAction || '', el, event);
}
function _onChange(event) {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const lightCtrl = target.closest('[data-smarthome-light-input]');
    if (lightCtrl instanceof HTMLInputElement && _inSmarthome(lightCtrl)) {
        _handleLightControlChange(lightCtrl);
        return;
    }
    const el = target.closest('[data-smarthome-change]');
    if (!(el instanceof HTMLElement) || !_inSmarthome(el))
        return;
    const kind = el.dataset.smarthomeChange;
    const entityId = _entityId(el);
    if (kind === 'toggleSelection') {
        event.stopPropagation();
        _handlers?.toggleSelection?.(entityId, el instanceof HTMLInputElement ? el.checked : false, event, el);
        return;
    }
    if (kind === 'toggleDerivedSelection') {
        _handlers?.toggleDerivedSelection?.(entityId, el instanceof HTMLInputElement ? el.checked : false, event, el);
        return;
    }
    if (kind === 'toggleAllAIVisible') {
        _handlers?.toggleAllAIVisible?.(el instanceof HTMLInputElement ? el.checked : false, event, el);
        return;
    }
    if (kind === 'setDevicesPageSize') {
        _handlers?.setDevicesPageSize?.(el instanceof HTMLSelectElement ? el.value : String(el.getAttribute('value') || ''), event, el);
        return;
    }
    if (kind === 'toggleDerivedInput') {
        _handlers?.toggleDerivedInput?.(el, event);
        return;
    }
}
function _onInput(event) {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const lightCtrl = target.closest('[data-smarthome-light-input]');
    if (lightCtrl instanceof HTMLInputElement && _inSmarthome(lightCtrl)) {
        _handleLightControlInput(lightCtrl);
        return;
    }
    const el = target.closest('[data-smarthome-input]');
    if (!(el instanceof HTMLElement) || !_inSmarthome(el))
        return;
    const kind = el.dataset.smarthomeInput;
    if (kind === 'filterDerivedCandidates')
        _handlers?.filterDerivedCandidates?.(event, el);
}
/** Commit a light control from a bound input (used by custom light color picker). */
export function commitSmarthomeLightControl(el) {
    if (!el.dataset.smarthomeLightInput || !_inSmarthome(el))
        return;
    _handleLightControlChange(el);
}
export function initSmarthomeEventBindings(handlers = {}) {
    _handlers = handlers;
    if (_bound)
        return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
    document.addEventListener('change', _onChange, false);
    document.addEventListener('input', _onInput, false);
}
