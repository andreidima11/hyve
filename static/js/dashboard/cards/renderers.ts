/**
 * Dashboard widget card HTML renderers (Hyveview outer article shell).
 * Each function receives (widget, ctx) where ctx is built by widget_cards.js.
 */

import * as HVBridge from '/static/hyveview/bridge.js';
import {
    cameraAutoplayEnabled,
    cameraEntityIdIsMammotionWebrtc,
    cameraIsMammotionLive,
} from '../../camera_live.js';
import type { DashboardCache, DashboardWidget, DashboardWidgetSpan } from '../../types/dashboard.js';
import type { HyveEntity } from '../../types/entity.js';

export interface CardRenderCtx {
    renderer?: string;
    getEditMode: () => boolean;
    widgetDragAttrs: (widget: DashboardWidget) => string;
    widgetEditControls: (widget: DashboardWidget) => string;
    widgetSizeClass: (widget: DashboardWidget) => string;
    widgetSpan: (widget: DashboardWidget) => DashboardWidgetSpan;
    widgetRenderer: (widget: DashboardWidget) => string;
    escapeHtml: (value: unknown) => string;
    stateOn: (state: string) => boolean;
    controlVisuallyPending: (widgetId?: string) => boolean;
    renderCardElement: (widget: DashboardWidget) => string;
    widgetTitle: (widget: DashboardWidget, opts?: { entityId?: string; entityName?: string }) => string;
    getCache: () => DashboardCache;
    cameraPreferWebmPlayer: (attrs: Record<string, unknown>) => boolean;
    cameraSupportsGo2rtc: (attrs: Record<string, unknown>) => boolean;
    cameraIsAgoraMammotion: (attrs: Record<string, unknown>) => boolean;
    interactive?: boolean;
}

export interface CameraEntityRef {
    entity_id: string;
    title: string;
    subtitle: string;
}

