/**
 * Sortable.js load/setup/teardown and panel grid span sync.
 */

import { loadScriptOnce } from '../../utils.js';
import { SECTION_COLS } from '../constants.js';
import {
    dragResizeState,
    _asHTMLElement,
    _eventPoint,
    findWidget,
    getCache,
    getEditMode,
    panelColSpan,
    widgetSpan,
} from './shared.js';
import {
    _readGridGeometry,
    _cardCurrentPosition,
    _pointerToGridCell,
    _positionDashboardDropGhost,
    _dashboardPanelSpan,
    _dashboardPanelRenderedRowSpan,
} from './grid_geometry.js';
import { commitDashboardWidgetMove } from './card_drag.js';
import type { DashboardPanel } from '../../types/dashboard.js';
import type {
    DashboardMoveState,
    DashboardPanelLayoutItem,
    DashboardSortableState,
    SortableConstructor,
    SortableEvent,
    SortableInstance,
    SortableOptions,
} from '../../types/drag_resize.js';

let _sortables: DashboardSortable[] = [];
let _sortableState: DashboardSortableState | null = null;
let _sortableLoadPromise: Promise<SortableConstructor | undefined> | null = null;

function _sortableAvailable() {
    return typeof window !== 'undefined' && !!window.Sortable;
}

function _ensureSortableLoaded() {
    if (_sortableAvailable()) return Promise.resolve(window.Sortable);
    if (!_sortableLoadPromise) {
        _sortableLoadPromise = loadScriptOnce('/static/vendor/sortable.min.js')
            .then(() => window.Sortable)
            .catch((err) => {
                _sortableLoadPromise = null;
                throw err;
            });
    }
    return _sortableLoadPromise;
}

class DashboardSortable {
    element: HTMLElement;
    sortable: SortableInstance;

    constructor(element: HTMLElement, options: SortableOptions = {}) {
        this.element = element;
        this.sortable = new (window.Sortable as SortableConstructor)(element, {
            group: { name: 'dashboard-card', pull: true, put: true },
            draggable: '[data-dashboard-widget-id]',
            animation: 180,
            easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
            delay: 100,
            delayOnTouchOnly: true,
            invertSwap: true,
            invertedSwapThreshold: 0.7,
            swapThreshold: 0.65,
            fallbackOnBody: true,
            forceFallback: true,
            fallbackTolerance: 4,
            ghostClass: 'dashboard-sortable-ghost',
            chosenClass: 'dashboard-sortable-chosen',
            dragClass: 'dashboard-sortable-drag',
            filter: 'button, input, textarea, select, .hyve-dashboard-card__edit, .hyve-dashboard-card__resize',
            preventOnFilter: false,
            ...options,
        });
    }

    destroy() {
        this.sortable?.destroy?.();
    }
}

export function teardownDashboardSortables() {
    _sortables.forEach(controller => controller.destroy());
    _sortables = [];
    _unbindDashboardSortableTracking();
    document.documentElement.removeAttribute('data-dashboard-dragging');
    document.documentElement.removeAttribute('data-dashboard-resizing');
    document.querySelectorAll('[data-drag-source="true"]').forEach(card => card.removeAttribute('data-drag-source'));
    document.querySelectorAll('.dashboard-panel[data-drag-target="true"]').forEach(panel => panel.removeAttribute('data-drag-target'));
    document.querySelectorAll('.dashboard-panel__drop-ghost').forEach(ghost => ghost.remove());
    _sortableState = null;
}

export function setupDashboardSortables() {
    if (!getEditMode()) return;
    // The custom pointer drag keeps CSS grid placement stable while dragging.
    return;
    if (!_sortableAvailable()) {
        _ensureSortableLoaded()
            .then(() => setupDashboardSortables())
            .catch((err: unknown) => console.warn('Sortable load failed', err));
        return;
    }
    const grids = Array.from(document.querySelectorAll('[data-panel-grid]'));
    _sortables = grids.map(grid => new DashboardSortable(grid as HTMLElement, {
        onStart: _handleDashboardSortableStart,
        onMove: _handleDashboardSortableMove,
        onEnd: _handleDashboardSortableEnd,
    }));
}

