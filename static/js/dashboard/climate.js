/**
 * Dashboard climate cards: multi-zone carousel, controls, and add-modal entity chips.
 */
let _deps = null;
const _slideIndex = new Map();
let _swipeState = null;
let _entitySelection = [];
export function initDashboardClimate(deps) {
    _deps = deps;
    _ensureClimateSwipeDocListeners();
}
let _climateSwipeDocBound = false;
function _onClimateSwipeDocMove(event) {
    if (!_swipeState)
        return;
    moveDashboardClimateSwipe(event, _swipeState.widgetId);
}
function _onClimateSwipeDocEnd(event) {
    if (!_swipeState)
        return;
    endDashboardClimateSwipe(event, _swipeState.widgetId);
}
function _ensureClimateSwipeDocListeners() {
    if (_climateSwipeDocBound)
        return;
    _climateSwipeDocBound = true;
    document.addEventListener('pointermove', _onClimateSwipeDocMove, { passive: false });
    document.addEventListener('pointerup', _onClimateSwipeDocEnd);
    document.addEventListener('pointercancel', _onClimateSwipeDocEnd);
}
function deps() {
    if (!_deps)
        throw new Error('Dashboard climate not initialized');
    return _deps;
}
function getCache() { return deps().getCache(); }
function findWidget(id) { return deps().findWidget(id); }
function renderDashboard() { return deps().renderDashboard(); }
function getEditMode() { return deps().getEditMode(); }
function widgetDragAttrs(w) { return deps().widgetDragAttrs(w); }
function widgetEditControls(w) { return deps().widgetEditControls(w); }
function widgetSizeClass(w) { return deps().widgetSizeClass(w); }
function resolveEntityMatch(input, type = 'button') { return deps().resolveEntityMatch(input, type); }
function esc(v) { return deps().escapeHtml(v); }
function stateOn(s) { return deps().stateOn(s); }
function dashApiError(d, k) { return deps().dashApiError(d, k); }
function widgetTitle(w, fallbacks) { return deps().widgetTitle(w, fallbacks); }
function renderCardElement(w) { return deps().HVBridge.renderCardElement(w); }
function controlPending(id) { return deps().controlPending(id); }
function setPendingControl(id, data) { return deps().setPendingControl(id, data); }
function deletePendingControl(id) { return deps().deletePendingControl(id); }
function snapshotEntityState(id) { return deps().snapshotEntityState(id); }
function restoreEntitySnapshot(s) { return deps().restoreEntitySnapshot(s); }
function patchEntityState(id, st, attrs) { return deps().patchEntityState(id, st, attrs); }
function tryFastPathForEntities(ids) { return deps().tryFastPathForEntities(ids); }
function getCurrentPageId() { return deps().getCurrentPageId(); }
function t(key, params) { return deps().t(key, params); }
function showToast(message, type, duration) { return deps().showToast(message, type, duration); }
function apiCall(url, options) { return deps().apiCall(url, options); }
export function climateConfiguredIds(widget) {
    return _climateConfiguredRecords(widget).map(item => item.entity_id);
}
export function clearDashboardClimateEntitySelection() {
    setDashboardClimateEntitySelection([]);
}
// --- Climate (current temp + setpoint + mode) ---
function _climateConfiguredRecords(widget) {
    const ids = [];
    const records = [];
    const add = (value) => {
        const raw = value && typeof value === 'object' ? value : null;
        const record = raw
            ? {
                entity_id: raw.entity_id,
                title: raw.title,
                subtitle: raw.subtitle ?? raw.entity_name,
            }
            : { entity_id: value };
        const entityId = String(record.entity_id || '').trim();
        if (!entityId)
            return;
        if (ids.includes(entityId)) {
            const existing = records.find(item => item.entity_id === entityId);
            if (existing) {
                const title = String(record.title || '').trim();
                const subtitle = String(record.subtitle || '').trim();
                if (title)
                    existing.title = title;
                if (subtitle)
                    existing.subtitle = subtitle;
            }
            return;
        }
        ids.push(entityId);
        records.push({
            entity_id: entityId,
            title: String(record.title || '').trim(),
            subtitle: String(record.subtitle || '').trim(),
        });
    };
    add(widget?.entity_id);
    const config = (widget?.config && typeof widget.config === 'object' ? widget.config : {});
    if (Array.isArray(config.entities))
        config.entities.forEach(add);
    if (Array.isArray(config.entity_ids))
        config.entity_ids.forEach(add);
    return records;
}
function _climateAvailableEntity(entityId) {
    const target = String(entityId || '');
    if (!target)
        return null;
    return (getCache().available_entities || []).find(item => item?.entity_id === target) || null;
}
function _climateEntities(widget) {
    const records = _climateConfiguredRecords(widget);
    const hydrated = Array.isArray(widget?.entities) ? widget.entities : [];
    const byId = new Map();
    hydrated.forEach(item => { if (item?.entity_id)
        byId.set(item.entity_id, item); });
    const result = [];
    const sourceRecords = records.length ? records : [widget?.entity_id].filter(Boolean).map(entity_id => ({ entity_id: String(entity_id), title: '', subtitle: '' }));
    sourceRecords.forEach(record => {
        const entityId = record.entity_id;
        const rawItem = byId.get(entityId) || (entityId === widget?.entity_id ? widget : null) || _climateAvailableEntity(entityId) || { entity_id: entityId };
        const item = rawItem;
        const attrs = (item.attributes || {});
        result.push({
            ...item,
            entity_id: entityId,
            slide_title: record.title || item.title || '',
            slide_subtitle: record.subtitle || item.subtitle || '',
            entity_name: item.entity_name || item.name || entityId,
            current_state: item.current_state ?? item.state ?? 'unknown',
            attributes: attrs,
            available: item.available !== false,
            controllable: item.controllable !== false,
            unit: String(item.unit || attrs.temperature_unit || '°C'),
        });
    });
    return result.length ? result : [widget];
}
function _climateActiveIndex(widget, total) {
    const count = Math.max(1, Number(total) || 1);
    const key = String(widget?.id || '');
    const current = Number(_slideIndex.get(key) || 0);
    const normalized = ((current % count) + count) % count;
    if (normalized !== current)
        _slideIndex.set(key, normalized);
    return normalized;
}
function _climateActiveEntity(widget) {
    const entities = _climateEntities(widget);
    return entities[_climateActiveIndex(widget, entities.length)] || entities[0] || widget;
}
function _climateSlideMarkup(widget, entity, index, isActive, hasSlides, editControls) {
    const attrs = (entity.attributes || {});
    const caps = (attrs.capabilities || {});
    const current = attrs.current_temperature != null ? attrs.current_temperature : (Number.isFinite(parseFloat(String(entity.current_state ?? ''))) ? parseFloat(String(entity.current_state)) : '\u2014');
    const target = attrs.temperature != null ? attrs.temperature : (attrs.target_temperature != null ? attrs.target_temperature : null);
    const mode = String(attrs.hvac_mode || entity.current_state || 'off').toLowerCase();
    const unit = attrs.temperature_unit || entity.unit || caps.unit || '\u00b0C';
    const controllable = widget.controllable !== false && entity.controllable !== false && entity.available !== false;
    const hvacOptions = _climateOptions(attrs.hvac_modes || caps.hvac_modes || [], mode);
    const modeLabel = _climateModeLabel(mode);
    const currentHasValue = current != null && String(current) !== '\u2014';
    const widgetId = esc(widget.id);
    const entityId = esc(entity.entity_id || widget.entity_id || '');
    const title = entity.slide_title || (hasSlides ? (entity.entity_name || entity.entity_id) : widgetTitle(widget, { entityId: entity.entity_id, entityName: entity.entity_name }));
    const stateText = entity.slide_subtitle ? `${entity.slide_subtitle} \u00b7 ${modeLabel}` : modeLabel;
    const modeMap = {};
    try {
        const rawModes = attrs.hvac_modes ?? caps.hvac_modes ?? [];
        const modes = (Array.isArray(rawModes) ? rawModes : [rawModes]).concat([mode]);
        for (const m of modes) {
            const key = String(m).toLowerCase();
            if (!modeMap[key])
                modeMap[key] = _climateModeLabel(key);
        }
    }
    catch (_e) { /* ignore */ }
    const modeMapAttr = esc(JSON.stringify(modeMap));
    const controls = controllable ? `
            <div class="hyve-dashboard-card__climate-controls">
                <div class="hyve-dashboard-card__climate-setpoint" aria-label="Setpoint">
                    <button type="button" title="${esc(t('dashboard.climate.decrease_temp'))}" aria-label="${esc(t('dashboard.climate.decrease_temp'))}" data-dash-action="climateAdjustTemp" data-dash-stop-propagation="true" data-widget-id="${widgetId}" data-entity-id="${entityId}" data-delta="-1"><i class="fas fa-minus"></i></button>
                    <span data-climate-target data-climate-unit="${esc(unit)}">${target != null ? esc(target) : '\u2014'}${esc(unit)}</span>
                    <button type="button" title="${esc(t('dashboard.climate.increase_temp'))}" aria-label="${esc(t('dashboard.climate.increase_temp'))}" data-dash-action="climateAdjustTemp" data-dash-stop-propagation="true" data-widget-id="${widgetId}" data-entity-id="${entityId}" data-delta="1"><i class="fas fa-plus"></i></button>
                </div>
                ${hvacOptions.length ? `<div class="hyve-dashboard-card__climate-mode-menu" data-widget-id="${widgetId}" data-entity-id="${entityId}" data-open="false">
                    <button type="button" class="hyve-dashboard-card__climate-mode-button" title="${esc(t('dashboard.climate.hvac_mode'))}" aria-label="${esc(t('dashboard.climate.hvac_mode'))}" aria-haspopup="menu" aria-expanded="false" data-dash-action="climateToggleModeMenu" data-dash-stop-propagation="true" data-widget-id="${widgetId}" data-entity-id="${entityId}">
                        <i class="fas fa-gear"></i><span data-climate-mode-label data-climate-mode-map="${modeMapAttr}">${esc(modeLabel)}</span><i class="fas fa-chevron-down"></i>
                    </button>
                    <div class="hyve-dashboard-card__climate-mode-panel" role="menu">
                        ${hvacOptions.map(opt => `<button type="button" role="menuitem" data-climate-mode-option data-climate-mode-value="${esc(opt.value)}" class="hyve-dashboard-card__climate-mode-option" data-active="${String(opt.value).toLowerCase() === mode ? 'true' : 'false'}" data-dash-action="climateSetMode" data-dash-stop-propagation="true" data-widget-id="${widgetId}" data-entity-id="${entityId}" data-climate-mode="${esc(opt.value)}"><span>${esc(opt.label)}</span>${String(opt.value).toLowerCase() === mode ? '<i class="fas fa-check"></i>' : ''}</button>`).join('')}
                    </div>
                </div>` : ''}
            </div>` : '';
    return `
            <div class="hyve-dashboard-card__climate-slide" data-slide-index="${index}" data-active-slide="${isActive ? 'true' : 'false'}"${isActive ? '' : ' aria-hidden="true"'}>
                <div class="hyve-dashboard-card__row">
                    <span class="hyve-dashboard-card__icon"><i class="fas fa-temperature-half"></i></span>
                    <div class="hyve-dashboard-card__body">
                        <div class="hyve-dashboard-card__title">${esc(title)}</div>
                        <div class="hyve-dashboard-card__state" data-climate-stateline>${esc(stateText)}</div>
                    </div>
                    <div class="hyve-dashboard-card__climate-current"><span data-climate-current>${esc(currentHasValue ? current : '\u2014')}</span><span class="unit" data-climate-current-unit${currentHasValue ? '' : ' style="display:none"'}>${esc(unit)}</span></div>
                    ${editControls}
                </div>
                ${controls}
            </div>`;
}
export function renderClimateCard(widget) {
    const dragAttrs = widgetDragAttrs(widget);
    const editControls = widgetEditControls(widget);
    const entities = _climateEntities(widget);
    const total = entities.length;
    const activeIndex = _climateActiveIndex(widget, total);
    const active = entities[activeIndex] || entities[0] || widget;
    const widgetId = esc(widget.id);
    const hasSlides = total > 1;
    const activeAttrs = active.attributes || {};
    const activeMode = String(activeAttrs.hvac_mode || active.current_state || 'off').toLowerCase();
    const on = stateOn(activeMode) || activeMode === 'auto';
    const slidesHtml = entities
        .map((entity, index) => _climateSlideMarkup(widget, entity, index, index === activeIndex, hasSlides, index === activeIndex ? editControls : ''))
        .join('');
    const pipsHtml = hasSlides ? `
            <div class="hyve-dashboard-card__climate-pips" role="tablist" aria-label="${esc(t('dashboard.climate.zones'))}">
                ${entities.map((entity, index) => `<button type="button" role="tab" class="hyve-dashboard-card__climate-pip" data-climate-pip="${index}" data-active="${index === activeIndex ? 'true' : 'false'}" aria-selected="${index === activeIndex ? 'true' : 'false'}" aria-label="${esc(entity.slide_title || entity.entity_name || t('dashboard.climate.zone', { n: index + 1 }))}" data-dash-action="climateSelectSlide" data-dash-stop-propagation="true" data-widget-id="${widgetId}" data-slide-index="${index}"><span></span></button>`).join('')}
            </div>` : '';
    widget._climateInner = `
            <div class="hyve-dashboard-card__climate-viewport">
                <div class="hyve-dashboard-card__climate-track" data-animating="false" data-dragging="false" style="--hyve-climate-index:${activeIndex};">
                    ${slidesHtml}
                </div>
            </div>${pipsHtml}`;
    widget._climateActiveEntityId = active.entity_id || widget.entity_id || '';
    widget._climateActiveEntity = active;
    return `
        <article ${dragAttrs}
            class="hyve-dashboard-card hyve-dashboard-card--climate ${widgetSizeClass(widget)}"
            data-widget-id="${widgetId}"
            data-on="${on ? 'true' : 'false'}"
            data-clickable="false"
            data-edit="${getEditMode() ? 'true' : 'false'}"
            data-unavailable="${widget.available === false || active.available === false ? 'true' : 'false'}"
            data-dash-pointer="climateSwipeStart" data-widget-id="${widgetId}">
            ${renderCardElement(widget)}
        </article>`;
}
export function closeDashboardClimateModeMenus(except = null) {
    document.querySelectorAll('.hyve-dashboard-card__climate-mode-menu[data-open="true"]').forEach(menuEl => {
        const menu = menuEl;
        if (except && menu === except)
            return;
        menu.dataset.open = 'false';
        menu.querySelector('.hyve-dashboard-card__climate-mode-button')?.setAttribute('aria-expanded', 'false');
        _setDashboardClimateMenuLayer(menu, false);
    });
}
function _setDashboardClimateMenuLayer(menu, open) {
    const card = menu?.closest?.('.hyve-dashboard-card--climate');
    const panel = menu?.closest?.('.dashboard-panel');
    if (card) {
        if (open)
            card.setAttribute('data-climate-menu-open', 'true');
        else
            card.removeAttribute('data-climate-menu-open');
    }
    if (panel) {
        if (open)
            panel.setAttribute('data-climate-menu-open', 'true');
        else
            panel.removeAttribute('data-climate-menu-open');
    }
}
export function toggleDashboardClimateModeMenu(widgetId, event = null, entityId = '') {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const id = String(widgetId || '');
    const targetEntity = String(entityId || '');
    const menu = Array.from(document.querySelectorAll('.hyve-dashboard-card__climate-mode-menu'))
        .find(item => item.dataset.widgetId === id && (!targetEntity || item.dataset.entityId === targetEntity));
    if (!menu)
        return;
    const nextOpen = menu.dataset.open !== 'true';
    closeDashboardClimateModeMenus(nextOpen ? menu : null);
    menu.dataset.open = nextOpen ? 'true' : 'false';
    menu.querySelector('.hyve-dashboard-card__climate-mode-button')?.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
    _setDashboardClimateMenuLayer(menu, nextOpen);
}
function _climateCarouselParts(widgetId) {
    const article = document.querySelector(`.hyve-dashboard-card--climate[data-widget-id="${CSS.escape(String(widgetId))}"]`);
    if (!article)
        return { article: null, track: null, element: null };
    const track = article.querySelector('.hyve-dashboard-card__climate-track');
    const element = (article.querySelector('.hv-card-mount') || article.querySelector('[data-hv-widget-id]'));
    return { article, track, element };
}
function _commitClimateSlide(widgetId, index, { animate = true } = {}) {
    const id = String(widgetId);
    const widget = findWidget(widgetId);
    if (!widget)
        return;
    const entities = _climateEntities(widget);
    const total = entities.length;
    if (total <= 1)
        return;
    const next = Math.max(0, Math.min(total - 1, Number(index) || 0));
    _slideIndex.set(id, next);
    const { track, element } = _climateCarouselParts(widgetId);
    if (!track) {
        renderDashboard();
        return;
    }
    track.style.removeProperty('--hyve-climate-drag');
    if (track._hyveClimateAnimTimer) {
        window.clearTimeout(track._hyveClimateAnimTimer);
        track._hyveClimateAnimTimer = null;
    }
    if (animate) {
        track.dataset.animating = 'true';
        track._hyveClimateAnimTimer = window.setTimeout(() => {
            track.dataset.animating = 'false';
            track._hyveClimateAnimTimer = null;
        }, 320);
    }
    else {
        track.dataset.animating = 'false';
    }
    track.dataset.dragging = 'false';
    track.style.setProperty('--hyve-climate-index', String(next));
    const entity = entities[next] || null;
    widget._climateActiveEntityId = (entity && entity.entity_id) || widget.entity_id || '';
    widget._climateActiveEntity = entity;
    if (element && typeof element.setActiveSlide === 'function') {
        element.setActiveSlide(next, entity);
    }
}
export function selectDashboardClimateSlide(widgetId, index, event = null) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const widget = findWidget(widgetId);
    if (!widget)
        return;
    const total = _climateEntities(widget).length;
    if (total <= 1)
        return;
    const current = _climateActiveIndex(widget, total);
    const next = Math.max(0, Math.min(total - 1, Number(index) || 0));
    if (next === current)
        return;
    closeDashboardClimateModeMenus();
    _commitClimateSlide(widgetId, next, { animate: true });
}
export function shiftDashboardClimateSlide(widgetId, direction = 1, event = null) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const widget = findWidget(widgetId);
    if (!widget)
        return;
    const total = _climateEntities(widget).length;
    if (total <= 1)
        return;
    const current = _climateActiveIndex(widget, total);
    selectDashboardClimateSlide(widgetId, current + (Number(direction) < 0 ? -1 : 1), event);
}
export function startDashboardClimateSwipe(event, widgetId) {
    if (!(event instanceof PointerEvent))
        return;
    if (getEditMode())
        return;
    const target = event.target;
    if (target instanceof Element && target.closest?.('button, a, input, select, textarea, label, .dashboard-widget-edit-controls'))
        return;
    const widget = findWidget(widgetId);
    if (!widget)
        return;
    const total = _climateEntities(widget).length;
    if (total <= 1)
        return;
    const { article, track } = _climateCarouselParts(widgetId);
    if (!article || !track)
        return;
    try {
        article.setPointerCapture?.(event.pointerId);
    }
    catch (_) { }
    const width = track.getBoundingClientRect().width || article.getBoundingClientRect().width || 1;
    _swipeState = {
        widgetId: String(widgetId),
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        index: _climateActiveIndex(widget, total),
        total,
        width,
        track,
        moved: false,
    };
}
export function moveDashboardClimateSwipe(event, widgetId) {
    const st = _swipeState;
    if (!st || st.widgetId !== String(widgetId) || st.pointerId !== event.pointerId)
        return;
    const dx = event.clientX - st.x;
    const dy = event.clientY - st.y;
    if (!st.moved) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6)
            return;
        if (Math.abs(dy) > Math.abs(dx)) {
            _swipeState = null;
            return;
        }
        st.moved = true;
        st.track.dataset.dragging = 'true';
        st.track.dataset.animating = 'false';
        if (st.track._hyveClimateAnimTimer) {
            window.clearTimeout(st.track._hyveClimateAnimTimer);
            st.track._hyveClimateAnimTimer = null;
        }
    }
    event.preventDefault?.();
    let drag = dx;
    const atStart = st.index === 0 && dx > 0;
    const atEnd = st.index === st.total - 1 && dx < 0;
    if (atStart || atEnd)
        drag = dx * 0.32;
    drag = Math.max(-st.width, Math.min(st.width, drag));
    st.track.style.setProperty('--hyve-climate-drag', `${drag.toFixed(1)}px`);
}
export function endDashboardClimateSwipe(event, widgetId) {
    const st = _swipeState;
    if (!st || st.widgetId !== String(widgetId))
        return;
    _swipeState = null;
    if (!st.moved)
        return;
    const dx = event.clientX - st.x;
    const threshold = Math.max(44, st.width * 0.22);
    let target = st.index;
    if (dx <= -threshold)
        target = st.index + 1;
    else if (dx >= threshold)
        target = st.index - 1;
    target = Math.max(0, Math.min(st.total - 1, target));
    closeDashboardClimateModeMenus();
    _commitClimateSlide(widgetId, target, { animate: true });
}
function _climateModeLabel(value) {
    const key = String(value || '').toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
    const translated = t('entity.climate.' + key);
    if (translated !== 'entity.climate.' + key)
        return translated;
    return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function _climateOptions(rawOptions, currentMode = '') {
    const source = Array.isArray(rawOptions) ? rawOptions : [];
    const options = [];
    const seen = new Set();
    const add = (value, label = '') => {
        const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
        if (!normalized || seen.has(normalized))
            return;
        seen.add(normalized);
        options.push({ value: normalized, label: label || _climateModeLabel(normalized) });
    };
    source.forEach(item => {
        if (item && typeof item === 'object')
            add(item.value, item.label);
        else
            add(item);
    });
    add(currentMode || 'off');
    return options;
}
function _normalizeClimateEntitySelection(items) {
    const result = [];
    const seen = new Set();
    (Array.isArray(items) ? items : []).forEach(value => {
        const record = value && typeof value === 'object'
            ? {
                entity_id: value.entity_id,
                title: value.title,
                subtitle: value.subtitle ?? value.entity_name,
            }
            : { entity_id: String(value ?? '') };
        const entityId = String(record.entity_id || '').trim();
        if (!entityId || seen.has(entityId))
            return;
        seen.add(entityId);
        result.push({
            entity_id: entityId,
            title: String(record.title || '').trim(),
            subtitle: String(record.subtitle || '').trim(),
        });
    });
    return result.slice(0, 12);
}
export function setDashboardClimateEntitySelection(items) {
    _entitySelection = _normalizeClimateEntitySelection(items);
    renderDashboardClimateEntityChips();
}
export function addDashboardClimateEntityId(entityId) {
    const found = _climateAvailableEntity(entityId);
    const next = _normalizeClimateEntitySelection([
        ..._entitySelection,
        { entity_id: entityId, title: found?.name || '', subtitle: '' },
    ]);
    setDashboardClimateEntitySelection(next);
}
export function climateEntityRecordsForSave() {
    const entityInput = document.getElementById('dashboard-entity-select');
    const selected = resolveEntityMatch(entityInput, 'climate');
    const records = [..._entitySelection];
    if (selected?.entity_id && !records.some(item => item.entity_id === selected.entity_id)) {
        records.push({ entity_id: selected.entity_id, title: selected.name || '', subtitle: '' });
    }
    return _normalizeClimateEntitySelection(records);
}
function _climateEntityIdsForSave() {
    return climateEntityRecordsForSave().map(item => item.entity_id);
}
function _climateEntityLabel(record) {
    const entityId = record.entity_id;
    const item = _climateAvailableEntity(entityId);
    return item?.name || entityId;
}
export function renderDashboardClimateEntityChips() {
    const group = document.getElementById('dashboard-climate-entities-group');
    const list = document.getElementById('dashboard-climate-entities-list');
    if (!group || !list)
        return;
    const type = document.getElementById('dashboard-widget-type')?.value || 'button';
    group.classList.toggle('hidden', type !== 'climate');
    if (type !== 'climate')
        return;
    if (!_entitySelection.length) {
        list.innerHTML = `<span class="dashboard-climate-entities__empty">${esc(t('dashboard.climate.no_entities'))}</span>`;
        return;
    }
    list.innerHTML = _entitySelection.map((record, idx) => {
        const entityId = record.entity_id;
        return `
        <div class="dashboard-climate-entities__chip" data-primary="${idx === 0 ? 'true' : 'false'}">
            <div class="dashboard-climate-entities__chip-head">
                <span>${esc(_climateEntityLabel(record))}</span>
                <small>${esc(entityId)}</small>
                <button type="button" title="${esc(t('dashboard.climate.remove'))}" aria-label="${esc(t('dashboard.climate.remove'))}" data-dash-action="climateRemoveEntity" data-entity-id="${esc(entityId)}"><i class="fas fa-xmark"></i></button>
            </div>
            <div class="dashboard-climate-entities__fields">
                <input type="text" value="${esc(record.title)}" placeholder="${esc(t('dashboard.climate.slide_title_placeholder'))}" data-dash-input="climateEntityMeta" data-entity-id="${esc(entityId)}" data-field="title">
                <input type="text" value="${esc(record.subtitle)}" placeholder="${esc(t('dashboard.climate.slide_subtitle_placeholder'))}" data-dash-input="climateEntityMeta" data-entity-id="${esc(entityId)}" data-field="subtitle">
            </div>
        </div>`;
    }).join('');
}
export function updateDashboardClimateEntityMeta(entityId, field, value) {
    const key = field === 'subtitle' ? 'subtitle' : 'title';
    const target = String(entityId || '');
    _entitySelection = _entitySelection.map(item => (item.entity_id === target ? { ...item, [key]: String(value || '') } : item));
}
export function addSelectedDashboardClimateEntity() {
    const entityInput = document.getElementById('dashboard-entity-select');
    const selected = resolveEntityMatch(entityInput, 'climate');
    if (!selected?.entity_id) {
        showToast(t('dashboard.pick_climate_entity'), 'warning');
        return;
    }
    addDashboardClimateEntityId(selected.entity_id);
}
export function removeDashboardClimateEntity(entityId) {
    setDashboardClimateEntitySelection(_entitySelection.filter(item => item.entity_id !== String(entityId || '')));
}
function _climateNumber(value, fallback = null) {
    const parsed = parseFloat(String(value ?? ''));
    return Number.isFinite(parsed) ? parsed : fallback;
}
function _roundClimateValue(value, step) {
    const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0;
    return Number(value.toFixed(Math.min(Math.max(decimals, 0), 2)));
}
export async function adjustDashboardClimateTemperature(widgetId, direction, entityId = '') {
    const widget = findWidget(widgetId);
    if (!widget)
        return;
    const entity = entityId ? _climateEntities(widget).find(item => item.entity_id === entityId) : _climateActiveEntity(widget);
    const attrs = (entity?.attributes || {});
    const caps = (attrs.capabilities || {});
    const step = _climateNumber(attrs.target_temp_step ?? attrs.target_temperature_step ?? caps.step, 0.5) || 0.5;
    const min = _climateNumber(attrs.min_temp ?? caps.min, 5) ?? 5;
    const max = _climateNumber(attrs.max_temp ?? caps.max, 35) ?? 35;
    const base = _climateNumber(attrs.temperature ?? attrs.target_temperature, _climateNumber(attrs.current_temperature, min) ?? min) ?? min;
    const delta = direction < 0 ? -step : step;
    const next = _roundClimateValue(Math.min(Math.max(base + delta, min), max), step);
    await _controlClimate(widgetId, 'set_temperature', { temperature: next, value: next }, { temperature: next, target_temperature: next }, entity?.current_state ?? widget.current_state, entity?.entity_id || entityId);
}
export async function setDashboardClimateMode(widgetId, mode, entityId = '') {
    const value = String(mode || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/-/g, '_');
    if (!value)
        return;
    closeDashboardClimateModeMenus();
    await _controlClimate(widgetId, 'set_hvac_mode', { hvac_mode: value, value }, { hvac_mode: value }, value, entityId);
}
async function _controlClimate(widgetId, action, data, attrsPatch = {}, nextState = null, entityId = '') {
    const widget = findWidget(widgetId);
    if (!widget || controlPending(widgetId))
        return;
    const activeEntity = entityId ? _climateEntities(widget).find(item => item.entity_id === entityId) : _climateActiveEntity(widget);
    const targetEntityId = String(activeEntity?.entity_id || entityId || widget.entity_id || '');
    const snapshot = snapshotEntityState(targetEntityId);
    const state = nextState == null ? (activeEntity?.current_state ?? widget.current_state ?? null) : nextState;
    setPendingControl(String(widgetId), {
        widgetId: String(widgetId),
        entityId: targetEntityId,
        nextState: state,
        action,
        startedAt: Date.now(),
    });
    patchEntityState(targetEntityId, state, attrsPatch);
    if (!tryFastPathForEntities([targetEntityId]))
        renderDashboard();
    try {
        const activePageId = getCurrentPageId();
        const pageQS = activePageId ? `?page_id=${encodeURIComponent(activePageId)}` : '';
        const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(widgetId)}/toggle${pageQS}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, entity_id: targetEntityId, data: { ...(data || {}), entity_id: targetEntityId } }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiError(err.detail, 'dashboard.action_failed'));
        }
        window.setTimeout(() => {
            deletePendingControl(String(widgetId));
            if (!tryFastPathForEntities([targetEntityId]))
                renderDashboard();
        }, 900);
    }
    catch (e) {
        deletePendingControl(String(widgetId));
        restoreEntitySnapshot(snapshot);
        if (!tryFastPathForEntities([targetEntityId]))
            renderDashboard();
        showToast(e instanceof Error ? e.message : t('dashboard.action_failed'), 'error');
    }
}
