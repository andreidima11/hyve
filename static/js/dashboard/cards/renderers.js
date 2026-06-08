/**
 * Dashboard widget card HTML renderers (Hyveview outer article shell).
 * Each function receives (widget, ctx) where ctx is built by dashboard.js.
 */

/** @typedef {{
 *   renderer?: string,
 *   getEditMode: () => boolean,
 *   widgetDragAttrs: (widget: object) => string,
 *   widgetEditControls: (widget: object) => string,
 *   widgetSizeClass: (widget: object) => string,
 *   widgetSpan: (widget: object) => { col: number, row: number },
 *   widgetRenderer: (widget: object) => string,
 *   escapeHtml: (value: unknown) => string,
 *   stateOn: (state: string) => boolean,
 *   controlVisuallyPending: (widgetId: string) => boolean,
 *   renderCardElement: (widget: object) => string,
 *   widgetTitle: (widget: object, opts?: object) => string,
 *   getCache: () => object,
 *   cameraPreferWebmPlayer: (attrs: object) => boolean,
 *   cameraSupportsGo2rtc: (attrs: object) => boolean,
 *   interactive?: boolean,
 * }} CardRenderCtx */

export function renderLabelCard(widget, ctx) {
    const editMode = ctx.getEditMode();
    const labelClasses = widget.show_background
        ? 'hyve-dashboard-label hyve-dashboard-label--accent'
        : 'hyve-dashboard-label hyve-dashboard-label--bare';
    return `
        <article ${ctx.widgetDragAttrs(widget)}
            class="${ctx.widgetSizeClass(widget)} ${labelClasses} ${editMode ? 'cursor-grab active:cursor-grabbing' : ''}"
            data-clickable="false"
            data-edit="${editMode ? 'true' : 'false'}">
            ${ctx.renderCardElement(widget)}
            ${ctx.widgetEditControls(widget)}
        </article>`;
}

export function renderTileCard(widget, ctx, opts = {}) {
    const interactive = opts.interactive !== undefined ? opts.interactive : ctx.interactive !== false;
    const editMode = ctx.getEditMode();
    const renderer = ctx.widgetRenderer(widget);
    const state = String(widget.current_state || 'unknown');
    const on = ctx.stateOn(state);
    const controllable = interactive && widget.controllable !== false
        && (renderer === 'tile' || renderer === 'button' || renderer === 'switch' || renderer === 'scene');
    const hasEntity = Boolean(String(widget.entity_id || '').trim());
    const clickable = !editMode && controllable && (widget.available !== false || hasEntity);
    const cardActionAttrs = clickable
        ? `role="button" tabindex="0" data-dash-action="cardActivate" data-dash-action-key="cardActivate" data-widget-id="${ctx.escapeHtml(widget.id)}"`
        : '';
    return `
        <article ${ctx.widgetDragAttrs(widget)} ${cardActionAttrs}
            class="hyve-dashboard-card ${ctx.widgetSizeClass(widget)}"
            data-on="${on ? 'true' : 'false'}"
            data-pending="${ctx.controlVisuallyPending(widget.id) ? 'true' : 'false'}"
            data-entity-id="${ctx.escapeHtml(widget.entity_id || '')}"
            data-clickable="${clickable ? 'true' : 'false'}"
            data-edit="${editMode ? 'true' : 'false'}"
            data-unavailable="${widget.available === false ? 'true' : 'false'}">
            ${ctx.renderCardElement(widget)}
            ${ctx.widgetEditControls(widget)}
        </article>`;
}

export function cameraCardMode(widget) {
    const config = widget?.config && typeof widget.config === 'object' ? widget.config : {};
    const mode = String(config.camera_mode || widget?.camera_mode || '').trim().toLowerCase();
    return mode === 'live' ? 'live' : 'snapshots';
}

