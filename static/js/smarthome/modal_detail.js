/**
 * Smart home — entity detail page + device control.
 */
import { apiCall } from '../api.js';
import { t, translateApiDetail } from '../lang/index.js';
import { showToast } from '../utils.js';
import { closeEntityDetailModal as _closeEntityDetailModal } from '../entity_detail_modal.js';
import { openEntityDetail, closeEntityDetail, loadSmarthome, renderDeviceCards, _markDeviceControlPending, _optimisticStateForAction, _syncEntityToggleDom, patchOpenDetailForEntity, _errMsg, } from './device_core.js';
import { smarthomeDeviceState, smarthomeModalState, DEVICE_OPTIMISTIC_GUARD_MS } from './device_state.js';
import { openAliasModal } from './modal_alias.js';
export function handleHaRowClick(event) {
    const row = event.currentTarget;
    if (!row || row.getAttribute('data-entity') == null)
        return;
    const tgt = event.target;
    if (tgt?.closest('button, input, a, label'))
        return;
    const eid = row.getAttribute('data-entity');
    if (eid)
        openRowActionsModal(eid);
}
export async function openRowActionsModal(entityId) {
    let entity = smarthomeDeviceState.integrationEntitiesCache?.find(candidate => candidate.entity_id === entityId)
        || smarthomeDeviceState.devicesVisibleEntityCache.get(entityId);
    if (!entity) {
        try {
            await loadSmarthome();
        }
        catch (_) { }
        entity = smarthomeDeviceState.integrationEntitiesCache?.find(candidate => candidate.entity_id === entityId)
            || smarthomeDeviceState.devicesVisibleEntityCache.get(entityId);
    }
    if (!entity) {
        showToast(t('hy.entity_not_found_sync'), 'error');
        return;
    }
    openEntityDetail(entityId);
}
export async function controlDeviceEntity(source, entityId, action, buttonEl = null, data = {}) {
    const entity = smarthomeDeviceState.integrationEntitiesCache?.find(candidate => candidate.entity_id === entityId);
    if (!entity || !source || source === 'derived')
        return;
    if (smarthomeDeviceState.deviceControlPending.has(entityId))
        return;
    const previousState = entity.state;
    const optimisticState = _optimisticStateForAction(action, previousState, String(entity.domain || ''));
    smarthomeDeviceState.deviceControlPending.set(entityId, { action, previousState, optimisticState, startedAt: Date.now() });
    if (buttonEl) {
        buttonEl.classList.add('is-pending');
        buttonEl.setAttribute('aria-busy', 'true');
        const icon = buttonEl.querySelector('i');
        const label = buttonEl.querySelector('span');
        if (icon)
            icon.className = 'fas fa-circle-notch fa-spin';
        if (label)
            label.textContent = t('integrations.applying');
    }
    entity.state = optimisticState;
    if (!patchOpenDetailForEntity(entity)) {
        renderDeviceCards();
    }
    _markDeviceControlPending(entityId, true);
    try {
        const response = await apiCall(`/api/integrations/${encodeURIComponent(source)}/control`, {
            method: 'POST',
            body: { entity_id: entityId, action, data: data || {} },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(translateApiDetail(payload.detail) || String(payload.message || '') || t('integrations.action_failed'));
        }
        smarthomeDeviceState.deviceOptimisticGuards.set(entityId, { state: optimisticState, until: Date.now() + DEVICE_OPTIMISTIC_GUARD_MS });
    }
    catch (error) {
        smarthomeDeviceState.deviceOptimisticGuards.delete(entityId);
        entity.state = previousState;
        if (!patchOpenDetailForEntity(entity)) {
            renderDeviceCards();
        }
        showToast(_errMsg(error) || t('hy.control_error'), 'error');
    }
    finally {
        smarthomeDeviceState.deviceControlPending.delete(entityId);
        _markDeviceControlPending(entityId, false);
        if (entity)
            _syncEntityToggleDom(entity);
    }
}
export function openAliasModalFromDetail(entityId) {
    _closeEntityDetailModal();
    openAliasModal(entityId);
}
export function closeEntityDetailModal() {
    _closeEntityDetailModal();
    smarthomeModalState.haRowActionsEntityId = null;
}
export function closeRowActionsModal() {
    closeEntityDetail();
    closeEntityDetailModal();
}
