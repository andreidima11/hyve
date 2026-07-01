/**
 * Grid geometry, collision resolution, overlap handling, and FLIP render.
 */

import { SECTION_COLS, DASHBOARD_GRID_COLS } from '../constants.js';
import {
    findWidget,
    getCache,
    isStandalonePanel,
    panelColSpan,
    renderDashboard,
    widgetSpan,
    apiCall,
    dashApiErr,
    getCurrentPageId,
} from './shared.js';
import type {
    DashboardDragRect,
    DashboardLayoutRect,
    DashboardCardPosition,
    DashboardGridCell,
    DashboardGridGeometry,
    DashboardRootLayoutItem,
    DashboardRootSwapCandidate,
    DashboardSpanInput,
} from '../../types/drag_resize.js';
import type { DashboardPanel, DashboardWidget, DashboardWidgetSpan } from '../../types/dashboard.js';

export function _readGridGeometry(gridEl: Element): DashboardGridGeometry {
    const styles = getComputedStyle(gridEl);
    const colGap = parseFloat(styles.columnGap || styles.gap || '0') || 0;
    const rowGap = parseFloat(styles.rowGap || styles.gap || '0') || 0;
    const cols = (styles.gridTemplateColumns || '').split(' ').filter(value => value && value !== 'none');
    const rows = (styles.gridTemplateRows || '').split(' ').filter(value => value && value !== 'none');
    const colCount = cols.length || 12;
    const rect = gridEl.getBoundingClientRect();
    const padLeft = parseFloat(styles.paddingLeft) || 0;
    const padTop = parseFloat(styles.paddingTop) || 0;
    const innerWidth = rect.width - padLeft - (parseFloat(styles.paddingRight) || 0);
    const colWidth = (innerWidth - colGap * (colCount - 1)) / colCount;
    const autoRowHeight = parseFloat(styles.gridAutoRows || '56') || 56;
    const rowHeight = rows.length ? Math.max(parseFloat(rows[0]) || autoRowHeight, 48) : Math.max(autoRowHeight, 48);
    return { rect, colCount, colGap, rowGap, colWidth, rowHeight, padLeft, padTop };
}

export function _visualColSpanForGrid(colSpan: number | string, geom: DashboardGridGeometry | null | undefined) {
    const parsed = parseInt(String(colSpan), 10);
    const normalized = Number.isFinite(parsed) ? parsed : SECTION_COLS;
    return Math.max(1, Math.min(normalized, geom?.colCount || SECTION_COLS));
}

export function _visualColStartForGrid(colStart: number | string, geom: DashboardGridGeometry | null | undefined, spanCol = 1) {
    const parsed = parseInt(String(colStart), 10);
    const normalized = Number.isFinite(parsed) ? parsed : 1;
    const visualSpan = _visualColSpanForGrid(spanCol, geom);
    const maxCol = Math.max(1, (geom?.colCount || SECTION_COLS) - visualSpan + 1);
    return Math.max(1, Math.min(normalized, maxCol));
}

export function _internalColStartForGrid(visualCol: number | string, geom: DashboardGridGeometry | null | undefined) {
    const parsed = parseInt(String(visualCol), 10);
    const normalized = Number.isFinite(parsed) ? parsed : 1;
    return Math.max(1, Math.min(normalized, geom?.colCount || SECTION_COLS));
}

/** Compute the (1-indexed) col_start / row_start for the dragged card. */
export function _pointerToGridCell(gridEl: Element, geom: DashboardGridGeometry, clientX: number, clientY: number, span: DashboardWidgetSpan, offsetX = 0, offsetY = 0): DashboardGridCell {
    const visualColSpan = _visualColSpanForGrid(span?.col, geom);
    const cardLeft = clientX - offsetX;
    const cardTop = clientY - offsetY;
    const x = cardLeft - geom.rect.left - geom.padLeft;
    const y = cardTop - geom.rect.top - geom.padTop;
    const colUnit = geom.colWidth + geom.colGap;
    const rowUnit = geom.rowHeight + geom.rowGap;
    let visualCol = Math.round(x / colUnit) + 1;
    let row = Math.round(y / rowUnit) + 1;
    visualCol = Math.max(1, Math.min(visualCol, geom.colCount - visualColSpan + 1));
    row = Math.max(1, row);
    return { col: _internalColStartForGrid(visualCol, geom), visualCol, row };
}

