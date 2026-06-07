/**
 * Integration entity control delegation — replaces inline onclick/onchange
 * in entity_renderers.js (and related integration UI).
 */

let _bound = false;

function _parsePayload(el) {
    const raw = el.dataset.intPayload;
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function _controlPayload(el) {
    const kind = el.dataset.intInput || '';
    if (kind === 'brightness') return { brightness: parseInt(el.value, 10) };
    if (kind === 'valueFloat') return { value: parseFloat(el.value) };
    if (kind === 'valueString') return { value: el.value };
    return _parsePayload(el);
}

function _controlFromEl(el, event) {
    if (el.dataset.entityStop === '1') event.stopPropagation();
    const slug = el.dataset.intSlug || '';
    const entityId = el.dataset.intEntityId || '';
    const cmd = el.dataset.intCmd || '';
    if (!slug || !entityId || !cmd) return;
    if (typeof window.controlIntegrationEntity !== 'function') return;
    window.controlIntegrationEntity(slug, entityId, cmd, el, _controlPayload(el));
}

function _onClick(event) {
    const ctrl = event.target.closest('[data-entity-action="control"]');
    if (ctrl && ctrl.tagName !== 'INPUT' && ctrl.tagName !== 'SELECT') {
        _controlFromEl(ctrl, event);
        return;
    }

    const openCard = event.target.closest('[data-entity-action="openCard"]');
    if (openCard) {
        const encoded = openCard.dataset.intEncoded || '';
        if (encoded && typeof window.__openIntegrationEntityCard === 'function') {
            window.__openIntegrationEntityCard(encoded);
        }
        return;
    }

    const openDevice = event.target.closest('[data-entity-action="openDeviceCard"]');
    if (openDevice) {
        const encoded = openDevice.dataset.intEncoded || '';
        const slug = openDevice.dataset.intSlug || '';
        if (encoded && typeof window.__openIntegrationDeviceCard === 'function') {
            window.__openIntegrationDeviceCard(encoded, slug);
        }
        return;
    }

    const openDeviceModal = event.target.closest('[data-entity-action="openDeviceModal"]');
    if (openDeviceModal) {
        const idx = Number(openDeviceModal.dataset.intIndex);
        const slug = openDeviceModal.dataset.intSlug || '';
        if (Number.isFinite(idx) && typeof window.__openIntegrationDeviceModal === 'function') {
            window.__openIntegrationDeviceModal(idx, slug);
        }
        return;
    }

    const rename = event.target.closest('[data-entity-action="renameDevice"]');
    if (rename) {
        event.stopPropagation();
        if (typeof window.__renameIntegrationDevice !== 'function') return;
        window.__renameIntegrationDevice(
            rename.dataset.intSlug || '',
            rename.dataset.intDeviceId || '',
            rename.dataset.intDeviceName || '',
        );
    }
}

function _onChange(event) {
    const el = event.target.closest('[data-entity-action="control"]');
    if (!el) return;
    _controlFromEl(el, event);
}

function _onInput(event) {
    const el = event.target.closest('[data-int-input-preview]');
    if (!el) return;
    event.stopPropagation();
    const entityId = el.dataset.intEntityId || '';
    const unit = el.dataset.intUnit || '';
    if (typeof window.__previewIntegrationNumberValue === 'function') {
        window.__previewIntegrationNumberValue(entityId, el.value, unit);
    }
}

export function initIntegrationEventBindings() {
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
    document.addEventListener('change', _onChange, false);
    document.addEventListener('input', _onInput, false);
}
