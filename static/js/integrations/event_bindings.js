/**
 * Integration entity control delegation — replaces inline onclick/onchange
 * in entity_renderers.js (and related integration UI).
 */
let _handlers = null;
let _bound = false;
function _parsePayload(el) {
    const raw = el.dataset.intPayload;
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function _controlPayload(el) {
    const kind = el.dataset.intInput || '';
    if (kind === 'brightness' && 'value' in el) {
        return { brightness: parseInt(String(el.value), 10) };
    }
    if (kind === 'color' && 'value' in el) {
        const hex = String(el.value || '').replace('#', '');
        if (hex.length !== 6)
            return null;
        return {
            state: 'ON',
            color: {
                r: parseInt(hex.slice(0, 2), 16),
                g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16),
            },
        };
    }
    if (kind === 'valueFloat' && 'value' in el) {
        return { value: parseFloat(String(el.value)) };
    }
    if (kind === 'valueString' && 'value' in el) {
        return { value: el.value };
    }
    return _parsePayload(el);
}
function _controlFromEl(el, event) {
    if (el.dataset.entityStop === '1')
        event.stopPropagation();
    const slug = el.dataset.intSlug || '';
    const entityId = el.dataset.intEntityId || '';
    const cmd = el.dataset.intCmd || '';
    if (!slug || !entityId || !cmd)
        return;
    void _handlers?.controlIntegrationEntity?.(slug, entityId, cmd, el, _controlPayload(el));
}
function _onClick(event) {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const ctrl = target.closest('[data-entity-action="control"]');
    if (ctrl instanceof HTMLElement && ctrl.tagName !== 'INPUT' && ctrl.tagName !== 'SELECT') {
        _controlFromEl(ctrl, event);
        return;
    }
    const openCard = target.closest('[data-entity-action="openCard"]');
    if (openCard instanceof HTMLElement) {
        const encoded = openCard.dataset.intEncoded || '';
        if (encoded)
            _handlers?.openIntegrationEntityCard?.(encoded);
        return;
    }
    const openDevice = target.closest('[data-entity-action="openDeviceCard"]');
    if (openDevice instanceof HTMLElement) {
        const encoded = openDevice.dataset.intEncoded || '';
        if (encoded)
            _handlers?.openIntegrationEntityCard?.(encoded);
        return;
    }
    const openDeviceModal = target.closest('[data-entity-action="openDeviceModal"]');
    if (openDeviceModal instanceof HTMLElement) {
        const idx = Number(openDeviceModal.dataset.intIndex);
        const slug = openDeviceModal.dataset.intSlug || '';
        if (Number.isFinite(idx))
            _handlers?.openIntegrationDeviceModal?.(idx, slug);
        return;
    }
    const rename = target.closest('[data-entity-action="renameDevice"]');
    if (rename instanceof HTMLElement) {
        event.stopPropagation();
        void _handlers?.renameIntegrationDevice?.(rename.dataset.intSlug || '', rename.dataset.intDeviceId || '', rename.dataset.intDeviceName || '');
    }
}
function _onChange(event) {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const el = target.closest('[data-entity-action="control"]');
    if (!(el instanceof HTMLElement))
        return;
    _controlFromEl(el, event);
}
function _onInput(event) {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const el = target.closest('[data-int-input-preview]');
    if (!(el instanceof HTMLElement))
        return;
    event.stopPropagation();
    const entityId = el.dataset.intEntityId || '';
    const unit = el.dataset.intUnit || '';
    window.__previewIntegrationNumberValue?.(entityId, 'value' in el ? String(el.value) : '', unit);
}
export function initIntegrationEventBindings(handlers = {}) {
    _handlers = handlers;
    if (_bound)
        return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
    document.addEventListener('change', _onChange, false);
    document.addEventListener('input', _onInput, false);
}
