/**
 * Unified entity detail modal — Integrations + Devices + Smart home.
 */
import { pauseBackgroundCameraStreams, pauseEntityDetailCameraStreams, resumeBackgroundCameraStreams, startCameraPreviewRefresh, stopCameraPreviewRefresh, } from './camera_auth.js';
import { integrationIdForSourceSlug } from './integrations/catalog_meta.js';
import { getDomainIcon, renderEntityModal, renderEntityFriendlyNameSection, wireEntityRegistryEditor, wireEntityFriendlyNameEditor, entityDisplayName } from './entity_renderers.js';
export function resolveEntityControlSlug(entity) {
    const source = String(entity.source || '').trim();
    if (!source || source === 'derived')
        return '';
    return integrationIdForSourceSlug(source) || source;
}
export function openEntityDetailModal(entity, options = {}) {
    const modal = document.getElementById('entity-detail-modal');
    const iconEl = document.getElementById('entity-detail-modal-icon');
    const labelEl = document.getElementById('entity-detail-modal-label');
    const body = document.getElementById('entity-detail-modal-body');
    if (!modal || !body || !entity)
        return;
    stopCameraPreviewRefresh();
    pauseBackgroundCameraStreams(modal);
    pauseEntityDetailCameraStreams(modal);
    const slug = options.slug || resolveEntityControlSlug(entity);
    const dom = String(entity.domain || String(entity.entity_id || '').split('.')[0] || '').toLowerCase();
    const attrs = (entity.attributes || {});
    const caps = (attrs.capabilities || {});
    const dc = String(caps.device_class || attrs.device_class || '');
    const icon = getDomainIcon(dom, dc);
    if (iconEl)
        iconEl.className = `fas ${icon}`;
    if (labelEl)
        labelEl.textContent = entityDisplayName(entity) || String(entity.entity_id || 'Entity');
    body.innerHTML = renderEntityFriendlyNameSection(entity) + renderEntityModal(entity, slug);
    wireEntityFriendlyNameEditor(body, entity, {
        onUpdated: ({ name }) => {
            entity.name = name;
            if (labelEl)
                labelEl.textContent = name;
        },
    });
    wireEntityRegistryEditor(body, entity, {
        onUpdated: ({ oldEntityId, newEntityId, uniqueId }) => {
            if (entity.entity_id === oldEntityId)
                entity.entity_id = newEntityId;
            options.onRegistryUpdated?.({ oldEntityId, newEntityId, uniqueId });
            openEntityDetailModal(entity, options);
        },
    });
    if (modal.parentNode !== document.body)
        document.body.appendChild(modal);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    startCameraPreviewRefresh();
}
export function closeEntityDetailModal() {
    const modal = document.getElementById('entity-detail-modal');
    stopCameraPreviewRefresh();
    pauseEntityDetailCameraStreams(modal);
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    resumeBackgroundCameraStreams(modal);
}