export function syncDashboardPanelGridSpans() {
    const stack = document.querySelector('.dashboard-panels-stack');
    if (!stack) return;
    const sectionEls = Array.from(stack.querySelectorAll('.dashboard-panel[data-panel-id]')) as HTMLElement[];
    if (!sectionEls.length) return;

    const geom = _readGridGeometry(stack);
    const items: Array<{ el: HTMLElement; panel: DashboardPanel; id: string | null; colSpan: number; rowSpan: number }> = [];
    for (const el of sectionEls) {
        const id = el.getAttribute('data-panel-id') ?? '';
        const panel = (getCache().panels || []).find((p: DashboardPanel) => String(p?.id || '') === id);
        if (!panel) continue;
        const colSpan = panelColSpan(panel);
        const rowSpan = _dashboardPanelRenderedRowSpan(el, geom, Number(panel.row_span) || 1);
        panel.row_span = rowSpan;
        el.style.setProperty('--panel-row-span', String(rowSpan));
        items.push({ el, panel, id, colSpan, rowSpan });
    }

    // Below the free-grid breakpoint sections stack single-column via CSS.
    if (!window.matchMedia('(min-width: 1024px)').matches) return;

    const cols = SECTION_COLS;
    const occupied: boolean[][] = [];
    const isFree = (colStart: number, rowStart: number, colSpan: number, rowSpan: number) => {
        for (let r = rowStart; r < rowStart + rowSpan; r++) {
            for (let c = colStart; c < colStart + colSpan; c++) {
                if (c < 1 || c > cols) return false;
                if (occupied[r] && occupied[r][c]) return false;
            }
        }
        return true;
    };
    const mark = (colStart: number, rowStart: number, colSpan: number, rowSpan: number) => {
        for (let r = rowStart; r < rowStart + rowSpan; r++) {
            if (!occupied[r]) occupied[r] = [];
            for (let c = colStart; c < colStart + colSpan; c++) occupied[r][c] = true;
        }
    };

    // Split into positioned sections (with stored col/row anchors) and floating
    // ones (new / never placed). Positioned sections are reserved first so they
    // keep the exact spot the user dropped them in; the section that was just
    // dragged wins ties (it claims its slot, neighbours reflow around it).
    const enriched = items.map((item, index) => {
        const span = _dashboardPanelSpan(item.panel);
        return { ...item, index, anchorCol: span.colStart, anchorRow: span.rowStart };
    });
    const positioned = enriched
        .filter(it => it.anchorCol != null && it.anchorRow != null)
        .sort((a, b) => {
            const aP = a.id === dragResizeState.panelLayoutPriorityId ? 0 : 1;
            const bP = b.id === dragResizeState.panelLayoutPriorityId ? 0 : 1;
            if (aP !== bP) return aP - bP;
            return ((a.anchorRow ?? 0) - (b.anchorRow ?? 0)) || ((a.anchorCol ?? 0) - (b.anchorCol ?? 0)) || (a.index - b.index);
        });
    const floating = enriched.filter(it => it.anchorCol == null || it.anchorRow == null);

    let maxRow = 1;
    const MAX_ROWS = 5000;
    const place = (item: DashboardPanelLayoutItem, preferredCol: number | null, startRow: number) => {
        const colSpan = Math.max(1, Math.min(item.colSpan, cols));
        let placedCol = preferredCol || 1;
        let placedRow = Math.max(1, startRow);
        let done = false;
        for (let row = placedRow; !done && row < MAX_ROWS; row++) {
            const candidates = preferredCol != null
                ? [Math.max(1, Math.min(preferredCol, cols - colSpan + 1))]
                : Array.from({ length: cols - colSpan + 1 }, (_, i) => i + 1);
            for (const c of candidates) {
                if (isFree(c, row, colSpan, item.rowSpan)) {
                    placedCol = c; placedRow = row; done = true; break;
                }
            }
        }
        mark(placedCol, placedRow, colSpan, item.rowSpan);
        maxRow = Math.max(maxRow, placedRow + item.rowSpan);
        item.panel.col_start = placedCol;
        item.panel.row_start = placedRow;
        item.el.style.setProperty('--panel-col-start', String(placedCol));
        item.el.style.setProperty('--panel-col-span', String(colSpan));
        item.el.style.setProperty('--panel-row-start', String(placedRow));
    };

    // Positioned: honor the dropped row literally (gaps allowed in a free grid).
    for (const item of positioned) place(item, item.anchorCol ?? null, item.anchorRow ?? 1);
    // Floating: first free top-left slot.
    for (const item of floating) place(item, null, 1);

    // Keep the "add section" button parked below everything else.
    const addBtn = stack.querySelector('.dashboard-panel--add-section');
    if (addBtn) {
        (addBtn as HTMLElement).style.setProperty('--panel-col-start', '1');
        (addBtn as HTMLElement).style.setProperty('--panel-col-span', '1');
        (addBtn as HTMLElement).style.setProperty('--panel-row-start', String(maxRow));
        (addBtn as HTMLElement).style.setProperty('--panel-row-span', '2');
    }
}

function _bindDashboardSortableTracking() {
    document.addEventListener('pointermove', _handleDashboardSortablePointerMove, { passive: true });
    document.addEventListener('mousemove', _handleDashboardSortablePointerMove, { passive: true });
    document.addEventListener('touchmove', _handleDashboardSortablePointerMove, { passive: true });
}

function _unbindDashboardSortableTracking() {
    document.removeEventListener('pointermove', _handleDashboardSortablePointerMove);
    document.removeEventListener('mousemove', _handleDashboardSortablePointerMove);
    document.removeEventListener('touchmove', _handleDashboardSortablePointerMove);
}

function _handleDashboardSortablePointerMove(event: Event) {
    _updateDashboardSortableTarget(event);
}