export function cameraWidgetEntities(widget, ctx) {
    const cfg = widget?.config && typeof widget.config === 'object' ? widget.config : {};
    const raw = Array.isArray(cfg.entities) ? cfg.entities : [];
    const fromConfig = raw.map((e) => {
        if (typeof e === 'string') return { entity_id: e, title: '', subtitle: '' };
        return {
            entity_id: String(e?.entity_id || '').trim(),
            title: String(e?.title || '').trim(),
            subtitle: String(e?.subtitle || '').trim(),
        };
    }).filter((e) => e.entity_id);
    if (fromConfig.length) return fromConfig;
    const eid = String(widget?.entity_id || '').trim();
    if (!eid) return [];
    return [{
        entity_id: eid,
        title: ctx.widgetTitle(widget, { entityId: eid }),
        subtitle: '',
    }];
}

export function renderCameraCard(widget, ctx) {
    const editMode = ctx.getEditMode();
    const entities = cameraWidgetEntities(widget, ctx);
    const primary = entities[0] || {};
    const entityId = String(primary.entity_id || widget.entity_id || '');
    const title = widget.title || primary.title || widget.entity_name || entityId;
    const mode = cameraCardMode(widget);
    const cfg = widget?.config && typeof widget.config === 'object' ? widget.config : {};
    const interval = Math.max(2, Number(cfg.refresh_interval || cfg.interval || 10));
    const defaultAudio = !!cfg.default_audio;
    const defaultMic = !!cfg.default_microphone;
    const preload = !!cfg.preload;
    const preloadScope = cfg.preload_scope === 'all' ? 'all' : 'adjacent';
    const esc = ctx.escapeHtml;
    const entitiesPayload = entities.map((e) => {
        const live = (ctx.getCache()?.available_entities || []).find((x) => x.entity_id === e.entity_id);
        const attrs = live?.attributes || {};
        return {
            entity_id: e.entity_id,
            title: e.title || e.entity_id,
            webm: ctx.cameraPreferWebmPlayer(attrs),
            go2rtc: ctx.cameraSupportsGo2rtc(attrs),
        };
    });
    const entitiesAttr = esc(encodeURIComponent(JSON.stringify(entitiesPayload)));
    const mediaMarkup = entities.length
        ? `<hv-camera-carousel
                class="hyve-dashboard-card__camera-player"
                entities="${entitiesAttr}"
                mode="${esc(mode === 'live' ? 'live' : 'snapshot')}"
                interval="${interval}"
                default-audio="${defaultAudio ? 'true' : 'false'}"
                default-mic="${defaultMic ? 'true' : 'false'}"
                preload="${preload ? 'true' : 'false'}"
                preload-scope="${esc(preloadScope)}"
                index="0"></hv-camera-carousel>`
        : `<div class="hyve-dashboard-card__camera-placeholder"><i class="fas fa-video-slash"></i></div>`;
    return `
        <article ${ctx.widgetDragAttrs(widget)}
            class="hyve-dashboard-card hyve-dashboard-card--camera ${ctx.widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${editMode ? 'true' : 'false'}"
            data-entity-id="${esc(entityId)}"
            data-camera-mode="${esc(mode)}"
            data-camera-player="${mode === 'live' ? 'live' : 'snapshot'}"
            data-camera-refresh="${interval}">
            <div class="hyve-dashboard-card__camera-frame">
                ${mediaMarkup}
            </div>
            ${ctx.widgetEditControls(widget)}
        </article>`;
}

export function renderPictureCard(widget, ctx) {
    const editMode = ctx.getEditMode();
    const esc = ctx.escapeHtml;
    const wid = esc(widget.id || '');
    return `
        <article ${ctx.widgetDragAttrs(widget)}
            class="hyve-dashboard-card hyve-dashboard-card--camera ${ctx.widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${editMode ? 'true' : 'false'}"
            data-entity-id="${esc(widget.entity_id || '')}">
            <hv-card-picture class="hv-card-mount" data-hv-widget-id="${wid}" style="display:contents"></hv-card-picture>
            ${ctx.widgetEditControls(widget)}
        </article>`;
}

export function renderLightCard(widget, ctx) {
    const editMode = ctx.getEditMode();
    const clickable = !editMode && widget.controllable !== false && widget.available !== false;
    const cardActionAttrs = clickable
        ? `role="button" tabindex="0" data-dash-action="cardActivate" data-dash-action-key="cardActivate" data-widget-id="${ctx.escapeHtml(widget.id)}"`
        : '';
    widget._edit_mode = !!editMode;
    return `
        <article ${ctx.widgetDragAttrs(widget)} ${cardActionAttrs}
            class="hyve-dashboard-card hyve-dashboard-card--light ${ctx.widgetSizeClass(widget)}"
            data-clickable="${clickable ? 'true' : 'false'}"
            data-edit="${editMode ? 'true' : 'false'}">
            ${ctx.renderCardElement(widget)}
            ${ctx.widgetEditControls(widget)}
        </article>`;
}

