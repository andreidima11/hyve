/**
 * Smarthome UI event delegation — modals + dynamically rendered device list.
 */

import type { SmarthomeEventHandlers } from '../types/integration.js';

const _ROOTS = '#view-smarthome, #entity-detail-modal, #derived-modal, #hy-row-actions-modal, #hy-alias-modal';

let _handlers: SmarthomeEventHandlers | null = null;
let _bound = false;

function _inSmarthome(el: Element | null): boolean {
    return !!el?.closest(_ROOTS);
}

function _entityId(el: HTMLElement): string {
    const host = el.closest('[data-smarthome-entity-id]');
    return String(el.dataset.smarthomeEntityId || (host instanceof HTMLElement ? host.dataset.smarthomeEntityId : '') || '').trim();
}

function _delegatedEvent(event: Event, el: HTMLElement): Event {
    return { ...event, currentTarget: el, target: event.target };
}

function _run(action: string, el: HTMLElement, event: Event): void {
    if (!_handlers || !_inSmarthome(el)) return;
    if (el.dataset.smarthomeBackdropDismiss === 'true' && event.target !== el) return;
    if (el.dataset.smarthomeStopPropagation === 'true') event.stopPropagation();

    switch (action) {
    case 'switchDerivedView':
        _handlers.switchDerivedView?.(el.dataset.smarthomeView || '', event, el);
        return;
    case 'switchDerivedBuilder':
        _handlers.switchDerivedBuilder?.(el.dataset.smarthomeBuilder || '', event, el);
        return;
    case 'openDerivedModal':
        if (event.target instanceof Element && event.target.closest('button, input, a, label')) return;
        _handlers.openDerivedModal?.(_entityId(el), event, el);
        return;
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
    case 'controlDevice':
        _handlers.controlDeviceEntity?.(
            el.dataset.smarthomeSource || '',
            _entityId(el),
            el.dataset.smarthomeDeviceAction || '',
            el,
            event,
        );
        return;
    case 'removeAliasRow':
        el.closest('.flex.gap-2.items-center')?.remove();
        return;
    default: {
        const fn = _handlers[action];
        if (typeof fn === 'function') fn(event, el);
    }
    }
}

function _onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const el = target.closest('[data-smarthome-action]');
    if (!(el instanceof HTMLElement)) return;
    _run(el.dataset.smarthomeAction || '', el, event);
}

function _onChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const el = target.closest('[data-smarthome-change]');
    if (!(el instanceof HTMLElement) || !_inSmarthome(el)) return;
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
    }
}

function _onInput(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const el = target.closest('[data-smarthome-input]');
    if (!(el instanceof HTMLElement) || !_inSmarthome(el)) return;
    const kind = el.dataset.smarthomeInput;
    if (kind === 'filterDerivedCandidates') _handlers?.filterDerivedCandidates?.(event, el);
}

export function initSmarthomeEventBindings(handlers: SmarthomeEventHandlers = {}): void {
    _handlers = handlers;
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
    document.addEventListener('change', _onChange, false);
    document.addEventListener('input', _onInput, false);
}
