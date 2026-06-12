/**
 * Smart home — entity detail modal (row actions, camera preview, device control).
 */
import { apiCall } from '../api.js';
import { cameraProxyUrlSync, startCameraPreviewRefresh, stopCameraPreviewRefresh } from '../camera_auth.js';
import { cameraLoaderMarkup, bindCameraPreviewLoaders } from '../camera_loader.js';
import { t, tState, translateApiDetail } from '../lang/index.js';
import { escapeHtml, escapeHtmlAttr, showToast } from '../utils.js';
import { cameraPreferWebmPlayer } from '../camera_live.js';
import { renderEntityRegistrySection, wireEntityRegistryEditor } from '../entity_renderers.js';
import * as dev from './devices.js';
import { smarthomeDeviceState, smarthomeModalState } from './device_state.js';
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
    const modal = document.getElementById('entity-detail-modal');
    const iconEl = document.getElementById('entity-detail-modal-icon');
    const labelEl = document.getElementById('entity-detail-modal-label');
    const body = document.getElementById('entity-detail-modal-body');
    let entity = smarthomeDeviceState.integrationEntitiesCache?.find(candidate => candidate.entity_id === entityId) || smarthomeDeviceState.devicesVisibleEntityCache.get(entityId);
    if (!modal || !body)
        return;
    if (!entity) {
        try {
            await dev.loadSmarthome();
        }
        catch (_) { }
        entity = smarthomeDeviceState.integrationEntitiesCache?.find(candidate => candidate.entity_id === entityId) || smarthomeDeviceState.devicesVisibleEntityCache.get(entityId);
    }
    if (!entity) {
        showToast(t('hy.entity_not_found_sync'), 'error');
        return;
    }
    smarthomeModalState.haRowActionsEntityId = entityId;
    stopCameraPreviewRefresh();
    const domain = dev._entityDomain(entity);
    const stateLower = dev._norm(entity.state);
    const rawState = entity.state ?? 'unknown';
    const stateDisplay = `${tState(rawState)}${entity.unit ? ' ' + entity.unit : ''}`;
    const iconClass = dev._iconClass(entity.icon) || `fas ${dev.DOMAIN_ICONS[domain] || 'fa-microchip'}`;
    const sourceMeta = dev.SOURCE_ICONS[entity.source ?? ''] || { icon: 'fa-puzzle-piece', label: entity.source || 'Unknown', color: 'text-slate-400' };
    const attrs = entity.attributes && typeof entity.attributes === 'object' ? entity.attributes : {};
    const cameraPreview = _cameraPreviewMarkup(entity, attrs);
    const attrsRows = Object.entries(attrs).slice(0, 24).map(([key, value]) => `
        <div class="hy-detail-attr">
            <span>${escapeHtml(key)}</span>
            <strong>${escapeHtml(typeof value === 'object' ? JSON.stringify(value) : String(value))}</strong>
        </div>`).join('');
    if (iconEl)
        iconEl.className = iconClass;
    if (labelEl)
        labelEl.textContent = entity.name || entity.entity_id || t('integrations.device');
    body.innerHTML = `
        <div class="hy-detail-hero">
            <div class="hy-detail-icon ${dev.DOMAIN_COLORS[domain] || 'bg-slate-500/15 text-slate-400'}"><i class="${iconClass}"></i></div>
            <div class="hy-detail-titlebox">
                <div class="hy-detail-kicker"><i class="fas ${sourceMeta.icon}"></i>${escapeHtml(sourceMeta.label || entity.source || 'Unknown')}</div>
                <h3>${escapeHtml(entity.name || entity.entity_id)}</h3>
            </div>
        </div>
        ${renderEntityRegistrySection(entity)}
        <div class="hy-detail-status-row">
            <div class="hy-detail-status ${['unavailable', 'unknown', 'offline'].includes(stateLower) ? 'is-offline' : dev._isActiveState(stateLower) ? 'is-active' : ''}">
                <span>${escapeHtml(t('hy.detail_state'))}</span>
                <strong>${escapeHtml(stateDisplay)}</strong>
            </div>
            <div class="hy-detail-status">
                <span>${escapeHtml(t('hy.detail_domain'))}</span>
                <strong>${escapeHtml(dev._domainLabel(domain))}</strong>
            </div>
        </div>
        ${cameraPreview}
        ${_deviceLightControls(entity)}
        <div class="hy-detail-actions">
            ${_deviceControlButtons(entity)}
            <button type="button" class="hy-detail-btn" data-smarthome-action="copyEntityIdFromRowActions"><i class="fas fa-copy"></i><span>${escapeHtml(t('hy.copy_id_short'))}</span></button>
            <button type="button" class="hy-detail-btn" data-smarthome-action="openAliasModalFromDetail" data-smarthome-entity-id="${escapeHtmlAttr(entityId)}"><i class="fas fa-tag"></i><span>${escapeHtml(t('hy.col_alias'))}</span></button>
            ${entity.source === 'derived' ? '' : `<label class="hy-detail-toggle"><span><i class="fas fa-robot"></i>${escapeHtml(t('hy.row_action_ai'))}</span><input type="checkbox" data-smarthome-change="toggleSelection" data-smarthome-entity-id="${escapeHtmlAttr(entityId)}" ${entity.selected ? 'checked' : ''}></label>`}
        </div>
        <div class="hy-detail-section">
            <div class="hy-detail-section-title">${escapeHtml(t('hy.detail_attributes'))}</div>
            <div class="hy-detail-attrs">${attrsRows || `<div class="hy-detail-empty">${escapeHtml(t('hy.detail_no_attributes'))}</div>`}</div>
        </div>`;
    if (modal.parentNode !== document.body)
        document.body.appendChild(modal);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    wireEntityRegistryEditor(body, entity, {
        onUpdated: ({ oldEntityId, newEntityId, uniqueId }) => {
            const idx = smarthomeDeviceState.integrationEntitiesCache.findIndex((e) => e.entity_id === oldEntityId || (uniqueId && e.unique_id === uniqueId));
            if (idx >= 0) {
                smarthomeDeviceState.integrationEntitiesCache[idx].entity_id = newEntityId;
                smarthomeDeviceState.devicesVisibleEntityCache.delete(oldEntityId);
                smarthomeDeviceState.devicesVisibleEntityCache.set(newEntityId, smarthomeDeviceState.integrationEntitiesCache[idx]);
            }
            smarthomeModalState.haRowActionsEntityId = newEntityId;
            openRowActionsModal(newEntityId);
        },
    });
    startCameraPreviewRefresh();
    bindCameraPreviewLoaders(body);
    _wireCameraPreviewMute();
}
function _wireCameraPreviewMute() {
    const wrap = document.querySelector('#entity-detail-modal .hy-detail-camera');
    const video = wrap?.querySelector('video[data-camera-live-webm]');
    const btn = wrap?.querySelector('[data-camera-mute-toggle]');
    if (!video || !btn)
        return;
    btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        video.muted = !video.muted;
        btn.textContent = video.muted ? '🔇' : '🔊';
    });
}
function _cameraPreviewMarkup(entity, attrs) {
    const domain = dev._entityDomain(entity);
    if (domain === 'image')
        return _imagePreviewMarkup(entity, attrs);
    if (domain !== 'camera')
        return '';
    const hasAudio = !!(attrs.has_audio);
    const playUrl = cameraPreferWebmPlayer(attrs) ? _cameraProxyUrl(entity.entity_id, 'play') : '';
    if (playUrl) {
        const muted = !hasAudio;
        return `<div class="hy-detail-camera relative" data-camera-preview-shell>
            ${cameraLoaderMarkup()}
            <video src="${escapeHtmlAttr(playUrl)}" ${muted ? 'muted' : ''} autoplay playsinline controls data-camera-live-webm class="hy-camera-preview-media"></video>
            <button type="button" data-camera-mute-toggle class="absolute left-2 bottom-2 z-10 px-2 py-1 rounded-lg bg-black/60 text-white text-sm border-0 cursor-pointer" title="${escapeHtmlAttr(t('entity.render.sound'))}">${muted ? '🔇' : '🔊'}</button>
        </div>`;
    }
    const mjpeg = String(attrs.mjpeg_url || '').trim();
    const proxyMode = (mjpeg.startsWith('http://') || mjpeg.startsWith('https://')) ? 'stream' : 'snapshot';
    const imageUrl = _cameraProxyUrl(entity.entity_id, proxyMode);
    const videoUrl = attrs.stream_url || attrs.preview_url || '';
    if (imageUrl) {
        const shouldRefresh = proxyMode === 'snapshot';
        return `<div class="hy-detail-camera" data-camera-preview-shell>
            ${cameraLoaderMarkup()}
            <img src="${escapeHtmlAttr(_cacheBustCameraUrl(imageUrl))}" data-camera-src="${escapeHtmlAttr(imageUrl)}" data-camera-refresh="${shouldRefresh ? 'true' : 'false'}" alt="${escapeHtmlAttr(entity.name || entity.entity_id || 'Camera')}" loading="eager" class="hy-camera-preview-media">
        </div>`;
    }
    if (videoUrl) {
        return `<div class="hy-detail-camera" data-camera-preview-shell>
            ${cameraLoaderMarkup()}
            <video src="${escapeHtmlAttr(videoUrl)}" autoplay muted playsinline controls class="hy-camera-preview-media"></video>
        </div>`;
    }
    return '';
}
function _imagePreviewMarkup(entity, attrs) {
    const hasImage = attrs.image_url || attrs.snapshot_url || attrs.entity_picture || attrs.url
        || /^https?:\/\//.test(String(entity.state || ''));
    if (!hasImage)
        return '';
    const proxyUrl = _imageProxyUrl(entity.entity_id);
    if (!proxyUrl)
        return '';
    return `<div class="hy-detail-camera" data-camera-preview-shell>
        ${cameraLoaderMarkup()}
        <img src="${escapeHtmlAttr(_cacheBustCameraUrl(proxyUrl))}" data-camera-src="${escapeHtmlAttr(proxyUrl)}" data-camera-refresh="true" alt="${escapeHtmlAttr(entity.name || entity.entity_id || 'Image')}" loading="eager" class="hy-camera-preview-media">
    </div>`;
}
function _imageProxyUrl(entityId) {
    if (!entityId)
        return '';
    return cameraProxyUrlSync(entityId, 'image');
}
function _cameraProxyUrl(entityId, mode = 'snapshot') {
    if (!entityId)
        return '';
    const paths = { stream: 'stream', play: 'play', snapshot: 'snapshot' };
    const path = paths[mode] || 'snapshot';
    return cameraProxyUrlSync(entityId, path);
}
function _cacheBustCameraUrl(url) {
    const raw = String(url || '');
    if (!raw)
        return '';
    return `${raw}${raw.includes('?') ? '&' : '?'}_hyve=${Date.now()}`;
}
function _lightCaps(entity) {
    const attrs = (entity.attributes && typeof entity.attributes === 'object' ? entity.attributes : {});
    const caps = (attrs.capabilities && typeof attrs.capabilities === 'object' ? attrs.capabilities : {});
    return { attrs, caps };
}
function _lightBrightnessScale(caps) {
    if (caps.brightness_scale != null)
        return Number(caps.brightness_scale) || 254;
    const brRange = caps.brightness_range;
    if (Array.isArray(brRange) && brRange.length >= 2)
        return Number(brRange[1]) || 254;
    return 254;
}
function _lightBrightnessValue(entity, scale) {
    const { attrs } = _lightCaps(entity);
    const raw = Number(attrs.brightness);
    if (Number.isFinite(raw))
        return Math.max(0, Math.min(scale, raw));
    const on = dev._isActiveState(dev._norm(entity.state)) || dev._norm(entity.state) === 'on';
    return on ? scale : 0;
}
function _rgbToHex(attrs) {
    const color = attrs.color;
    if (color && typeof color === 'object') {
        const c = color;
        if (Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b)) {
            const part = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
            return `#${part(c.r)}${part(c.g)}${part(c.b)}`;
        }
    }
    return '#ffffff';
}
function _deviceLightControls(entity) {
    if (!entity || dev._entityDomain(entity) !== 'light')
        return '';
    const { attrs, caps } = _lightCaps(entity);
    const entityId = escapeHtmlAttr(entity.entity_id || '');
    const source = escapeHtmlAttr(entity.source || '');
    const _er = (key) => t('entity.render.' + key);
    const hasBrightness = !!(caps.brightness || caps.brightness_command_topic || caps.brightness_range);
    const hasColor = !!caps.color;
    const hasColorTemp = !!caps.color_temp;
    if (!hasBrightness && !hasColor && !hasColorTemp)
        return '';
    const scale = _lightBrightnessScale(caps);
    const brightness = _lightBrightnessValue(entity, scale);
    const pct = Math.round((brightness / scale) * 100);
    const ctRange = Array.isArray(caps.color_temp_range) ? caps.color_temp_range : [153, 500];
    const ctMin = Number(ctRange[0]) || 153;
    const ctMax = Number(ctRange[1]) || 500;
    const ctVal = Number(attrs.color_temp);
    const colorTemp = Number.isFinite(ctVal) ? Math.max(ctMin, Math.min(ctMax, ctVal)) : Math.round((ctMin + ctMax) / 2);
    const colorHex = _rgbToHex(attrs);
    const ctrlAttrs = (kind, extra = '') => `data-smarthome-light-input="${kind}" data-smarthome-source="${source}" data-smarthome-entity-id="${entityId}"${extra}`;
    let body = '<div class="hy-detail-light-controls">';
    if (hasBrightness) {
        body += `
        <div class="hy-detail-light-row">
            <div class="hy-detail-light-label">
                <span>${escapeHtml(_er('brightness'))}</span>
                <strong data-smarthome-light-brightness-label="${entityId}">${pct}%</strong>
            </div>
            <input type="range" min="0" max="100" step="1" value="${pct}" class="cfg-range w-full"
                ${ctrlAttrs('brightness', ` data-smarthome-light-scale="${scale}"`)}>
        </div>`;
    }
    if (hasColor) {
        body += `
        <div class="hy-detail-light-row">
            <div class="hy-detail-light-label">
                <span>${escapeHtml(_er('color'))}</span>
            </div>
            <input type="color" value="${escapeHtmlAttr(colorHex)}" class="hy-detail-color-input"
                ${ctrlAttrs('color')}>
        </div>`;
    }
    if (hasColorTemp) {
        body += `
        <div class="hy-detail-light-row">
            <div class="hy-detail-light-label">
                <span>${escapeHtml(_er('color_temp'))}</span>
                <strong>${colorTemp}</strong>
            </div>
            <input type="range" min="${ctMin}" max="${ctMax}" step="1" value="${colorTemp}" class="cfg-range w-full"
                ${ctrlAttrs('color_temp')}>
        </div>`;
    }
    body += '</div>';
    return body;
}
function _deviceControlButtons(entity) {
    if (!entity || entity.source === 'derived')
        return '';
    const entityId = escapeHtmlAttr(entity.entity_id || '');
    const source = escapeHtmlAttr(entity.source || '');
    const domain = dev._entityDomain(entity);
    const stateLower = dev._norm(entity.state);
    const isActive = dev._isActiveState(stateLower) || stateLower === 'on';
    const pending = smarthomeDeviceState.deviceControlPending.has(entity.entity_id || '');
    const _er = (key) => t('entity.render.' + key);
    const button = (action, icon, label, tone = '') => {
        const busyIcon = pending ? 'fa-circle-notch fa-spin' : icon;
        const busyLabel = pending ? t('integrations.applying') : label;
        return `<button type="button" class="hy-detail-btn ${tone}${pending ? ' is-pending' : ''}" ${pending ? 'aria-busy="true" data-pending="true"' : ''} data-smarthome-action="controlDevice" data-smarthome-source="${source}" data-smarthome-entity-id="${entityId}" data-smarthome-device-action="${action}"><i class="fas ${busyIcon}"></i><span>${busyLabel}</span></button>`;
    };
    if (['light', 'switch', 'input_boolean', 'fan'].includes(domain)) {
        return button(isActive ? 'turn_off' : 'turn_on', 'fa-power-off', isActive ? _er('turn_off') : _er('turn_on'), isActive ? 'is-danger' : 'is-primary');
    }
    if (domain === 'cover') {
        return [button('open_cover', 'fa-arrow-up', _er('up')), button('stop_cover', 'fa-stop', _er('stop')), button('close_cover', 'fa-arrow-down', _er('down'))].join('');
    }
    if (domain === 'lock') {
        return button(isActive ? 'lock' : 'unlock', isActive ? 'fa-lock' : 'fa-unlock', isActive ? _er('lock_action') : _er('unlock_action'), isActive ? '' : 'is-primary');
    }
    if (domain === 'button' || domain === 'script') {
        return button('press', 'fa-play', _er('send'), 'is-primary');
    }
    if (domain === 'vacuum') {
        return [
            button('start', 'fa-play', _er('vacuum_start'), 'is-primary'),
            button('stop', 'fa-stop', _er('stop')),
            button('return_to_base', 'fa-house', _er('vacuum_dock')),
            button('locate', 'fa-location-crosshairs', _er('vacuum_locate')),
        ].join('');
    }
    if (domain === 'lawn_mower') {
        return [
            button('start', 'fa-play', _er('lawn_mower_start'), 'is-primary'),
            button('pause', 'fa-pause', _er('lawn_mower_pause')),
            button('stop', 'fa-stop', _er('stop')),
            button('return_to_base', 'fa-house', _er('lawn_mower_dock')),
        ].join('');
    }
    if (domain === 'media_player') {
        return [button('media_play', 'fa-play', _er('media_play')), button('media_pause', 'fa-pause', _er('media_pause'))].join('');
    }
    if (entity.controllable) {
        return button('toggle', 'fa-sliders', _er('toggle'), 'is-primary');
    }
    return `<div class="hy-detail-empty">${escapeHtml(_er('read_only'))}</div>`;
}
export async function controlDeviceEntity(source, entityId, action, buttonEl = null, data = {}) {
    const entity = smarthomeDeviceState.integrationEntitiesCache?.find(candidate => candidate.entity_id === entityId);
    if (!entity || !source || source === 'derived')
        return;
    if (smarthomeDeviceState.deviceControlPending.has(entityId))
        return;
    const previousState = entity.state;
    const optimisticState = dev._optimisticStateForAction(action, previousState, String(entity.domain || ''));
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
    dev.renderDeviceCards();
    dev._markDeviceControlPending(entityId, true);
    if (smarthomeModalState.haRowActionsEntityId === entityId)
        await openRowActionsModal(entityId);
    try {
        const response = await apiCall(`/api/integrations/${encodeURIComponent(source)}/control`, {
            method: 'POST',
            body: { entity_id: entityId, action, data: data || {} },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(translateApiDetail(payload.detail) || String(payload.message || '') || t('integrations.action_failed'));
        }
        smarthomeDeviceState.deviceOptimisticGuards.set(entityId, { state: optimisticState, until: Date.now() + dev.DEVICE_OPTIMISTIC_GUARD_MS });
        showToast(t('hy.command_sent'), 'success');
    }
    catch (error) {
        smarthomeDeviceState.deviceOptimisticGuards.delete(entityId);
        entity.state = previousState;
        dev.renderDeviceCards();
        showToast(dev._errMsg(error) || t('hy.control_error'), 'error');
    }
    finally {
        smarthomeDeviceState.deviceControlPending.delete(entityId);
        dev._markDeviceControlPending(entityId, false);
        if (smarthomeModalState.haRowActionsEntityId === entityId)
            openRowActionsModal(entityId);
    }
}
export function openAliasModalFromDetail(entityId) {
    closeEntityDetailModal();
    openAliasModal(entityId);
}
export function closeEntityDetailModal() {
    const modal = document.getElementById('entity-detail-modal');
    stopCameraPreviewRefresh();
    if (modal) {
        modal.querySelectorAll('hv-camera-stream').forEach(el => {
            try {
                el.pauseStream?.();
            }
            catch (_) { }
        });
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
    smarthomeModalState.haRowActionsEntityId = null;
}
export function closeRowActionsModal() {
    closeEntityDetailModal();
}