export function _positionDashboardDropGhost(ghost: HTMLElement | null, geom: DashboardGridGeometry | null | undefined, col: number | null, row: number | null, span: DashboardWidgetSpan | null | undefined) {
    if (!ghost || !geom || !span) return;
    const visualColSpan = _visualColSpanForGrid(span.col, geom);
    const visualColStart = _visualColStartForGrid(col ?? 1, geom, span.col);
    const width = geom.colWidth * visualColSpan + geom.colGap * Math.max(0, visualColSpan - 1);
    const height = geom.rowHeight * span.row + geom.rowGap * Math.max(0, span.row - 1);
    const left = geom.padLeft + (visualColStart - 1) * (geom.colWidth + geom.colGap);
    const top = geom.padTop + ((row ?? 1) - 1) * (geom.rowHeight + geom.rowGap);
    ghost.dataset.size = `${visualColSpan}/${SECTION_COLS}`;
    ghost.dataset.rows = String(span.row || 1);
    ghost.style.width = `${width}px`;
    ghost.style.height = `${height}px`;
    ghost.style.transform = `translate3d(${left}px, ${top}px, 0)`;
}

function _stackPixelAnchorForCell(
    stack: Element,
    geom: DashboardGridGeometry,
    visualColStart: number,
    row: number,
) {
    let left: number | null = null;
    let top: number | null = null;
    for (const panel of stack.querySelectorAll<HTMLElement>('.dashboard-panel[data-panel-id]')) {
        const style = getComputedStyle(panel);
        const colStart = parseInt(String(panel.style.getPropertyValue('--panel-col-start') || style.gridColumnStart), 10);
        const rowStart = parseInt(String(panel.style.getPropertyValue('--panel-row-start') || style.gridRowStart), 10);
        const rect = panel.getBoundingClientRect();
        const relLeft = rect.left - geom.rect.left;
        const relTop = rect.top - geom.rect.top;
        if (top === null && Number.isFinite(rowStart) && rowStart === row) top = relTop;
        if (left === null && Number.isFinite(colStart) && colStart === visualColStart) left = relLeft;
        if (top !== null && left !== null) break;
    }
    return {
        left: left ?? geom.padLeft + (visualColStart - 1) * (geom.colWidth + geom.colGap),
        top: top ?? geom.padTop + (row - 1) * (geom.rowHeight + geom.rowGap),
    };
}

/** Section drop ghost: match the dragged panel's rendered size and anchor to real grid slots. */
export function _positionDashboardSectionDropGhost(
    ghost: HTMLElement | null,
    stack: Element | null,
    geom: DashboardGridGeometry | null | undefined,
    col: number | null,
    row: number | null,
    span: DashboardWidgetSpan | null | undefined,
    sourceEl: HTMLElement | null,
) {
    if (!ghost || !stack || !geom || !span) return;
    const sourceRect = sourceEl?.getBoundingClientRect();
    const visualColSpan = _visualColSpanForGrid(span.col, geom);
    const visualColStart = _visualColStartForGrid(col ?? 1, geom, span.col);
    const gridWidth = geom.colWidth * visualColSpan + geom.colGap * Math.max(0, visualColSpan - 1);
    const gridHeight = geom.rowHeight * span.row + geom.rowGap * Math.max(0, span.row - 1);
    const width = sourceRect?.width ?? gridWidth;
    const height = sourceRect?.height ?? gridHeight;
    const anchor = _stackPixelAnchorForCell(stack, geom, visualColStart, row ?? 1);
    ghost.dataset.size = `${visualColSpan}/${SECTION_COLS}`;
    ghost.dataset.rows = String(span.row || 1);
    ghost.style.width = `${width}px`;
    ghost.style.height = `${height}px`;
    ghost.style.transform = `translate3d(${anchor.left}px, ${anchor.top}px, 0)`;
}

/** Compute current grid position of a card by reverse-mapping its rect onto the grid. */
export function _cardCurrentPosition(card: Element, gridEl: Element, geom: DashboardGridGeometry, span: DashboardSpanInput): DashboardCardPosition {
    const cardRect = card.getBoundingClientRect();
    const x = cardRect.left - geom.rect.left - geom.padLeft;
    const y = cardRect.top - geom.rect.top - geom.padTop;
    const colUnit = geom.colWidth + geom.colGap;
    const rowUnit = geom.rowHeight + geom.rowGap;
    const visualColSpan = _visualColSpanForGrid(span?.col, geom);
    const visualCol = Math.max(1, Math.min(Math.round(x / colUnit) + 1, geom.colCount - visualColSpan + 1));
    const row = Math.max(1, Math.round(y / rowUnit) + 1);
    return { col: _internalColStartForGrid(visualCol, geom), visualCol, row };
}

