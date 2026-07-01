/**
 * Dashboard widget card HTML — span, drag attrs, and card registry dispatch.
 */

import { cameraIsAgoraMammotion, cameraPreferWebmPlayer, cameraSupportsGo2rtc } from '../camera_live.js';
import { widgetTitle } from '/static/hyveview/host.js';
import { SECTION_COLS, effectivePageColumns, scaleWidgetColSpan } from './constants.js';
import { getCard } from './card_registry.js';
import { cameraWidgetEntities as cameraEntitiesHelper } from './cards/register.js';
import type { CardRenderCtx } from './cards/renderers.js';
import type {
    DashboardPanel,
    DashboardWidget,
    DashboardWidgetCardsDeps,
    DashboardWidgetSpan,
} from '../types/dashboard.js';

let _deps: DashboardWidgetCardsDeps | null = null;

function deps(): DashboardWidgetCardsDeps {
    if (!_deps) throw new Error('Dashboard widget cards not initialized');
    return _deps;
}

export function initDashboardWidgetCards(depsIn: DashboardWidgetCardsDeps): void {
    _deps = depsIn;
}

export function widgetSpan(widget: DashboardWidget): DashboardWidgetSpan {
    const d = deps();
    const cache = d.getCache();
    const pageCols = effectivePageColumns(cache?.columns);
    const renderer = d.widgetRenderer(widget);
    let col = parseInt(String(widget.col_span), 10);
    let row = parseInt(String(widget.row_span), 10);

    if (!Number.isFinite(col) || col < 1) {
        if (renderer === 'weather_rich') col = 4;
        else if (renderer === 'fusion_solar') col = 2;
        else if (renderer === 'climate' || renderer === 'gauge') col = 2;
        else if (renderer === 'camera' || renderer === 'picture') col = 2;
        else if (renderer === 'label') col = 4;
        else col = 1;
    }

    if (!Number.isFinite(row) || row < 1) {
        if (renderer === 'weather_rich') row = 2;
        else if (renderer === 'fusion_solar') row = d.dashboardDefaultRowsForType('fusion_solar');
        else if (renderer === 'climate' || renderer === 'gauge') row = 2;
        else if (renderer === 'camera' || renderer === 'picture') row = 3;
        else row = 1;
    }
    col = scaleWidgetColSpan(col, pageCols);
    row = Math.min(Math.max(row, 1), 12);

    let colStart: number | null = parseInt(String(widget.col_start), 10);
    let rowStart: number | null = parseInt(String(widget.row_start), 10);
    if (!Number.isFinite(colStart) || (colStart as number) < 1) colStart = null;
    else colStart = Math.min(Math.max(colStart as number, 1), pageCols);
    if (!Number.isFinite(rowStart) || (rowStart as number) < 1) rowStart = null;
    if (colStart !== null && (colStart + col - 1) > pageCols) {
        colStart = Math.max(1, pageCols - col + 1);
    }
    return { col, row, colStart, rowStart };
}

function widgetArrayIndex(widget: DashboardWidget): number {
    const cache = deps().getCache();
    for (const panel of (cache?.panels || [])) {
        const idx = (panel.widgets || []).indexOf(widget);
        if (idx >= 0) return idx;
    }
    return 9999;
}

export function widgetSizeStyle(widget: DashboardWidget): string {
    const { col, row, colStart, rowStart } = widgetSpan(widget);
    const colRule = colStart ? `${colStart} / span ${col}` : `span ${col}`;
    const rowRule = rowStart ? `${rowStart} / span ${row}` : `span ${row}`;
    const arrayOrder = widgetArrayIndex(widget);
    const mobileOrder = (rowStart && colStart)
        ? (rowStart * (SECTION_COLS + 1) + colStart)
        : (1000 + arrayOrder);
    return `style="--hc:${col}; --hr:${row}; grid-column: ${colRule}; grid-row: ${rowRule}; order: ${arrayOrder}; --hyve-mobile-order: ${mobileOrder};"`;
}

export function widgetSizeClass(): string {
    return '';
}

export function widgetDragAttrs(widget: DashboardWidget): string {
    const d = deps();
    const span = widgetSpan(widget);
    const sizeStyle = widgetSizeStyle(widget);
    const dragHandler = d.getEditMode()
        ? ` data-dash-pointer="widgetDrag" data-widget-id="${d.escapeHtml(widget.id)}"`
        : '';
    return d.getEditMode()
        ? `data-dashboard-widget-id="${d.escapeHtml(widget.id)}" data-dashboard-cols="${span.col}" data-dashboard-rows="${span.row}" draggable="false" ${sizeStyle}${dragHandler}`
        : `data-dashboard-widget-id="${d.escapeHtml(widget.id)}" data-dashboard-cols="${span.col}" data-dashboard-rows="${span.row}" draggable="false" ${sizeStyle}`;
}

export function widgetEditControls(widget: DashboardWidget): string {
    const d = deps();
    if (!d.getEditMode()) return '';
    return `
        <div class="hyve-dashboard-card__edit">
            <button type="button" data-dash-action="editWidget" data-dash-stop-propagation="true" data-widget-id="${d.escapeHtml(widget.id)}" aria-label="${d.escapeHtml(d.t('dashboard.aria.edit'))}"><i class="fas fa-pen text-[10px]"></i></button>
            <button type="button" class="is-danger" data-dash-action="removeWidget" data-dash-stop-propagation="true" data-widget-id="${d.escapeHtml(widget.id)}" aria-label="${d.escapeHtml(d.t('dashboard.aria.delete_widget'))}"><i class="fas fa-trash text-[10px]"></i></button>
        </div>`;
}

export function dashboardPanelColSpan(_panel: DashboardPanel): number {
    return SECTION_COLS;
}

export function buildCardRenderCtx(renderer: string, extra: Record<string, unknown> = {}): CardRenderCtx {
    const d = deps();
    return {
        renderer,
        getEditMode: d.getEditMode,
        widgetDragAttrs,
        widgetEditControls,
        widgetSizeClass,
        widgetSpan,
        widgetRenderer: d.widgetRenderer,
        escapeHtml: d.escapeHtml,
        stateOn: d.stateOn,
        controlVisuallyPending: d.controlVisuallyPending,
        renderCardElement: (w: DashboardWidget) => d.HVBridge.renderCardElement(w),
        widgetTitle,
        getCache: d.getCache,
        cameraPreferWebmPlayer,
        cameraSupportsGo2rtc,
        cameraIsAgoraMammotion,
        ...extra,
    } as CardRenderCtx;
}

export function cameraWidgetEntities(widget: DashboardWidget): ReturnType<typeof cameraEntitiesHelper> {
    const d = deps();
    return cameraEntitiesHelper(widget, buildCardRenderCtx(d.widgetRenderer(widget)));
}

export function renderWidgetCard(widget: DashboardWidget): string {
    const d = deps();
    const renderer = d.widgetRenderer(widget);
    const registered = getCard(renderer) || getCard('entity');
    if (!registered?.render) return '';
    return registered.render(widget, buildCardRenderCtx(renderer));
}

export function renderWidgetCardForPreview(widget: DashboardWidget): string {
    const d = deps();
    return d.withoutEditMode(() => renderWidgetCard(widget));
}
