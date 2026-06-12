/**
 * Modern Devices UI markup — entity list + full-page detail (mockup style).
 */
import { getDomainIcon } from './entity_renderers.js';
import { CONTROLLABLE, entityStateForDisplay } from './entity_constants.js';
import { isActiveState } from './integrations/utils.js';
import { resolveLightControlFlags } from './light_controls.js';
import { t, tState } from './lang/index.js';
import { escapeHtml, escapeHtmlAttr } from './utils.js';
import { appendMediaQueryToken } from './camera_auth.js';
import { deviceHasActiveEntity, primaryDeviceEntity, sortDeviceEntities, canRenameIntegrationDevice, } from './devices_group.js';
import { primaryEntityCandidates } from './device_primary_entity.js';
const DOMAIN_GLOW = {
    light: 'hyd-glow--light',
    switch: 'hyd-glow--switch',
    climate: 'hyd-glow--climate',
    fan: 'hyd-glow--climate',
    camera: 'hyd-glow--camera',
    sensor: 'hyd-glow--sensor',
    binary_sensor: 'hyd-glow--sensor',
    cover: 'hyd-glow--cover',
    lock: 'hyd-glow--lock',
    vacuum: 'hyd-glow--vacuum',
    media_player: 'hyd-glow--media',
    derived: 'hyd-glow--derived',
};
const DOMAIN_ICONS = {
    light: 'fa-lightbulb', switch: 'fa-toggle-on', cover: 'fa-door-open', lock: 'fa-lock',
    sensor: 'fa-gauge', binary_sensor: 'fa-circle-dot', climate: 'fa-temperature-half',
    media_player: 'fa-music', vacuum: 'fa-robot', camera: 'fa-video', derived: 'fa-calculator',
};
function _domain(entity) {
    return String(entity.domain || String(entity.entity_id || '').split('.')[0] || '').toLowerCase();
}
function _norm(v) {
    return String(v ?? '').trim().toLowerCase();
}
function _iconClass(spec) {
    const raw = String(spec || '').trim();
    if (!raw)
        return '';
    if (raw.startsWith('mdi:'))
        return `mdi mdi-${raw.slice(4)}`;
    if (/\bfa[srlbd]?\b/.test(raw))
        return raw;
    if (raw.startsWith('fa-'))
        return `fas ${raw}`;
    return raw;
}
function _entityIsActive(entity) {
    const lower = _norm(entity.state);
    return isActiveState(lower) || lower === 'on' || lower === 'true';
}
function _entityIsUnavailable(entity) {
    const lower = _norm(entity.state);
    return ['unavailable', 'unknown', 'offline'].includes(lower);
}
function _entityIcon(entity, active = true) {
    const custom = _iconClass(entity.icon);
    if (custom)
        return custom;
    const dom = _domain(entity);
    if (dom === 'switch' || dom === 'input_boolean') {
        return active ? 'fas fa-toggle-on' : 'fas fa-toggle-off';
    }
    if (dom === 'light') {
        return active ? 'fas fa-lightbulb' : 'far fa-lightbulb';
    }
    return `fas ${DOMAIN_ICONS[dom] || 'fa-microchip'}`;
}
function _stateReadout(entity) {
    const dom = _domain(entity);
    const lower = _norm(entity.state);
    if (['unavailable', 'unknown', 'offline'].includes(lower))
        return tState('unavailable');
    if (dom === 'light') {
        const flags = resolveLightControlFlags(entity, isActiveState(lower) || lower === 'on');
        if (flags.hasBrightness) {
            const pct = Math.round((flags.brightnessValue / flags.brightnessScale) * 100);
            return `${pct}%`;
        }
    }
    const state = entityStateForDisplay(dom, entity.state, tState);
    return `${state}${entity.unit ? ` ${entity.unit}` : ''}`;
}
function _readoutValueClass(text) {
    const len = String(text || '').trim().length;
    const base = 'hyd-hero-readout__value';
    if (len >= 14)
        return `${base} ${base}--tight`;
    if (len >= 9)
        return `${base} ${base}--compact`;
    return base;
}
function _syncReadoutValueEl(el, text) {
    if (!(el instanceof HTMLElement))
        return;
    el.className = _readoutValueClass(text);
    el.textContent = text;
}
function _readoutValueMarkup(text) {
    const raw = String(text || '');
    return `<strong class="${_readoutValueClass(raw)}">${escapeHtml(raw)}</strong>`;
}
function _entityCanToggle(entity) {
    const source = String(entity.source || '').trim();
    if (!source || source === 'derived')
        return false;
    const dom = _domain(entity);
    const eid = String(entity.entity_id || '');
    if (!eid || entity.controllable === false)
        return false;
    if (!CONTROLLABLE.includes(dom))
        return false;
    return ['switch', 'light', 'input_boolean', 'fan', 'outlet', 'plug'].includes(dom);
}
function _entityDisplayName(entity) {
    return String(entity.name || entity.entity_id || '').trim();
}
function _statusControlMarkup(primary) {
    if (!primary || !_entityCanToggle(primary))
        return '';
    const source = String(primary.source || '').trim();
    const isOn = _entityIsActive(primary);
    const action = isOn ? 'turn_off' : 'turn_on';
    const eid = String(primary.entity_id || '');
    return ` data-smarthome-action="controlDevice" data-smarthome-stop-propagation="true" data-smarthome-source="${escapeHtmlAttr(source)}" data-smarthome-entity-id="${escapeHtmlAttr(eid)}" data-smarthome-device-action="${action}" data-entity-toggle="${escapeHtmlAttr(eid)}" data-on="${isOn ? 'true' : 'false'}"`;
}
function _renderEntitiesInfoRow(entityCount) {
    return `<div class="hyd-info-row"><dt>${escapeHtml(t('hy.detail_entities'))}</dt><dd>${escapeHtml(String(entityCount))}</dd></div>`;
}
function _entityIconHtml(entity, size = 'list') {
    const dom = _domain(entity);
    const isActive = _entityIsActive(entity);
    const isUnavail = _entityIsUnavailable(entity);
    const attrs = (entity.attributes || {});
    const caps = (attrs.capabilities || {});
    const dc = String(caps.device_class || attrs.device_class || '');
    const icon = getDomainIcon(dom, dc);
    const glow = DOMAIN_GLOW[dom] || DOMAIN_GLOW.derived || 'hyd-glow--default';
    const iconClass = _entityIcon(entity, isActive && !isUnavail) || `fas ${icon}`;
    const sizeClass = size === 'hero' ? 'hyd-icon hyd-icon--hero' : 'hyd-icon hyd-icon--list';
    const tone = isUnavail ? ' is-offline' : ((!isActive && ['switch', 'light', 'input_boolean', 'fan', 'outlet', 'plug'].includes(dom)) ? ' is-inactive' : '');
    return `<span class="${sizeClass} ${glow}${tone}"><i class="${iconClass}" aria-hidden="true"></i></span>`;
}
function _lightAttr(entityId, source, kind, extra = '') {
    return `data-smarthome-light-input="${kind}" data-smarthome-source="${escapeHtmlAttr(source)}" data-smarthome-entity-id="${escapeHtmlAttr(entityId)}"${extra}`;
}
export function entityMatchesCategory(entity, category) {
    const cat = String(category || 'all').toLowerCase();
    if (cat === 'all')
        return true;
    const dom = _domain(entity);
    if (cat === 'light' || cat === 'lights')
        return dom === 'light';
    if (cat === 'climate')
        return ['climate', 'water_heater', 'fan'].includes(dom);
    if (cat === 'sensor' || cat === 'sensors')
        return dom === 'sensor' || dom === 'binary_sensor';
    if (cat === 'switch' || cat === 'switches')
        return ['switch', 'input_boolean', 'outlet', 'plug'].includes(dom);
    if (cat === 'camera' || cat === 'cameras')
        return dom === 'camera';
    if (cat === 'other' || cat === 'others') {
        const known = new Set(['light', 'climate', 'water_heater', 'fan', 'sensor', 'binary_sensor', 'switch', 'input_boolean', 'outlet', 'plug', 'camera']);
        return !known.has(dom);
    }
    return dom === cat;
}
export function renderEntityCategoryTabs(active) {
    const tabs = [
        { id: 'all', label: t('hy.filter_all') },
        { id: 'light', label: t('hy.filter_lights') },
        { id: 'climate', label: t('hy.filter_climate') },
        { id: 'sensor', label: t('hy.filter_sensors') },
        { id: 'switch', label: t('hy.filter_switches') },
        { id: 'camera', label: t('hy.domains.camera') },
        { id: 'other', label: t('hy.device_cat_other') },
    ];
    return tabs.map((tab) => {
        const on = tab.id === active ? ' is-active' : '';
        return `<button type="button" class="hyd-chip${on}" data-smarthome-action="filterEntityCategory" data-smarthome-category="${escapeHtmlAttr(tab.id)}">${escapeHtml(tab.label)}</button>`;
    }).join('');
}
function _deviceSummaryReadout(device) {
    const primary = primaryDeviceEntity(device);
    if (primary)
        return _stateReadout(primary);
    const ents = device.entities || [];
    const on = ents.filter((e) => {
        const s = String(e.state || '').toLowerCase();
        return isActiveState(s) || s === 'on';
    }).length;
    if (on)
        return `${on}/${ents.length} ON`;
    return `${ents.length} ${t('hy.detail_entities')}`;
}
function _deviceIconHtml(device, size = 'list') {
    const primary = primaryDeviceEntity(device);
    if (primary)
        return _entityIconHtml(primary, size);
    const dom = device.primary_domain || 'device';
    const glow = DOMAIN_GLOW[dom] || 'hyd-glow--default';
    const sizeClass = size === 'hero' ? 'hyd-icon hyd-icon--hero' : 'hyd-icon hyd-icon--list';
    const icon = DOMAIN_ICONS[dom] || 'fa-microchip';
    const url = String(device.image_url || '').trim();
    if (url) {
        const src = escapeHtmlAttr(appendMediaQueryToken(url));
        return `<span class="${sizeClass} ${glow} hyd-icon--photo"><img src="${src}" alt="" loading="lazy" onerror="this.parentElement.classList.add('is-fallback')"><i class="fas ${icon}"></i></span>`;
    }
    return `<span class="${sizeClass} ${glow}"><i class="fas ${icon}" aria-hidden="true"></i></span>`;
}
function _listRowMetaHtml(entity, device) {
    const subject = entity || (device ? primaryDeviceEntity(device) : null);
    const readout = subject
        ? _stateReadout(subject)
        : (device ? _deviceSummaryReadout(device) : '');
    const showReadout = subject ? !_entityCanToggle(subject) : true;
    const readoutHtml = showReadout && readout
        ? `<span class="hyd-entity-row__state mono">${escapeHtml(readout)}</span>`
        : '';
    return `<div class="hyd-entity-row__meta">
        ${readoutHtml}
        <i class="fas fa-chevron-right hyd-entity-row__chev" aria-hidden="true"></i>
    </div>`;
}
function _editablePageTitleShell(viewDataAttr, viewInnerHtml, editPanelHtml) {
    return `<div class="hyd-editable-name hyd-editable-name--page-title">
        <div class="hyd-editable-name__view" ${viewDataAttr}>${viewInnerHtml}</div>
        ${editPanelHtml}
    </div>`;
}
function _editablePageTitleEditPanel(inputAttrs, saveAttrs, cancelAttrs, panelAttr, saveTitle, cancelTitle) {
    return `<div class="hyd-editable-name__edit-panel hidden" ${panelAttr}>
            <input type="text" class="hyd-editable-name__input" ${inputAttrs}>
            <button type="button" class="hyd-editable-name__btn hyd-editable-name__btn--save" ${saveAttrs} title="${escapeHtmlAttr(saveTitle)}">
                <i class="fas fa-check"></i>
            </button>
            <button type="button" class="hyd-editable-name__btn" ${cancelAttrs} title="${escapeHtmlAttr(cancelTitle)}">
                <i class="fas fa-times"></i>
            </button>
        </div>`;
}
export function renderDeviceListCard(device, _sourceIcons) {
    const primary = primaryDeviceEntity(device);
    const key = escapeHtmlAttr(device.device_key);
    const name = escapeHtml(device.name || device.device_id || t('hy.device_default'));
    const isUnavail = primary ? _entityIsUnavailable(primary) : false;
    const sub = primary
        ? escapeHtml(_domain(primary))
        : escapeHtml(String(device.primary_domain || device.entry_title || `${(device.entities || []).length} ${t('hy.detail_entities')}`));
    const iconHtml = _deviceIconHtml(device, 'list');
    const meta = _listRowMetaHtml(primary, device);
    return `<article class="hyd-entity-row${isUnavail ? ' is-offline' : ''}" data-device-key="${key}" data-smarthome-action="openDeviceDetail" role="listitem">
        ${iconHtml}
        <div class="hyd-entity-row__body">
            <div class="hyd-entity-row__name">${name}</div>
            <div class="hyd-entity-row__sub">${sub}</div>
        </div>
        ${meta}
    </article>`;
}
export function renderDeviceDetailPage(device, sourceIcons) {
    const primary = primaryDeviceEntity(device);
    const rawName = device.name || device.device_id || t('hy.device_default');
    const name = escapeHtml(rawName);
    const area = device.area ? escapeHtml(String(device.area)) : '';
    const srcMeta = sourceIcons[device.source_slug || ''] || null;
    const subtitle = [area, escapeHtml(srcMeta?.label || device.entry_title || '')].filter(Boolean).join(' · ');
    const ents = sortDeviceEntities(device);
    const entityRows = ents.map((e) => renderEntityListCard(e, sourceIcons, { nested: true })).join('');
    const canRename = canRenameIntegrationDevice(device);
    const renameBtn = canRename ? `<button type="button" class="hyd-editable-name__edit" data-device-name-edit title="${escapeHtmlAttr(t('hy.detail_friendly_name'))}"><i class="fas fa-pen"></i></button>` : '';
    const deviceTitleView = `<h1 class="hyd-editable-name__label" data-device-name-view>${name}</h1>${renameBtn}`;
    const deviceEditPanel = canRename
        ? _editablePageTitleEditPanel(`data-device-name-input value="${escapeHtmlAttr(rawName)}"`, 'data-device-name-save', 'data-device-name-cancel', 'data-device-name-edit-panel', t('common.save'), t('common.cancel'))
        : '';
    const deviceTitle = canRename
        ? _editablePageTitleShell('data-device-name-view-wrap', deviceTitleView, deviceEditPanel)
        : `<div class="hyd-editable-name hyd-editable-name--page-title"><div class="hyd-editable-name__view"><h1 class="hyd-editable-name__label">${name}</h1></div></div>`;
    const infoRows = [
        [t('hy.detail_manufacturer'), device.manufacturer || device.device_manufacturer || '—'],
        [t('hy.detail_model'), device.model || device.device_model || '—'],
        [t('hy.detail_source'), srcMeta?.label || device.entry_title || device.source_slug || '—'],
    ];
    const overview = _deviceOverviewCard(device, primary, sourceIcons, infoRows, ents.length);
    return `<div class="hyd-page" data-device-detail-key="${escapeHtmlAttr(device.device_key)}">
        <header class="hyd-page__header">
            <button type="button" class="hyd-page__back" data-smarthome-action="closeDeviceDetail" aria-label="${escapeHtmlAttr(t('hy.back'))}">
                <i class="fas fa-arrow-left"></i>
            </button>
            <div class="hyd-page__titles" data-device-name-root>
                ${deviceTitle}
                ${subtitle ? `<p class="hyd-page__meta hyd-page__meta--device">${subtitle}</p>` : ''}
            </div>
        </header>
        <div class="hyd-page__grid">
            ${overview}
            <section class="hyd-card hyd-card--wide">
                <h3 class="hyd-card__title">${escapeHtml(t('hy.detail_entities_section'))}</h3>
                <div class="hyd-entity-list hyd-entity-list--nested">${entityRows || `<p class="hyd-card__empty">${escapeHtml(t('integrations.no_controls'))}</p>`}</div>
            </section>
        </div>
    </div>`;
}
export function renderEntityListCard(entity, sourceIcons, options = {}) {
    const entityId = String(entity.entity_id || '');
    const isDerived = entity.source === 'derived';
    const domain = _domain(entity);
    const lower = _norm(entity.state);
    const isUnavail = ['unavailable', 'unknown', 'offline'].includes(lower);
    const name = escapeHtml(entity.name || entityId);
    const sub = escapeHtml(domain);
    const eidAttr = escapeHtmlAttr(entityId);
    const action = isDerived
        ? `data-smarthome-action="openDerivedModal" data-smarthome-entity-id="${eidAttr}"`
        : `data-smarthome-action="openEntityDetail" data-smarthome-entity-id="${eidAttr}"`;
    const nestedClass = options.nested ? ' hyd-entity-row--nested' : '';
    return `<article class="hyd-entity-row${nestedClass}${isUnavail ? ' is-offline' : ''}" data-entity="${eidAttr}" ${action} role="listitem">
        ${_entityIconHtml(entity, 'list')}
        <div class="hyd-entity-row__body">
            <div class="hyd-entity-row__name">${name}</div>
            <div class="hyd-entity-row__sub">${sub}</div>
        </div>
        ${_listRowMetaHtml(entity, null)}
    </article>`;
}
function _deviceOverviewCard(device, primary, sourceIcons, infoRows, entityCount) {
    const isOn = primary
        ? _entityIsActive(primary)
        : deviceHasActiveEntity(device);
    const isUnavail = primary ? _entityIsUnavailable(primary) : false;
    const stateClass = isOn ? 'is-on' : (isUnavail ? 'is-offline' : 'is-off');
    const readoutRaw = primary ? _stateReadout(primary) : _deviceSummaryReadout(device);
    const iconHtml = primary ? _entityIconHtml(primary, 'hero') : _deviceIconHtml(device, 'hero');
    const canPickPrimary = primaryEntityCandidates(device).length > 1;
    const holdAttrs = canPickPrimary
        ? ` data-smarthome-primary-hold-root="true" data-device-key="${escapeHtmlAttr(device.device_key)}" title="${escapeHtmlAttr(t('hy.detail_primary_entity_hold_hint'))}"`
        : '';
    const canToggle = primary && _entityCanToggle(primary);
    const statusTag = canToggle ? 'button' : 'div';
    const statusAttrs = canToggle
        ? `type="button" class="hyd-overview__status hyd-overview__status--interactive"${_statusControlMarkup(primary)}${holdAttrs} aria-label="${escapeHtmlAttr(t('hy.detail_toggle_state'))}"`
        : `class="hyd-overview__status"${holdAttrs}`;
    let statusExtra = '';
    if (primary) {
        const dom = _domain(primary);
        const source = String(primary.source || '');
        if (dom === 'light' && source !== 'derived') {
            const flags = resolveLightControlFlags(primary, isOn);
            if (flags.hasBrightness) {
                const pct = Math.round((flags.brightnessValue / flags.brightnessScale) * 100);
                statusExtra = `
            <div class="hyd-brightness hyd-overview__brightness">
                <div class="hyd-brightness__track">
                    <i class="fas fa-sun hyd-brightness__icon" aria-hidden="true"></i>
                    <input type="range" min="0" max="100" step="1" value="${pct}" class="hyd-brightness__range"
                        ${_lightAttr(String(primary.entity_id), source, 'brightness', ` data-smarthome-light-scale="${flags.brightnessScale}"`)}>
                    <i class="fas fa-sun hyd-brightness__icon hyd-brightness__icon--bright" aria-hidden="true"></i>
                </div>
            </div>`;
            }
        }
    }
    const deviceId = String(device.device_id || '').trim();
    const infoHtml = infoRows.map(([k, v]) => `<div class="hyd-info-row"><dt>${escapeHtml(String(k))}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('');
    const entitiesRow = _renderEntitiesInfoRow(entityCount);
    const deviceIdRow = deviceId
        ? `<div class="hyd-overview__device-id mono">${escapeHtml(deviceId)}</div>`
        : '';
    return `<section class="hyd-card hyd-card--overview hyd-card--wide ${stateClass}">
        <div class="hyd-overview">
            <${statusTag} ${statusAttrs}>
                <div class="hyd-hero-icon-wrap">${iconHtml}</div>
                <div class="hyd-hero-readout hyd-overview__readout">
                    ${_readoutValueMarkup(readoutRaw)}
                    <span class="hyd-hero-readout__label">${escapeHtml(t('hy.col_state'))}</span>
                </div>
                ${statusExtra}
            </${statusTag}>
            <div class="hyd-overview__details">
                <h3 class="hyd-card__title hyd-overview__title">${escapeHtml(t('hy.detail_device_info'))}</h3>
                <dl class="hyd-info-list">${infoHtml}${entitiesRow}</dl>
                ${deviceIdRow}
            </div>
        </div>
    </section>`;
}
/** Patch a device list row in place (live WS). */
export function patchDeviceListRowDom(device) {
    const key = String(device.device_key || '');
    if (!key)
        return;
    const row = document.querySelector(`.hyd-entity-row[data-device-key="${CSS.escape(key)}"]`);
    if (!row)
        return;
    const primary = primaryDeviceEntity(device);
    row.classList.toggle('is-offline', primary ? _entityIsUnavailable(primary) : false);
    const iconEl = row.querySelector('.hyd-icon');
    if (iconEl)
        iconEl.outerHTML = _deviceIconHtml(device, 'list');
    const stateEl = row.querySelector('.hyd-entity-row__state');
    const readout = primary ? _stateReadout(primary) : _deviceSummaryReadout(device);
    const showReadout = primary ? !_entityCanToggle(primary) : true;
    if (showReadout && readout) {
        if (stateEl)
            stateEl.textContent = readout;
    }
    else if (stateEl) {
        stateEl.remove();
    }
}
/** Patch an entity list row in place (live WS). */
export function patchEntityListRowDom(entity) {
    const eid = String(entity.entity_id || '');
    if (!eid)
        return;
    const row = document.querySelector(`.hyd-entity-row[data-entity="${CSS.escape(eid)}"]`);
    if (!row)
        return;
    row.classList.toggle('is-offline', _entityIsUnavailable(entity));
    const iconEl = row.querySelector('.hyd-icon');
    if (iconEl)
        iconEl.outerHTML = _entityIconHtml(entity, 'list');
    const readout = _stateReadout(entity);
    const showReadout = !_entityCanToggle(entity);
    const stateEl = row.querySelector('.hyd-entity-row__state');
    if (showReadout && readout) {
        if (stateEl)
            stateEl.textContent = readout;
    }
    else if (stateEl) {
        stateEl.remove();
    }
}
/** Patch device overview card in place (live WS) — avoids full detail re-render flicker. */
export function patchDeviceOverviewDom(device) {
    const root = document.querySelector(`[data-device-detail-key="${CSS.escape(device.device_key)}"]`);
    if (!root)
        return;
    const primary = primaryDeviceEntity(device);
    const overview = root.closest('.hyd-card--overview');
    if (primary) {
        const readout = root.querySelector('.hyd-hero-readout__value');
        if (readout)
            _syncReadoutValueEl(readout, _stateReadout(primary));
        const iconWrap = root.querySelector('.hyd-hero-icon-wrap');
        if (iconWrap)
            iconWrap.innerHTML = _entityIconHtml(primary, 'hero');
        const statusBtn = root.querySelector('.hyd-overview__status--interactive');
        if (statusBtn instanceof HTMLElement && _entityCanToggle(primary)) {
            const isOn = _entityIsActive(primary);
            statusBtn.dataset.smarthomeDeviceAction = isOn ? 'turn_off' : 'turn_on';
            statusBtn.dataset.on = isOn ? 'true' : 'false';
            statusBtn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
        }
        if (overview) {
            const isOn = _entityIsActive(primary);
            const isUnavail = _entityIsUnavailable(primary);
            overview.classList.toggle('is-on', isOn);
            overview.classList.toggle('is-off', !isOn && !isUnavail);
            overview.classList.toggle('is-offline', isUnavail);
        }
    }
}
function _entityInfoRows(entity, sourceIcons) {
    const attrs = (entity.attributes || {});
    const srcMeta = sourceIcons[String(entity.source || '')];
    return [
        [t('hy.detail_domain'), _domain(entity)],
        [t('hy.detail_source'), srcMeta?.label || entity.entry_title || entity.source || '—'],
        [t('hy.detail_manufacturer'), String(attrs.manufacturer || entity.device_manufacturer || '—')],
        [t('hy.detail_model'), String(attrs.model || entity.device_model || '—')],
    ];
}
function _entityOverviewCard(entity, sourceIcons) {
    const isOn = _entityIsActive(entity);
    const isUnavail = _entityIsUnavailable(entity);
    const stateClass = isOn ? 'is-on' : (isUnavail ? 'is-offline' : 'is-off');
    const readoutRaw = _stateReadout(entity);
    const iconHtml = _entityIconHtml(entity, 'hero');
    const canToggle = _entityCanToggle(entity);
    const statusTag = canToggle ? 'button' : 'div';
    const statusAttrs = canToggle
        ? `type="button" class="hyd-overview__status hyd-overview__status--interactive"${_statusControlMarkup(entity)} aria-label="${escapeHtmlAttr(t('hy.detail_toggle_state'))}"`
        : 'class="hyd-overview__status"';
    const infoRows = _entityInfoRows(entity, sourceIcons);
    const infoHtml = infoRows.map(([k, v]) => `<div class="hyd-info-row"><dt>${escapeHtml(String(k))}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('');
    let statusExtra = '';
    const dom = _domain(entity);
    const source = String(entity.source || '');
    if (dom === 'light' && source !== 'derived') {
        const flags = resolveLightControlFlags(entity, isOn);
        if (flags.hasBrightness) {
            const pct = Math.round((flags.brightnessValue / flags.brightnessScale) * 100);
            statusExtra = `
            <div class="hyd-brightness hyd-overview__brightness">
                <div class="hyd-brightness__track">
                    <i class="fas fa-sun hyd-brightness__icon" aria-hidden="true"></i>
                    <input type="range" min="0" max="100" step="1" value="${pct}" class="hyd-brightness__range"
                        ${_lightAttr(String(entity.entity_id), source, 'brightness', ` data-smarthome-light-scale="${flags.brightnessScale}"`)}>
                    <i class="fas fa-sun hyd-brightness__icon hyd-brightness__icon--bright" aria-hidden="true"></i>
                </div>
            </div>`;
        }
    }
    const entityId = String(entity.entity_id || '').trim();
    const eidAttr = escapeHtmlAttr(entityId);
    const entityIdRow = entityId
        ? `<div class="hyd-info-row hyd-info-row--entity-id"><dt>${escapeHtml(t('hy.detail_entity_id'))}</dt><dd class="hyd-info-row__value-with-action"><span class="mono hyd-info-row__entity-id-text">${escapeHtml(entityId)}</span><button type="button" class="hyd-editable-name__edit hyd-info-row__inline-action" data-smarthome-action="copyEntityIdFromRowActions" data-smarthome-entity-id="${eidAttr}" data-smarthome-stop-propagation="true" title="${escapeHtmlAttr(t('hy.copy_id_short'))}"><i class="fas fa-copy"></i></button></dd></div>`
        : '';
    return `<section class="hyd-card hyd-card--overview hyd-card--wide ${stateClass}">
        <div class="hyd-overview">
            <${statusTag} ${statusAttrs}>
                <div class="hyd-hero-icon-wrap">${iconHtml}</div>
                <div class="hyd-hero-readout hyd-overview__readout">
                    ${_readoutValueMarkup(readoutRaw)}
                    <span class="hyd-hero-readout__label">${escapeHtml(t('hy.col_state'))}</span>
                </div>
                ${statusExtra}
            </${statusTag}>
            <div class="hyd-overview__details">
                <h3 class="hyd-card__title hyd-overview__title">${escapeHtml(t('hy.detail_device_info'))}</h3>
                <dl class="hyd-info-list">${infoHtml}${entityIdRow}</dl>
            </div>
        </div>
    </section>`;
}
/** Patch entity overview card in place (live WS) — avoids full detail re-render flicker. */
export function patchEntityOverviewDom(entity) {
    const eid = String(entity.entity_id || '');
    const root = document.querySelector(`[data-entity-detail-id="${CSS.escape(eid)}"]`);
    if (!root)
        return;
    const overview = root.querySelector('.hyd-card--overview');
    const readout = root.querySelector('.hyd-hero-readout__value');
    if (readout)
        _syncReadoutValueEl(readout, _stateReadout(entity));
    const iconWrap = root.querySelector('.hyd-hero-icon-wrap');
    if (iconWrap)
        iconWrap.innerHTML = _entityIconHtml(entity, 'hero');
    if (overview) {
        const isOn = _entityIsActive(entity);
        const isUnavail = _entityIsUnavailable(entity);
        overview.classList.toggle('is-on', isOn);
        overview.classList.toggle('is-off', !isOn && !isUnavail);
        overview.classList.toggle('is-offline', isUnavail);
    }
    const statusBtn = root.querySelector('.hyd-overview__status--interactive');
    if (statusBtn instanceof HTMLElement && _entityCanToggle(entity)) {
        const isOn = _entityIsActive(entity);
        statusBtn.dataset.smarthomeDeviceAction = isOn ? 'turn_off' : 'turn_on';
        statusBtn.dataset.on = isOn ? 'true' : 'false';
        statusBtn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    }
    const dom = _domain(entity);
    if (dom === 'light') {
        const isOn = _entityIsActive(entity);
        const flags = resolveLightControlFlags(entity, isOn);
        if (flags.hasBrightness) {
            const pct = Math.round((flags.brightnessValue / flags.brightnessScale) * 100);
            const range = root.querySelector('.hyd-overview__brightness .hyd-brightness__range');
            if (range)
                range.value = String(pct);
        }
    }
}
/** Patch entity detail page without full re-render (toggle, WS, AI selection). */
export function patchEntityDetailDom(entity) {
    patchEntityOverviewDom(entity);
    const eid = String(entity.entity_id || '');
    const root = document.querySelector(`[data-entity-detail-id="${CSS.escape(eid)}"]`);
    if (!root)
        return;
    const aiCheck = root.querySelector('.hyd-ai-check');
    if (aiCheck)
        aiCheck.checked = !!entity.selected;
}
function _entityAuxControlsHtml(entity) {
    if (entity.source === 'derived')
        return '';
    const eid = escapeHtmlAttr(String(entity.entity_id || ''));
    const rows = [
        `<label class="hyd-ctrl-row hyd-ctrl-row--static hyd-ctrl-row--ai">
            <span class="hyd-ctrl-row__label"><i class="fas fa-robot hyd-ctrl-row__icon"></i>${escapeHtml(t('hy.row_action_ai'))}</span>
            <span class="hyd-ctrl-row__value"><input type="checkbox" class="hyd-ai-check" data-smarthome-change="toggleSelection" data-smarthome-entity-id="${eid}" ${entity.selected ? 'checked' : ''}></span>
        </label>`,
        `<button type="button" class="hyd-ctrl-row" data-smarthome-action="openAliasModalFromDetail" data-smarthome-entity-id="${eid}">
            <span class="hyd-ctrl-row__label"><i class="fas fa-tag hyd-ctrl-row__icon"></i>${escapeHtml(t('hy.col_alias'))}</span>
            <span class="hyd-ctrl-row__value"></span>
            <i class="fas fa-chevron-right hyd-ctrl-row__chev"></i>
        </button>`,
    ];
    return `<div class="hyd-ctrl-list hyd-ctrl-list--in-advanced">${rows.join('')}</div>`;
}
export function renderEntityDetailPage(entity, advancedHtml, sourceIcons) {
    const entityId = String(entity.entity_id || '');
    const displayName = escapeHtml(entity.name || entityId || t('hy.device_default'));
    const eid = escapeHtmlAttr(entityId);
    const canEditName = !!(entity.unique_id || entity.attributes?.registry_unique_id || entity.attributes?.unique_id);
    const editBtn = canEditName
        ? `<button type="button" data-entity-friendly-name-edit class="hyd-editable-name__edit" title="${escapeHtmlAttr(t('entity.render.friendly_name'))}"><i class="fas fa-pen"></i></button>`
        : '';
    const entityTitleView = `<h1 class="hyd-editable-name__label" data-entity-friendly-name-view>${displayName}</h1>${editBtn}`;
    const entityEditPanel = canEditName
        ? _editablePageTitleEditPanel(`data-entity-friendly-name-input value="${escapeHtmlAttr(entity.name || entityId)}"`, 'data-entity-friendly-name-save', 'data-entity-friendly-name-cancel', 'data-entity-friendly-name-edit-panel', t('common.save'), t('common.cancel'))
        : '';
    const entityTitle = canEditName
        ? _editablePageTitleShell('data-entity-friendly-name-view-wrap', entityTitleView, entityEditPanel)
        : `<div class="hyd-editable-name hyd-editable-name--page-title"><div class="hyd-editable-name__view"><h1 class="hyd-editable-name__label">${displayName}</h1></div></div>`;
    const auxControls = _entityAuxControlsHtml(entity);
    const advancedBody = advancedHtml || '';
    const hasAdvanced = !!(auxControls || advancedBody);
    const advanced = hasAdvanced
        ? `<section class="hyd-card hyd-card--wide hyd-card--advanced">
            <h3 class="hyd-card__title">${escapeHtml(t('hy.detail_advanced'))}</h3>
            <div class="hyd-advanced-wrap">${auxControls}${advancedBody}</div>
        </section>`
        : '';
    return `<div class="hyd-page" data-entity-detail-id="${eid}">
        <header class="hyd-page__header">
            <button type="button" class="hyd-page__back" data-smarthome-action="closeEntityDetail" data-smarthome-back-to="device" aria-label="${escapeHtmlAttr(t('hy.back'))}">
                <i class="fas fa-arrow-left"></i>
            </button>
            <div class="hyd-page__titles" data-entity-friendly-name-root>
                ${entityTitle}
            </div>
        </header>
        <div class="hyd-page__grid">
            ${_entityOverviewCard(entity, sourceIcons)}
            ${advanced}
        </div>
    </div>`;
}