export function _dashboardPanelRenderedRowSpan(panelEl: Element | null | undefined, geom: DashboardGridGeometry | null | undefined, fallbackRows = 1) {
    if (!panelEl || !geom) return Math.max(1, fallbackRows || 1);
    const rect = panelEl.getBoundingClientRect();
    const height = Math.max(rect.height, panelEl.scrollHeight || 0, 50);
    const rowUnit = Math.max(1, geom.rowHeight + geom.rowGap);
    return Math.max(1, Math.ceil((height + geom.rowGap) / rowUnit));
}

export function _dashboardPanelRenderedColSpan(_panelEl: Element | null | undefined, _geom: DashboardGridGeometry | null | undefined, fallbackCols: number | string = 2) {
    const parsed = parseInt(String(fallbackCols), 10);
    const span = Number.isFinite(parsed) ? parsed : 2;
    return Math.max(1, Math.min(span, SECTION_COLS));
}

export function _dashboardPanelSpan(panel: DashboardPanel) {
    const col = panelColSpan(panel);
    const rawColStart = parseInt(String(panel?.col_start ?? ''), 10);
    const rawRowStart = parseInt(String(panel?.row_start ?? ''), 10);
    const rawRowSpan = parseInt(String(panel?.row_span ?? ''), 10);
    let colStart = Number.isFinite(rawColStart) && rawColStart >= 1 ? rawColStart : null;
    if (colStart !== null) colStart = Math.max(1, Math.min(colStart, SECTION_COLS - col + 1));
    const rowStart = Number.isFinite(rawRowStart) && rawRowStart >= 1 ? rawRowStart : null;
    const row = Number.isFinite(rawRowSpan) && rawRowSpan >= 1 ? rawRowSpan : 1;
    return { col, row, colStart, rowStart };
}

export function dashboardPanelSpan(panel: DashboardPanel) {
    return _dashboardPanelSpan(panel);
}

export function _dashboardPanelElement(rootGrid: Element | null | undefined, panel: DashboardPanel) {
    if (!rootGrid || !panel) return null;
    const panelId = String(panel.id || '');
    if (!panelId) return null;
    return Array.from(rootGrid.children || []).find(el => el.matches?.(`.dashboard-panel[data-panel-id="${CSS.escape(panelId)}"]`)) || null;
}

export function _dashboardPanelRect(panel: DashboardPanel, rootGrid: Element | null | undefined) {
    const span = _dashboardPanelSpan(panel);
    let col = span.colStart;
    let row = span.rowStart;
    let rowSpan = span.row;
    const panelEl = _dashboardPanelElement(rootGrid, panel);
    if (panelEl && rootGrid) {
        const geom = _readGridGeometry(rootGrid);
        rowSpan = _dashboardPanelRenderedRowSpan(panelEl, geom, rowSpan);
        if (!col || !row) {
            const pos = _cardCurrentPosition(panelEl, rootGrid, geom, { col: span.col, row: rowSpan });
            col = col || pos.col;
            row = row || pos.row;
        }
    }
    return {
        id: String(panel.id || ''),
        col: col || 1,
        row: row || 1,
        colSpan: span.col,
        rowSpan,
    };
}

export function _dashboardRootLayoutPanels() {
    return (Array.isArray(getCache().panels) ? getCache().panels : [])
        .filter(panel => panel && !isStandalonePanel(panel) && String(panel.id || ''));
}

export function _dashboardStandalonePanel() {
    return (Array.isArray(getCache().panels) ? getCache().panels : []).find(isStandalonePanel) || null;
}

export function _dashboardRootLayoutItems(): DashboardRootLayoutItem[] {
    const items: DashboardRootLayoutItem[] = [];
    for (const panel of _dashboardRootLayoutPanels()) {
        const id = String(panel.id || '');
        if (id) items.push({ kind: 'panel' as const, id, key: `panel:${id}`, raw: panel });
    }
    const standalone = _dashboardStandalonePanel();
    for (const widget of (standalone?.widgets || [])) {
        const id = String(widget?.id || '');
        if (id) items.push({ kind: 'widget' as const, id, key: `widget:${id}`, raw: widget });
    }
    return items;
}