export function renderLabelCard(widget: DashboardWidget, ctx: CardRenderCtx): string {
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

export function renderTileCard(
    widget: DashboardWidget,
    ctx: CardRenderCtx,
    opts: { interactive?: boolean } = {},
): string {
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

export function cameraCardMode(widget: DashboardWidget): 'live' | 'snapshots' {
    const config = widget?.config && typeof widget.config === 'object'
        ? widget.config as Record<string, unknown>
        : {};
    const mode = String(config.camera_mode || widget?.camera_mode || '').trim().toLowerCase();
    return mode === 'live' ? 'live' : 'snapshots';
}

export function cameraWidgetEntities(widget: DashboardWidget, ctx: CardRenderCtx): CameraEntityRef[] {
    const cfg = widget?.config && typeof widget.config === 'object'
        ? widget.config as Record<string, unknown>
        : {};
    const raw = Array.isArray(cfg.entities) ? cfg.entities : [];
    const fromConfig = raw.map((e: unknown) => {
        if (typeof e === 'string') return { entity_id: e, title: '', subtitle: '' };
        const row = e as Record<string, unknown>;
        return {
            entity_id: String(row?.entity_id || '').trim(),
            title: String(row?.title || '').trim(),
            subtitle: String(row?.subtitle || '').trim(),
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

export function renderCameraCard(widget: DashboardWidget, ctx: CardRenderCtx): string {
    const editMode = ctx.getEditMode();
    const entities = cameraWidgetEntities(widget, ctx);
    const primary = entities[0] || { entity_id: '', title: '', subtitle: '' };
    const entityId = String(primary.entity_id || widget.entity_id || '');
    const title = widget.title || primary.title || widget.entity_name || entityId;
    const mode = cameraCardMode(widget);
    const cfg = widget?.config && typeof widget.config === 'object'
        ? widget.config as Record<string, unknown>
        : {};
    const interval = Math.max(2, Number(cfg.refresh_interval || cfg.interval || 10));
    const defaultAudio = !!cfg.default_audio;
    const defaultMic = !!cfg.default_microphone;
    const preload = !!cfg.preload;
    const preloadScope = cfg.preload_scope === 'all' ? 'all' : 'adjacent';
    const esc = ctx.escapeHtml;
    const entitiesPayload = entities.map((e) => {
        const live = (ctx.getCache()?.available_entities || []).find(
            (x: HyveEntity) => x.entity_id === e.entity_id,
        );
        const attrs = live?.attributes || {};
        const agora = cameraIsMammotionLive(e.entity_id, attrs);
        return {
            entity_id: e.entity_id,
            title: e.title || e.entity_id,
            webm: ctx.cameraPreferWebmPlayer(attrs as Record<string, unknown>),
            go2rtc: ctx.cameraSupportsGo2rtc(attrs as Record<string, unknown>),
            agora,
        };
    });
    const entitiesAttr = esc(encodeURIComponent(JSON.stringify(entitiesPayload)));
    const mammotionOnly = entitiesPayload.length > 0
        && entitiesPayload.every((e) => e.agora || cameraEntityIdIsMammotionWebrtc(e.entity_id));
    const liveMode = mode === 'live';
    const autoplay = cameraAutoplayEnabled(cfg, { liveMode, mammotionOnly });
    let mediaMarkup = '';
    if (!entities.length) {
        mediaMarkup = `<div class="hyve-dashboard-card__camera-placeholder"><i class="fas fa-video-slash"></i></div>`;
    } else if (mammotionOnly && entities.length === 1) {
        const ent = entitiesPayload[0];
        mediaMarkup = `<hv-mammotion-camera
                class="hyve-dashboard-card__camera-player hv-camera-carousel__stream--agora"
                entity="${esc(ent.entity_id)}"
                alt="${esc(ent.title || ent.entity_id)}"
                autoplay="${autoplay ? 'true' : 'false'}"></hv-mammotion-camera>`;
    } else {
        mediaMarkup = `<hv-camera-carousel
                class="hyve-dashboard-card__camera-player"
                entities="${entitiesAttr}"
                mode="${esc(liveMode ? 'live' : 'snapshot')}"
                interval="${interval}"
                default-audio="${defaultAudio ? 'true' : 'false'}"
                default-mic="${defaultMic ? 'true' : 'false'}"
                preload="${preload ? 'true' : 'false'}"
                preload-scope="${esc(preloadScope)}"
                autoplay="${autoplay ? 'true' : 'false'}"
                index="0"></hv-camera-carousel>`;
    }
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

export function renderPictureCard(widget: DashboardWidget, ctx: CardRenderCtx): string {
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

/**
 * Generic Hyveview article shell driven by package `shell` metadata (bridge registry).
 * Specialized kinds (label, tile, camera, picture, climate) keep dedicated renderers.
 */
export function renderHyveviewShell(
    widget: DashboardWidget,
    ctx: CardRenderCtx,
    opts: { interactive?: boolean } = {},
): string {
    const type = HVBridge.effectiveCardType(widget) || ctx.widgetRenderer(widget);
    const shell = HVBridge.getCardSpec(type)?.shell || {};
    const editMode = ctx.getEditMode();

    if (shell.kind === 'label') return renderLabelCard(widget, ctx);
    if (shell.kind === 'camera') return renderCameraCard(widget, ctx);
    if (shell.kind === 'picture') return renderPictureCard(widget, ctx);

    if (shell.clickable === 'tile') {
        const interactive = type !== 'info' && opts.interactive !== false;
        return renderTileCard(widget, ctx, { interactive });
    }

    const modifier = String(shell.articleClass || '').trim();
    let articleClass = 'hyve-dashboard-card';
    if (modifier && modifier !== 'hyve-dashboard-card') {
        articleClass += ` ${modifier}`;
    }
    if (shell.spanCompact) {
        const spanCompact = shell.spanCompact as { maxRow?: number; class?: string };
        widget._span = ctx.widgetSpan(widget);
        const maxRow = spanCompact.maxRow ?? 1;
        if ((widget._span as DashboardWidgetSpan).row <= maxRow) {
            articleClass += ` ${spanCompact.class}`;
        }
    }

    if (shell.editModeFlag) widget._edit_mode = !!editMode;

    let clickable = false;
    if (shell.clickable === 'controllable') {
        clickable = !editMode && widget.controllable !== false && widget.available !== false;
    } else if (shell.clickable === true) {
        clickable = !editMode;
    }

    const cardActionAttrs = clickable
        ? `role="button" tabindex="0" data-dash-action="cardActivate" data-dash-action-key="cardActivate" data-widget-id="${ctx.escapeHtml(widget.id)}"`
        : '';
    const dataOnAttr = shell.dataOn ? ` data-on="${shell.dataOn}"` : '';
    const unavailableAttr = shell.trackUnavailable
        ? ` data-unavailable="${widget.available === false ? 'true' : 'false'}"`
        : '';

    return `
        <article ${ctx.widgetDragAttrs(widget)} ${cardActionAttrs}
            class="${articleClass} ${ctx.widgetSizeClass(widget)}"${dataOnAttr}
            data-clickable="${clickable ? 'true' : 'false'}"
            data-edit="${editMode ? 'true' : 'false'}"${unavailableAttr}>
            ${ctx.renderCardElement(widget)}
            ${ctx.widgetEditControls(widget)}
        </article>`;
}