export function renderSensorCard(widget, ctx) {
    const editMode = ctx.getEditMode();
    return `
        <article ${ctx.widgetDragAttrs(widget)}
            class="hyve-dashboard-card hyve-dashboard-card--sensor ${ctx.widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${editMode ? 'true' : 'false'}"
            data-unavailable="${widget.available === false ? 'true' : 'false'}">
            ${ctx.renderCardElement(widget)}
            ${ctx.widgetEditControls(widget)}
        </article>`;
}

export function renderGaugeCard(widget, ctx) {
    const editMode = ctx.getEditMode();
    return `
        <article ${ctx.widgetDragAttrs(widget)}
            class="hyve-dashboard-card hyve-dashboard-card--gauge ${ctx.widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${editMode ? 'true' : 'false'}"
            data-unavailable="${widget.available === false ? 'true' : 'false'}">
            ${ctx.renderCardElement(widget)}
            ${ctx.widgetEditControls(widget)}
        </article>`;
}

export function renderLockCard(widget, ctx) {
    const editMode = ctx.getEditMode();
    widget._edit_mode = !!editMode;
    return `
        <article ${ctx.widgetDragAttrs(widget)}
            class="hyve-dashboard-card hyve-dashboard-card--lock ${ctx.widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${editMode ? 'true' : 'false'}">
            ${ctx.renderCardElement(widget)}
            ${ctx.widgetEditControls(widget)}
        </article>`;
}

export function renderVacuumCard(widget, ctx) {
    const editMode = ctx.getEditMode();
    widget._edit_mode = !!editMode;
    return `
        <article ${ctx.widgetDragAttrs(widget)}
            class="hyve-dashboard-card hyve-dashboard-card--vacuum ${ctx.widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${editMode ? 'true' : 'false'}">
            ${ctx.renderCardElement(widget)}
            ${ctx.widgetEditControls(widget)}
        </article>`;
}

export function renderWeatherSimpleCard(widget, ctx) {
    const editMode = ctx.getEditMode();
    return `
        <article ${ctx.widgetDragAttrs(widget)}
            class="hyve-dashboard-card ${ctx.widgetSizeClass(widget)}"
            data-on="true"
            data-clickable="false"
            data-edit="${editMode ? 'true' : 'false'}"
            data-unavailable="${widget.available === false ? 'true' : 'false'}">
            ${ctx.renderCardElement(widget)}
            ${ctx.widgetEditControls(widget)}
        </article>`;
}

export function renderWeatherRichCard(widget, ctx) {
    const editMode = ctx.getEditMode();
    widget._span = ctx.widgetSpan(widget);
    const span = widget._span;
    const compactClass = span.row <= 1 ? ' hyve-dashboard-card--weather-rich-compact' : '';
    return `
        <article ${ctx.widgetDragAttrs(widget)}
            class="hyve-dashboard-card hyve-dashboard-card--weather-rich${compactClass} ${ctx.widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${editMode ? 'true' : 'false'}">
            ${ctx.renderCardElement(widget)}
            ${ctx.widgetEditControls(widget)}
        </article>`;
}

export function renderFusionSolarCard(widget, ctx) {
    const editMode = ctx.getEditMode();
    widget._span = ctx.widgetSpan(widget);
    const compactClass = widget._span.row <= 1 ? ' hyve-dashboard-card--fusion-solar-compact' : '';
    return `
        <article ${ctx.widgetDragAttrs(widget)}
            class="hyve-dashboard-card hyve-dashboard-card--fusion-solar${compactClass} ${ctx.widgetSizeClass(widget)}"
            data-clickable="false"
            data-edit="${editMode ? 'true' : 'false'}">
            ${ctx.renderCardElement(widget)}
            ${ctx.widgetEditControls(widget)}
        </article>`;
}