export function _dashboardRootItemElement(rootGrid: Element | null | undefined, item: DashboardRootLayoutItem) {
    if (!rootGrid || !item) return null;
    const children = Array.from(rootGrid.children || []);
    if (item.kind === 'panel') {
        return children.find(el => el.matches?.(`.dashboard-panel[data-panel-id="${CSS.escape(item.id)}"]`)) || null;
    }
    if (item.kind === 'widget') {
        return children.find(el => el.matches?.(`[data-dashboard-widget-id="${CSS.escape(item.id)}"]`)) || null;
    }
    return null;
}

export function _dashboardRootItemSpan(item: DashboardRootLayoutItem) {
    if (item.kind === 'panel') return _dashboardPanelSpan(item.raw as DashboardPanel);
    return widgetSpan(item.raw as DashboardWidget);
}

export function _dashboardRootItemRect(item: DashboardRootLayoutItem, rootGrid: Element | null | undefined): DashboardDragRect {
    const span = _dashboardRootItemSpan(item);
    let col = span.colStart;
    let row = span.rowStart;
    let colSpan = span.col;
    let rowSpan = span.row;
    const el = _dashboardRootItemElement(rootGrid, item);
    if (el && rootGrid) {
        const geom = _readGridGeometry(rootGrid);
        if (item.kind === 'panel') {
            colSpan = _dashboardPanelRenderedColSpan(el, geom, colSpan);
            rowSpan = _dashboardPanelRenderedRowSpan(el, geom, rowSpan);
        }
        if (!col || !row) {
            const pos = _cardCurrentPosition(el, rootGrid, geom, { col: colSpan, row: rowSpan, colStart: col, rowStart: row });
            col = col || pos.col;
            row = row || pos.row;
        }
    }
    return {
        id: item.key,
        itemKind: item.kind,
        itemId: item.id,
        col: col || 1,
        row: row || 1,
        colSpan,
        rowSpan,
    };
}

export function _findDashboardRootSwapCandidate(movingRect: DashboardDragRect, rootGrid: Element | null | undefined) {
    let best: DashboardRootSwapCandidate | null = null;
    for (const item of _dashboardRootLayoutItems()) {
        if (item.key === movingRect.id) continue;
        const rect = _dashboardRootItemRect(item, rootGrid);
        const area = _rectOverlapArea(movingRect, rect);
        if (area <= 0) continue;
        if (!best || area > best.area) best = { item, rect, area };
    }
    return best;
}

export function _resolveDashboardRootOverlaps(movingRect: DashboardDragRect, rootGrid: Element | null | undefined) {
    const rects = new Map();
    for (const item of _dashboardRootLayoutItems()) {
        if (item.key === movingRect.id) continue;
        rects.set(item.key, _dashboardRootItemRect(item, rootGrid));
    }
    const original = new Map();
    for (const [id, rect] of rects.entries()) original.set(id, { col: rect.col, row: rect.row });

    let safety = 200;
    while (safety-- > 0) {
        let collided = false;
        for (const rect of rects.values()) {
            if (_rectsOverlap(rect, movingRect)) {
                const newRow = movingRect.row + movingRect.rowSpan;
                if (newRow > rect.row) { rect.row = newRow; collided = true; }
            }
        }
        const list = Array.from(rects.values()).sort((a, b) => a.row - b.row || a.col - b.col);
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                if (_rectsOverlap(list[i], list[j])) {
                    const newRow = list[i].row + list[i].rowSpan;
                    if (newRow > list[j].row) { list[j].row = newRow; collided = true; }
                }
            }
        }
        if (!collided) break;
    }

    const changes = new Map();
    for (const [id, rect] of rects.entries()) {
        const prev = original.get(id);
        if (!prev || rect.col !== prev.col || rect.row !== prev.row) changes.set(id, rect);
    }
    return changes;
}