function _gridAtPoint(clientX: number, clientY: number, fallbackGrid: Element | null | undefined) {
    const elements = document.elementsFromPoint(clientX, clientY);
    for (const element of elements) {
        const grid = element.closest?.('[data-panel-grid]');
        if (grid) return grid;
    }
    return fallbackGrid;
}

function _handleDashboardSortableStart(evt: SortableEvent) {
    if (!getEditMode()) return;
    const card = evt.item;
    const widgetId = card?.getAttribute('data-dashboard-widget-id') || '';
    const grid = _asHTMLElement(evt.from?.closest?.('[data-panel-grid]') || card?.closest?.('[data-panel-grid]') || null);
    const widget = widgetId ? findWidget(widgetId) : null;
    if (!card || !grid || !widget) return;

    const span = widgetSpan(widget);
    const geom = _readGridGeometry(grid);
    if (!span.colStart || !span.rowStart) {
        const current = _cardCurrentPosition(card, grid, geom, span);
        widget.col_start = current.col;
        widget.row_start = current.row;
        span.colStart = current.col;
        span.rowStart = current.row;
    }

    const cardRect = card.getBoundingClientRect();
    const point = _eventPoint(evt.originalEvent) || {
        x: cardRect.left + cardRect.width / 2,
        y: cardRect.top + cardRect.height / 2,
    };
    const ghost = document.createElement('div');
    ghost.className = 'dashboard-panel__drop-ghost dashboard-panel__drop-ghost--sortable';
    _positionDashboardDropGhost(ghost, geom, span.colStart ?? 1, span.rowStart ?? 1, span);
    grid.appendChild(ghost);
    card.setAttribute('data-drag-source', 'true');
    document.documentElement.setAttribute('data-dashboard-dragging', 'true');
    grid.closest('.dashboard-panel')?.setAttribute('data-drag-target', 'true');

    _sortableState = {
        widgetId: String(widgetId),
        widget,
        card,
        ghost,
        span,
        sourceGrid: _asHTMLElement(grid)!,
        sourcePanelId: grid.getAttribute('data-panel-grid') ?? '',
        targetGrid: _asHTMLElement(grid)!,
        targetPanelId: grid.getAttribute('data-panel-grid') ?? '',
        targetCol: span.colStart ?? 1,
        targetRow: span.rowStart ?? 1,
        startCol: span.colStart ?? 1,
        startRow: span.rowStart ?? 1,
        pointerOffsetX: Math.max(0, Math.min(cardRect.width, point.x - cardRect.left)),
        pointerOffsetY: Math.max(0, Math.min(cardRect.height, point.y - cardRect.top)),
        moved: false,
    };

    _bindDashboardSortableTracking();
}

function _updateDashboardSortableTarget(event: Event | undefined | null) {
    const st = _sortableState;
    const point = _eventPoint(event);
    if (!st || !point) return;

    let grid = _gridAtPoint(point.x, point.y, st.targetGrid || st.sourceGrid);
    if (!grid) grid = st.sourceGrid;
    if (!grid) grid = st.sourceGrid;
    if (grid !== st.targetGrid) {
        st.ghost.remove();
        grid.appendChild(st.ghost);
        document.querySelectorAll('.dashboard-panel[data-drag-target="true"]').forEach(panel => panel.removeAttribute('data-drag-target'));
        grid.closest('.dashboard-panel')?.setAttribute('data-drag-target', 'true');
        st.targetGrid = _asHTMLElement(grid) ?? st.sourceGrid;
        st.targetPanelId = grid.getAttribute('data-panel-grid') ?? '';
    }

    const geom = _readGridGeometry(st.targetGrid);
    const cell = _pointerToGridCell(
        st.targetGrid,
        geom,
        point.x,
        point.y,
        st.span,
        st.pointerOffsetX,
        st.pointerOffsetY
    );
    st.targetCol = cell.col;
    st.targetRow = cell.row;
    st.moved = true;
    _positionDashboardDropGhost(st.ghost, geom, cell.col, cell.row, st.span);
}

function _handleDashboardSortableMove(evt: SortableEvent) {
    _updateDashboardSortableTarget(evt.originalEvent);
    return true;
}

async function _handleDashboardSortableEnd(evt: SortableEvent) {
    const st = _sortableState;
    if (!st) return;
    _updateDashboardSortableTarget(evt.originalEvent);
    _unbindDashboardSortableTracking();
    _sortableState = null;

    st.ghost.remove();
    st.card?.removeAttribute('data-drag-source');
    document.documentElement.removeAttribute('data-dashboard-dragging');
    document.querySelectorAll('.dashboard-panel[data-drag-target="true"]').forEach(panel => panel.removeAttribute('data-drag-target'));

    const samePos = st.targetCol === st.startCol && st.targetRow === st.startRow;
    const samePanel = st.targetPanelId === st.sourcePanelId;
    if (!st.moved || (samePos && samePanel)) return;

    await commitDashboardWidgetMove(st as unknown as DashboardMoveState);
}