export function _normalizeDashboardRootLayout(rootGrid: Element | null | undefined) {
    const items = _dashboardRootLayoutItems().map(item => ({ item, rect: _dashboardRootItemRect(item, rootGrid) }));
    if (items.length < 2) return new Map();
    items.sort((a, b) => a.rect.row - b.rect.row || a.rect.col - b.rect.col);
    const original = new Map(items.map(({ item, rect }) => [item.key, { col: rect.col, row: rect.row }]));
    const placed: Array<{ item: DashboardRootLayoutItem; rect: DashboardLayoutRect }> = [];
    for (const current of items) {
        let safety = 500;
        while (safety-- > 0) {
            const hit = placed.find(placedItem => _rectsOverlap(placedItem.rect, current.rect));
            if (!hit) break;
            current.rect.row = hit.rect.row + hit.rect.rowSpan;
        }
        placed.push(current);
    }
    const changes = new Map();
    for (const { item, rect } of items) {
        const prev = original.get(item.key);
        if (!prev || rect.col !== prev.col || rect.row !== prev.row) changes.set(item.key, rect);
    }
    return changes;
}

export function _applyDashboardRootRect(rect: DashboardLayoutRect) {
    if (!rect) return;
    if (rect.itemKind === 'panel') {
        const panel = (getCache().panels || []).find(item => String(item?.id || '') === String(rect.itemId));
        if (!panel) return;
        panel.col_start = rect.col;
        panel.row_start = rect.row;
        panel.row_span = rect.rowSpan;
        return;
    }
    if (rect.itemKind === 'widget') {
        const widget = findWidget(String(rect.itemId || ''));
        if (!widget) return;
        widget.col_start = rect.col;
        widget.row_start = rect.row;
        widget.col_span = rect.colSpan;
        widget.row_span = rect.rowSpan;
    }
}

export async function _persistDashboardRootRect(rect: DashboardDragRect, pageQS = '') {
    if (!rect) return;
    if (rect.itemKind === 'panel') {
        await _persistDashboardPanelLayout(String(rect.itemId || ''), {
            col_start: rect.col,
            row_start: rect.row,
            row_span: rect.rowSpan,
        });
        return;
    }
    if (rect.itemKind === 'widget') {
        const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(String(rect.itemId || ''))}${pageQS}`, {
            method: 'PATCH',
            body: {
                col_start: rect.col,
                row_start: rect.row,
                col_span: rect.colSpan,
                row_span: rect.rowSpan,
            },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiErr(err.detail, 'dashboard.save_position_failed'));
        }
    }
}

export async function _persistDashboardPanelLayout(panelId: string, layout: Record<string, unknown>) {
    const activePageId = getCurrentPageId() || getCache().current_page_id || getCache().page_id || '';
    const params = activePageId ? `?page_id=${encodeURIComponent(activePageId)}` : '';
    const res = await apiCall(`/api/dashboard/panels/${encodeURIComponent(panelId)}/layout${params}`, {
        method: 'PATCH',
        body: {
            col_start: Number.isFinite(layout?.col_start) ? layout.col_start : null,
            row_start: Number.isFinite(layout?.row_start) ? layout.row_start : null,
            row_span: Number.isFinite(layout?.row_span) ? layout.row_span : null,
        },
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(dashApiErr(err.detail, 'dashboard.save_section_position_failed'));
    }
}

export function _resolveDashboardPanelOverlaps(movingRect: DashboardDragRect, rootGrid: Element | null | undefined) {
    const rects = new Map();
    for (const panel of _dashboardRootLayoutPanels()) {
        const id = String(panel.id || '');
        if (!id || id === movingRect.id) continue;
        rects.set(id, _dashboardPanelRect(panel, rootGrid));
    }
    const original = new Map();
    for (const [id, rect] of rects.entries()) original.set(id, rect.row);

    let safety = 200;
    while (safety-- > 0) {
        let collided = false;
        for (const rect of rects.values()) {
            if (_rectsOverlap(rect, movingRect)) {
                const newRow = movingRect.row + movingRect.rowSpan;
                if (newRow > rect.row) { rect.row = newRow; collided = true; }
            }
        }
        const list = Array.from(rects.values()).sort((a, b) => a.row - b.row || a.col - b.col);
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                if (_rectsOverlap(list[i], list[j])) {
                    const newRow = list[i].row + list[i].rowSpan;
                    if (newRow > list[j].row) { list[j].row = newRow; collided = true; }
                }
            }
        }
        if (!collided) break;
    }

    const changes = new Map();
    for (const [id, rect] of rects.entries()) {
        if (rect.row !== original.get(id)) changes.set(id, rect);
    }
    return changes;
}

/** Return a flat list of widget objects for a given panel id (cache lookup). */
export function _panelWidgets(panelId: string | null | undefined) {
    if (!panelId) {
        const panels = Array.isArray(getCache().panels) ? getCache().panels : [];
        if (panels.length === 1 && Array.isArray(panels[0].widgets)) return panels[0].widgets;
        return getCache().widgets || [];
    }
    const panel = (getCache().panels || []).find(p => String(p.id) === String(panelId));
    return (panel && panel.widgets) || [];
}

/** True when two rectangles {col,row,colSpan,rowSpan} overlap (1-indexed). */
export function _rectsOverlap(a: DashboardDragRect, b: DashboardDragRect) {
    if (!a || !b) return false;
    const ax2 = a.col + a.colSpan, ay2 = a.row + a.rowSpan;
    const bx2 = b.col + b.colSpan, by2 = b.row + b.rowSpan;
    return a.col < bx2 && b.col < ax2 && a.row < by2 && b.row < ay2;
}

export function _rectOverlapArea(a: DashboardDragRect, b: DashboardDragRect) {
    if (!_rectsOverlap(a, b)) return 0;
    const left = Math.max(a.col, b.col);
    const right = Math.min(a.col + a.colSpan, b.col + b.colSpan);
    const top = Math.max(a.row, b.row);
    const bottom = Math.min(a.row + a.rowSpan, b.row + b.rowSpan);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
}

export function _clampColStartForSpan(colStart: number | null | undefined, colSpan: number) {
    const parsedStart = parseInt(String(colStart), 10);
    const parsedSpan = parseInt(String(colSpan), 10);
    const start = Number.isFinite(parsedStart) ? parsedStart : 1;
    const span = Number.isFinite(parsedSpan) ? parsedSpan : 1;
    return Math.max(1, Math.min(start, DASHBOARD_GRID_COLS - Math.max(1, span) + 1));
}

export function _findDashboardSwapCandidate(movingRect: DashboardDragRect, panelWidgets: DashboardWidget[], panelGridEl: Element | null | undefined): import('../../types/drag_resize.js').DashboardSwapCandidate | null {
    let best: import('../../types/drag_resize.js').DashboardSwapCandidate | null = null;
    for (const widget of panelWidgets || []) {
        if (!widget || widget.id === movingRect.id) continue;
        const rect = _widgetRect(widget, panelGridEl);
        const area = _rectOverlapArea(movingRect, rect);
        if (area <= 0) continue;
        if (!best || area > best.area) best = { widget, rect, area };
    }
    return best;
}

/**
 * Build the placement rectangle for a widget. Falls back to the rendered grid
 * position for legacy widgets that don't have explicit col_start/row_start yet.
 */
export function _widgetRect(widget: DashboardWidget, panelGridEl: Element | null | undefined): DashboardDragRect {
    const span = widgetSpan(widget);
    let col = span.colStart;
    let row = span.rowStart;
    if (!col || !row) {
        if (panelGridEl) {
            const card = panelGridEl.querySelector(`[data-dashboard-widget-id="${CSS.escape(String(widget.id || ''))}"]`);
            if (card) {
                const geom = _readGridGeometry(panelGridEl);
                const pos = _cardCurrentPosition(card, panelGridEl, geom, span);
                col = pos.col;
                row = pos.row;
            }
        }
    }
    return {
        id: String(widget.id || ''),
        col: col || 1,
        row: row || 1,
        colSpan: span.col,
        rowSpan: span.row,
    };
}

/**
 * Resolve collisions in a panel by pushing widgets that overlap the moving
 * widget downward (and recursively any others they then overlap).
 * Returns Map<widgetId, {col,row,colSpan,rowSpan}> of NEW positions for any
 * widget whose row_start changed (the moving widget is not included).
 */
export function _resolveOverlaps(movingRect: DashboardDragRect, panelWidgets: DashboardWidget[], panelGridEl: Element | null | undefined) {
    const rects = new Map();
    for (const w of panelWidgets) {
        if (w.id === movingRect.id) continue;
        rects.set(w.id, _widgetRect(w, panelGridEl));
    }
    const original = new Map();
    for (const [id, r] of rects.entries()) original.set(id, r.row);

    // Iterative resolution: while any rect collides with another, push the lower
    // priority (= the one whose original row >= the conflict source's row, then
    // by current row) downward by exactly enough to clear.
    let safety = 200;
    while (safety-- > 0) {
        let collided = false;

        // First, anything that overlaps the moving widget gets pushed below it.
        for (const r of rects.values()) {
            if (_rectsOverlap(r, movingRect)) {
                const newRow = movingRect.row + movingRect.rowSpan;
                if (newRow > r.row) { r.row = newRow; collided = true; }
            }
        }
        // Then resolve internal collisions between displaced widgets.
        const list = Array.from(rects.values()).sort((a, b) => a.row - b.row || a.col - b.col);
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                if (_rectsOverlap(list[i], list[j])) {
                    const newRow = list[i].row + list[i].rowSpan;
                    if (newRow > list[j].row) { list[j].row = newRow; collided = true; }
                }
            }
        }
        if (!collided) break;
    }

    const changes = new Map();
    for (const [id, r] of rects.entries()) {
        if (r.row !== original.get(id)) changes.set(id, r);
    }
    return changes;
}

/**
 * Final pass: walk the panel sorted by (row, col) and push any widget down
 * until it no longer overlaps any earlier-placed widget. Guarantees zero
 * overlap regardless of how it was reached. Returns Map of changes.
 */
export function _normalizePanelLayout(panelWidgets: DashboardWidget[], panelGridEl: Element | null | undefined) {
    if (!panelWidgets || panelWidgets.length < 2) return new Map();
    const items = panelWidgets.map(w => ({ w, rect: _widgetRect(w, panelGridEl) }));
    items.sort((a, b) => a.rect.row - b.rect.row || a.rect.col - b.rect.col);
    const original = new Map(items.map(({ w, rect }) => [w.id, rect.row]));
    const placed: Array<{ w: DashboardWidget; rect: DashboardLayoutRect }> = [];
    for (const it of items) {
        // Push down while it overlaps anyone already placed.
        let safety = 500;
        while (safety-- > 0) {
            const hit = placed.find(p => _rectsOverlap(p.rect, it.rect));
            if (!hit) break;
            it.rect.row = hit.rect.row + hit.rect.rowSpan;
        }
        placed.push(it);
    }
    const changes = new Map();
    for (const it of items) {
        if (it.rect.row !== original.get(it.w.id)) {
            changes.set(it.w.id, it.rect);
        }
    }
    return changes;
}

// ── FLIP animations: smooth re-arrangement after layout changes ──────
export function renderDashboardWithFlip() {
    const grid = document.getElementById('dashboard-grid');
    if (!grid) { renderDashboard(); return; }
    // Capture rects of all cards before the re-render (FIRST).
    const before = new Map();
    grid.querySelectorAll<HTMLElement>('[data-dashboard-widget-id]').forEach(el => {
        before.set(`widget:${el.getAttribute('data-dashboard-widget-id')}`, el.getBoundingClientRect());
    });
    grid.querySelectorAll<HTMLElement>('.dashboard-panel[data-panel-id]').forEach(el => {
        before.set(`panel:${el.getAttribute('data-panel-id')}`, el.getBoundingClientRect());
    });
    renderDashboard();
    // After re-render, measure new positions (LAST), invert with transform, then play.
    requestAnimationFrame(() => {
        grid.querySelectorAll<HTMLElement>('[data-dashboard-widget-id]').forEach(el => {
            const id = `widget:${el.getAttribute('data-dashboard-widget-id')}`;
            const prev = before.get(id);
            if (!prev) return;
            const cur = el.getBoundingClientRect();
            const dx = prev.left - cur.left;
            const dy = prev.top - cur.top;
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
            el.setAttribute('data-flip-suppress', 'true');
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            // Force layout flush, then animate to identity.
            void el.offsetWidth;
            el.removeAttribute('data-flip-suppress');
            el.style.transform = '';
        });
        grid.querySelectorAll<HTMLElement>('.dashboard-panel[data-panel-id]').forEach(el => {
            const id = `panel:${el.getAttribute('data-panel-id')}`;
            const prev = before.get(id);
            if (!prev) return;
            const cur = el.getBoundingClientRect();
            const dx = prev.left - cur.left;
            const dy = prev.top - cur.top;
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
            el.setAttribute('data-flip-suppress', 'true');
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            // Force layout flush, then animate to identity.
            void el.offsetWidth;
            el.removeAttribute('data-flip-suppress');
            el.style.transform = '';
        });
    });
}
