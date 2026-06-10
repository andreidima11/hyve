/**
 * Dashboard drag, drop, resize, and Sortable.js grid layout.
 */
import { loadScriptOnce } from '../utils.js';
import { canEditDashboard, requireDashboardEditAccess } from './edit_access.js';
import { SECTION_COLS, DASHBOARD_GRID_COLS, DASHBOARD_STANDALONE_PANEL_ID } from './constants.js';
import { dashApiError } from './helpers.js';
function _errMsg(err) {
    if (err instanceof Error)
        return err.message;
    return String(err ?? '');
}
function _asPointerEvent(event) {
    return event;
}
function _asHTMLElement(el) {
    return el instanceof HTMLElement ? el : null;
}
function _gridEl(el) {
    const node = el?.closest?.('[data-panel-grid]') ?? el;
    return _asHTMLElement(node);
}
let _deps = null;
let _sortables = [];
let _sortableState = null;
let _moveState = null;
let _panelDragState = null;
let _panelLayoutPriorityId = null;
let _resizeState = null;
let _panelDelay = null;
let _sortableLoadPromise = null;
export function initDashboardDragResize(deps) {
    _deps = deps;
}
function deps() {
    if (!_deps)
        throw new Error('Dashboard drag/resize not initialized');
    return _deps;
}
function getCache() { return deps().getCache(); }
function getCurrentPageId() { return deps().getCurrentPageId(); }
function getEditMode() { return deps().getEditMode(); }
function findWidget(id) { return deps().findWidget(id); }
function widgetSpan(w) { return deps().widgetSpan(w); }
function panelColSpan(p) { return deps().panelColSpan(p); }
function isStandalonePanel(p) { return deps().isStandalonePanel(p); }
function ensureStandalonePanelLocal() { return deps().ensureStandalonePanelLocal(); }
function renderDashboard() { return deps().renderDashboard(); }
function loadDashboard() { return deps().loadDashboard(); }
function readDashboardSectionFallback() { return deps().readDashboardSectionFallback(); }
function writeDashboardSectionFallback(s) { return deps().writeDashboardSectionFallback(s); }
function apiCall(url, options) { return deps().apiCall(url, options); }
function t(key, params) { return deps().t(key, params); }
function showToast(message, type) { return deps().showToast(message, type); }
function dashApiErr(d, k) { return dashApiError(d, k); }
function _sortableAvailable() {
    return typeof window !== 'undefined' && !!window.Sortable;
}
function _ensureSortableLoaded() {
    if (_sortableAvailable())
        return Promise.resolve(window.Sortable);
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
function _nestedInteractiveTarget(event) {
    const target = event?.target;
    if (!target?.closest)
        return null;
    const interactive = target.closest('button, a, input, select, textarea, label, [role="button"]');
    if (!interactive)
        return null;
    const current = event?.currentTarget;
    if (current && interactive === current)
        return null;
    return interactive;
}
// --- sync ---
export function syncDashboardPanelGridSpans() {
    const stack = document.querySelector('.dashboard-panels-stack');
    if (!stack)
        return;
    const sectionEls = Array.from(stack.querySelectorAll('.dashboard-panel[data-panel-id]'));
    if (!sectionEls.length)
        return;
    const geom = _readGridGeometry(stack);
    const items = [];
    for (const el of sectionEls) {
        const id = el.getAttribute('data-panel-id') ?? '';
        const panel = (getCache().panels || []).find((p) => String(p?.id || '') === id);
        if (!panel)
            continue;
        const colSpan = panelColSpan(panel);
        const rowSpan = _dashboardPanelRenderedRowSpan(el, geom, Number(panel.row_span) || 1);
        panel.row_span = rowSpan;
        el.style.setProperty('--panel-row-span', String(rowSpan));
        items.push({ el, panel, id, colSpan, rowSpan });
    }
    // Below the free-grid breakpoint sections stack single-column via CSS.
    if (!window.matchMedia('(min-width: 1024px)').matches)
        return;
    const cols = SECTION_COLS;
    const occupied = [];
    const isFree = (colStart, rowStart, colSpan, rowSpan) => {
        for (let r = rowStart; r < rowStart + rowSpan; r++) {
            for (let c = colStart; c < colStart + colSpan; c++) {
                if (c < 1 || c > cols)
                    return false;
                if (occupied[r] && occupied[r][c])
                    return false;
            }
        }
        return true;
    };
    const mark = (colStart, rowStart, colSpan, rowSpan) => {
        for (let r = rowStart; r < rowStart + rowSpan; r++) {
            if (!occupied[r])
                occupied[r] = [];
            for (let c = colStart; c < colStart + colSpan; c++)
                occupied[r][c] = true;
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
        const aP = a.id === _panelLayoutPriorityId ? 0 : 1;
        const bP = b.id === _panelLayoutPriorityId ? 0 : 1;
        if (aP !== bP)
            return aP - bP;
        return ((a.anchorRow ?? 0) - (b.anchorRow ?? 0)) || ((a.anchorCol ?? 0) - (b.anchorCol ?? 0)) || (a.index - b.index);
    });
    const floating = enriched.filter(it => it.anchorCol == null || it.anchorRow == null);
    let maxRow = 1;
    const MAX_ROWS = 5000;
    const place = (item, preferredCol, startRow) => {
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
                    placedCol = c;
                    placedRow = row;
                    done = true;
                    break;
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
    for (const item of positioned)
        place(item, item.anchorCol ?? null, item.anchorRow ?? 1);
    // Floating: first free top-left slot.
    for (const item of floating)
        place(item, null, 1);
    // Keep the "add section" button parked below everything else.
    const addBtn = stack.querySelector('.dashboard-panel--add-section');
    if (addBtn) {
        addBtn.style.setProperty('--panel-col-start', '1');
        addBtn.style.setProperty('--panel-col-span', '1');
        addBtn.style.setProperty('--panel-row-start', String(maxRow));
        addBtn.style.setProperty('--panel-row-span', '2');
    }
}
// --- drag ---
// ── Sortable-powered card movement wrapper ───────────────────────────
class DashboardSortable {
    constructor(element, options = {}) {
        this.element = element;
        this.sortable = new window.Sortable(element, {
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
    if (!getEditMode())
        return;
    // The custom pointer drag keeps CSS grid placement stable while dragging.
    return;
    if (!_sortableAvailable()) {
        _ensureSortableLoaded()
            .then(() => setupDashboardSortables())
            .catch((err) => console.warn('Sortable load failed', err));
        return;
    }
    const grids = Array.from(document.querySelectorAll('[data-panel-grid]'));
    _sortables = grids.map(grid => new DashboardSortable(grid, {
        onStart: _handleDashboardSortableStart,
        onMove: _handleDashboardSortableMove,
        onEnd: _handleDashboardSortableEnd,
    }));
}
function _eventPoint(event) {
    if (!event)
        return null;
    const te = event;
    const touch = te.touches?.[0] || te.changedTouches?.[0];
    if (touch)
        return { x: touch.clientX, y: touch.clientY };
    const pe = event;
    if (Number.isFinite(pe.clientX) && Number.isFinite(pe.clientY)) {
        return { x: pe.clientX, y: pe.clientY };
    }
    return null;
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
function _handleDashboardSortablePointerMove(event) {
    _updateDashboardSortableTarget(event);
}
function _gridAtPoint(clientX, clientY, fallbackGrid) {
    const elements = document.elementsFromPoint(clientX, clientY);
    for (const element of elements) {
        const grid = element.closest?.('[data-panel-grid]');
        if (grid)
            return grid;
    }
    return fallbackGrid;
}
function _handleDashboardSortableStart(evt) {
    if (!getEditMode())
        return;
    const card = evt.item;
    const widgetId = card?.getAttribute('data-dashboard-widget-id') || '';
    const grid = _asHTMLElement(evt.from?.closest?.('[data-panel-grid]') || card?.closest?.('[data-panel-grid]') || null);
    const widget = widgetId ? findWidget(widgetId) : null;
    if (!card || !grid || !widget)
        return;
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
        sourceGrid: _asHTMLElement(grid),
        sourcePanelId: grid.getAttribute('data-panel-grid') ?? '',
        targetGrid: _asHTMLElement(grid),
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
function _updateDashboardSortableTarget(event) {
    const st = _sortableState;
    const point = _eventPoint(event);
    if (!st || !point)
        return;
    let grid = _gridAtPoint(point.x, point.y, st.targetGrid || st.sourceGrid);
    if (!grid)
        grid = st.sourceGrid;
    if (!grid)
        grid = st.sourceGrid;
    if (grid !== st.targetGrid) {
        st.ghost.remove();
        grid.appendChild(st.ghost);
        document.querySelectorAll('.dashboard-panel[data-drag-target="true"]').forEach(panel => panel.removeAttribute('data-drag-target'));
        grid.closest('.dashboard-panel')?.setAttribute('data-drag-target', 'true');
        st.targetGrid = _asHTMLElement(grid) ?? st.sourceGrid;
        st.targetPanelId = grid.getAttribute('data-panel-grid') ?? '';
    }
    const geom = _readGridGeometry(st.targetGrid);
    const cell = _pointerToGridCell(st.targetGrid, geom, point.x, point.y, st.span, st.pointerOffsetX, st.pointerOffsetY);
    st.targetCol = cell.col;
    st.targetRow = cell.row;
    st.moved = true;
    _positionDashboardDropGhost(st.ghost, geom, cell.col, cell.row, st.span);
}
function _handleDashboardSortableMove(evt) {
    _updateDashboardSortableTarget(evt.originalEvent);
    return true;
}
async function _handleDashboardSortableEnd(evt) {
    const st = _sortableState;
    if (!st)
        return;
    _updateDashboardSortableTarget(evt.originalEvent);
    _unbindDashboardSortableTracking();
    _sortableState = null;
    st.ghost.remove();
    st.card?.removeAttribute('data-drag-source');
    document.documentElement.removeAttribute('data-dashboard-dragging');
    document.querySelectorAll('.dashboard-panel[data-drag-target="true"]').forEach(panel => panel.removeAttribute('data-drag-target'));
    const samePos = st.targetCol === st.startCol && st.targetRow === st.startRow;
    const samePanel = st.targetPanelId === st.sourcePanelId;
    if (!st.moved || (samePos && samePanel))
        return;
    await _commitDashboardWidgetMove(st);
}
// ── HA Sections-style drag-to-move (pointer-events, snap-to-grid) ─────
// Active drag state. When non-null, a card is being moved or its position
// is being chosen. Holds pointer offset, source panel, ghost element, etc.
// Section id that should win slot ties during the next layout pass (the one the
// user just dropped). Consumed by _syncDashboardPanelGridSpans.
function _readGridGeometry(gridEl) {
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
function _visualColSpanForGrid(colSpan, geom) {
    const parsed = parseInt(String(colSpan), 10);
    const normalized = Number.isFinite(parsed) ? parsed : SECTION_COLS;
    return Math.max(1, Math.min(normalized, geom?.colCount || SECTION_COLS));
}
function _visualColStartForGrid(colStart, geom, spanCol = 1) {
    const parsed = parseInt(String(colStart), 10);
    const normalized = Number.isFinite(parsed) ? parsed : 1;
    const visualSpan = _visualColSpanForGrid(spanCol, geom);
    const maxCol = Math.max(1, (geom?.colCount || SECTION_COLS) - visualSpan + 1);
    return Math.max(1, Math.min(normalized, maxCol));
}
function _internalColStartForGrid(visualCol, _geom) {
    const parsed = parseInt(String(visualCol), 10);
    const normalized = Number.isFinite(parsed) ? parsed : 1;
    return Math.max(1, Math.min(normalized, SECTION_COLS));
}
/** Compute the (1-indexed) col_start / row_start for the dragged card. */
function _pointerToGridCell(gridEl, geom, clientX, clientY, span, offsetX = 0, offsetY = 0) {
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
function _positionDashboardDropGhost(ghost, geom, col, row, span) {
    if (!ghost || !geom || !span)
        return;
    // On phones every card/section is forced full-width and only the vertical
    // order matters; a column-spanned ghost would render as a thin sliver on
    // the left ("o linie laterala stanga"), so span the whole row instead.
    const mobile = typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches;
    const visualColSpan = mobile ? geom.colCount : _visualColSpanForGrid(span.col, geom);
    const visualColStart = mobile ? 1 : _visualColStartForGrid(col ?? 1, geom, span.col);
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
function _scheduleDashboardCloneMove(st, clientX, clientY) {
    if (!st)
        return;
    st.nextCloneX = clientX - st.pointerOffsetX - st.cloneBaseLeft;
    st.nextCloneY = clientY - st.pointerOffsetY - st.cloneBaseTop;
    if (st.cloneFrame)
        return;
    st.cloneFrame = requestAnimationFrame(() => {
        st.cloneFrame = 0;
        if (!st.clone?.isConnected)
            return;
        st.clone.style.transform = `translate3d(${st.nextCloneX}px, ${st.nextCloneY}px, 0)`;
    });
}
/** Compute current grid position of a card by reverse-mapping its rect onto the grid. */
function _cardCurrentPosition(card, gridEl, geom, span) {
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
export function startDashboardDrag(event, widgetId) {
    const pe = _asPointerEvent(event);
    if (!canEditDashboard())
        return;
    if (!getEditMode())
        return;
    if (pe.button !== undefined && pe.button !== 0)
        return;
    // Don't start a drag from buttons / resize handles inside the card.
    if (_nestedInteractiveTarget(pe))
        return;
    if (pe.target?.closest?.('.hyve-dashboard-card__resize'))
        return;
    if (_touchHoldGate(pe, (synthetic) => _beginDashboardCardDrag(synthetic, widgetId)))
        return;
    _beginDashboardCardDrag(pe, widgetId);
}
function _beginDashboardCardDrag(event, widgetId) {
    const card = (event.currentTarget?.closest?.('[data-dashboard-widget-id]')
        || document.querySelector(`[data-dashboard-widget-id="${CSS.escape(widgetId)}"]`));
    if (!card)
        return;
    const grid = _asHTMLElement(card.closest('[data-panel-grid]') || card.parentElement);
    if (!grid)
        return;
    event.preventDefault?.();
    event.stopPropagation?.();
    const selection = window.getSelection?.();
    selection?.removeAllRanges?.();
    const widget = findWidget(widgetId);
    if (!widget)
        return;
    const span = widgetSpan(widget);
    const geom = _readGridGeometry(grid);
    const renderedPosition = _cardCurrentPosition(card, grid, geom, span);
    if (!span.colStart || !span.rowStart) {
        widget.col_start = renderedPosition.col;
        widget.row_start = renderedPosition.row;
        span.colStart = renderedPosition.col;
        span.rowStart = renderedPosition.row;
    }
    const cardRect = card.getBoundingClientRect();
    const clone = card.cloneNode(true);
    clone.classList.add('dashboard-card-clone');
    clone.removeAttribute('onpointerdown');
    clone.querySelectorAll('button, .hyve-dashboard-card__resize').forEach((el) => el.remove());
    clone.style.position = 'fixed';
    clone.style.width = `${cardRect.width}px`;
    clone.style.height = `${cardRect.height}px`;
    clone.style.left = `${cardRect.left}px`;
    clone.style.top = `${cardRect.top}px`;
    clone.style.transform = 'translate3d(0, 0, 0)';
    document.body.appendChild(clone);
    const ghost = document.createElement('div');
    ghost.className = 'dashboard-panel__drop-ghost';
    _positionDashboardDropGhost(ghost, geom, span.colStart ?? 1, span.rowStart ?? 1, span);
    grid.appendChild(ghost);
    card.setAttribute('data-drag-source', 'true');
    document.documentElement.setAttribute('data-dashboard-dragging', 'true');
    _moveState = {
        widgetId,
        widget,
        card: card,
        clone,
        ghost,
        span,
        sourceGrid: _asHTMLElement(grid),
        sourcePanelId: grid.getAttribute('data-panel-grid') ?? '',
        targetGrid: _asHTMLElement(grid),
        targetPanelId: grid.getAttribute('data-panel-grid') ?? '',
        targetCol: span.colStart ?? 1,
        targetRow: span.rowStart ?? 1,
        startCol: span.colStart ?? 1,
        startRow: span.rowStart ?? 1,
        pointerOffsetX: event.clientX - cardRect.left,
        pointerOffsetY: event.clientY - cardRect.top,
        cloneBaseLeft: cardRect.left,
        cloneBaseTop: cardRect.top,
        nextCloneX: 0,
        nextCloneY: 0,
        cloneFrame: 0,
        pointerId: event.pointerId,
        moved: false,
    };
    try {
        card.setPointerCapture?.(event.pointerId);
    }
    catch (_) { }
    document.addEventListener('pointermove', _handleDashboardMoveDrag, { passive: false });
    document.addEventListener('pointerup', _finishDashboardMoveDrag, { passive: false });
    document.addEventListener('pointercancel', _finishDashboardMoveDrag, { passive: false });
}
function _dashboardPanelCacheIndex(panelId) {
    const panels = Array.isArray(getCache().panels) ? getCache().panels : [];
    return panels.findIndex(panel => String(panel?.id || '') === String(panelId || ''));
}
function _dashboardPanelRenderedRowSpan(panelEl, geom, fallbackRows = 1) {
    if (!panelEl || !geom)
        return Math.max(1, fallbackRows || 1);
    const rect = panelEl.getBoundingClientRect();
    const height = Math.max(rect.height, panelEl.scrollHeight || 0, 50);
    const rowUnit = Math.max(1, geom.rowHeight + geom.rowGap);
    return Math.max(1, Math.ceil((height + geom.rowGap) / rowUnit));
}
function _dashboardPanelRenderedColSpan(_panelEl, _geom, fallbackCols = 2) {
    const parsed = parseInt(String(fallbackCols), 10);
    const span = Number.isFinite(parsed) ? parsed : 2;
    return Math.max(1, Math.min(span, SECTION_COLS));
}
function _dashboardPanelSpan(panel) {
    const col = panelColSpan(panel);
    const rawColStart = parseInt(String(panel?.col_start ?? ''), 10);
    const rawRowStart = parseInt(String(panel?.row_start ?? ''), 10);
    const rawRowSpan = parseInt(String(panel?.row_span ?? ''), 10);
    let colStart = Number.isFinite(rawColStart) && rawColStart >= 1 ? rawColStart : null;
    if (colStart !== null)
        colStart = Math.max(1, Math.min(colStart, SECTION_COLS - col + 1));
    const rowStart = Number.isFinite(rawRowStart) && rawRowStart >= 1 ? rawRowStart : null;
    const row = Number.isFinite(rawRowSpan) && rawRowSpan >= 1 ? rawRowSpan : 1;
    return { col, row, colStart, rowStart };
}
export function dashboardPanelSpan(panel) {
    return _dashboardPanelSpan(panel);
}
function _dashboardPanelElement(rootGrid, panel) {
    if (!rootGrid || !panel)
        return null;
    const panelId = String(panel.id || '');
    if (!panelId)
        return null;
    return Array.from(rootGrid.children || []).find(el => el.matches?.(`.dashboard-panel[data-panel-id="${CSS.escape(panelId)}"]`)) || null;
}
function _dashboardPanelRect(panel, rootGrid) {
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
function _dashboardRootLayoutPanels() {
    return (Array.isArray(getCache().panels) ? getCache().panels : [])
        .filter(panel => panel && !isStandalonePanel(panel) && String(panel.id || ''));
}
function _dashboardStandalonePanel() {
    return (Array.isArray(getCache().panels) ? getCache().panels : []).find(isStandalonePanel) || null;
}
function _dashboardRootLayoutItems() {
    const items = [];
    for (const panel of _dashboardRootLayoutPanels()) {
        const id = String(panel.id || '');
        if (id)
            items.push({ kind: 'panel', id, key: `panel:${id}`, raw: panel });
    }
    const standalone = _dashboardStandalonePanel();
    for (const widget of (standalone?.widgets || [])) {
        const id = String(widget?.id || '');
        if (id)
            items.push({ kind: 'widget', id, key: `widget:${id}`, raw: widget });
    }
    return items;
}
function _dashboardRootItemElement(rootGrid, item) {
    if (!rootGrid || !item)
        return null;
    const children = Array.from(rootGrid.children || []);
    if (item.kind === 'panel') {
        return children.find(el => el.matches?.(`.dashboard-panel[data-panel-id="${CSS.escape(item.id)}"]`)) || null;
    }
    if (item.kind === 'widget') {
        return children.find(el => el.matches?.(`[data-dashboard-widget-id="${CSS.escape(item.id)}"]`)) || null;
    }
    return null;
}
function _dashboardRootItemSpan(item) {
    if (item.kind === 'panel')
        return _dashboardPanelSpan(item.raw);
    return widgetSpan(item.raw);
}
function _dashboardRootItemRect(item, rootGrid) {
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
function _findDashboardRootSwapCandidate(movingRect, rootGrid) {
    let best = null;
    for (const item of _dashboardRootLayoutItems()) {
        if (item.key === movingRect.id)
            continue;
        const rect = _dashboardRootItemRect(item, rootGrid);
        const area = _rectOverlapArea(movingRect, rect);
        if (area <= 0)
            continue;
        if (!best || area > best.area)
            best = { item, rect, area };
    }
    return best;
}
function _resolveDashboardRootOverlaps(movingRect, rootGrid) {
    const rects = new Map();
    for (const item of _dashboardRootLayoutItems()) {
        if (item.key === movingRect.id)
            continue;
        rects.set(item.key, _dashboardRootItemRect(item, rootGrid));
    }
    const original = new Map();
    for (const [id, rect] of rects.entries())
        original.set(id, { col: rect.col, row: rect.row });
    let safety = 200;
    while (safety-- > 0) {
        let collided = false;
        for (const rect of rects.values()) {
            if (_rectsOverlap(rect, movingRect)) {
                const newRow = movingRect.row + movingRect.rowSpan;
                if (newRow > rect.row) {
                    rect.row = newRow;
                    collided = true;
                }
            }
        }
        const list = Array.from(rects.values()).sort((a, b) => a.row - b.row || a.col - b.col);
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                if (_rectsOverlap(list[i], list[j])) {
                    const newRow = list[i].row + list[i].rowSpan;
                    if (newRow > list[j].row) {
                        list[j].row = newRow;
                        collided = true;
                    }
                }
            }
        }
        if (!collided)
            break;
    }
    const changes = new Map();
    for (const [id, rect] of rects.entries()) {
        const prev = original.get(id);
        if (!prev || rect.col !== prev.col || rect.row !== prev.row)
            changes.set(id, rect);
    }
    return changes;
}
function _normalizeDashboardRootLayout(rootGrid) {
    const items = _dashboardRootLayoutItems().map(item => ({ item, rect: _dashboardRootItemRect(item, rootGrid) }));
    if (items.length < 2)
        return new Map();
    items.sort((a, b) => a.rect.row - b.rect.row || a.rect.col - b.rect.col);
    const original = new Map(items.map(({ item, rect }) => [item.key, { col: rect.col, row: rect.row }]));
    const placed = [];
    for (const current of items) {
        let safety = 500;
        while (safety-- > 0) {
            const hit = placed.find(placedItem => _rectsOverlap(placedItem.rect, current.rect));
            if (!hit)
                break;
            current.rect.row = hit.rect.row + hit.rect.rowSpan;
        }
        placed.push(current);
    }
    const changes = new Map();
    for (const { item, rect } of items) {
        const prev = original.get(item.key);
        if (!prev || rect.col !== prev.col || rect.row !== prev.row)
            changes.set(item.key, rect);
    }
    return changes;
}
function _applyDashboardRootRect(rect) {
    if (!rect)
        return;
    if (rect.itemKind === 'panel') {
        const panel = (getCache().panels || []).find(item => String(item?.id || '') === String(rect.itemId));
        if (!panel)
            return;
        panel.col_start = rect.col;
        panel.row_start = rect.row;
        panel.row_span = rect.rowSpan;
        return;
    }
    if (rect.itemKind === 'widget') {
        const widget = findWidget(String(rect.itemId || ''));
        if (!widget)
            return;
        widget.col_start = rect.col;
        widget.row_start = rect.row;
        widget.col_span = rect.colSpan;
        widget.row_span = rect.rowSpan;
    }
}
async function _persistDashboardRootRect(rect, pageQS = '') {
    if (!rect)
        return;
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
function _resolveDashboardPanelOverlaps(movingRect, rootGrid) {
    const rects = new Map();
    for (const panel of _dashboardRootLayoutPanels()) {
        const id = String(panel.id || '');
        if (!id || id === movingRect.id)
            continue;
        rects.set(id, _dashboardPanelRect(panel, rootGrid));
    }
    const original = new Map();
    for (const [id, rect] of rects.entries())
        original.set(id, rect.row);
    let safety = 200;
    while (safety-- > 0) {
        let collided = false;
        for (const rect of rects.values()) {
            if (_rectsOverlap(rect, movingRect)) {
                const newRow = movingRect.row + movingRect.rowSpan;
                if (newRow > rect.row) {
                    rect.row = newRow;
                    collided = true;
                }
            }
        }
        const list = Array.from(rects.values()).sort((a, b) => a.row - b.row || a.col - b.col);
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                if (_rectsOverlap(list[i], list[j])) {
                    const newRow = list[i].row + list[i].rowSpan;
                    if (newRow > list[j].row) {
                        list[j].row = newRow;
                        collided = true;
                    }
                }
            }
        }
        if (!collided)
            break;
    }
    const changes = new Map();
    for (const [id, rect] of rects.entries()) {
        if (rect.row !== original.get(id))
            changes.set(id, rect);
    }
    return changes;
}
function _dashboardPanelOrderFromDragState(st) {
    if (!st?.stack || !st.placeholder)
        return [];
    return Array.from(st.stack.children)
        .filter((el) => el === st.placeholder || (el instanceof HTMLElement && el.matches?.('.dashboard-panel') && el !== st.sourceEl && !!el.dataset.panelId))
        .map(el => el === st.placeholder ? st.panelId : String(el.dataset.panelId || ''))
        .filter(Boolean);
}
function _dashboardPanelDropIndexAtPoint(st, clientX, clientY) {
    const panels = Array.from(st.stack.querySelectorAll('.dashboard-panel[data-panel-id]'))
        .filter(panel => panel !== st.sourceEl && panel !== st.placeholder && panel.offsetParent !== null);
    if (!panels.length)
        return 0;
    let best = null;
    panels.forEach((panel, index) => {
        const rect = panel.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dist = Math.hypot(clientX - centerX, clientY - centerY);
        if (!best || dist < best.dist)
            best = { panel, index, rect, centerX, centerY, dist };
    });
    if (!best)
        return panels.length;
    const hit = best;
    // In a single-column (vertical) stack every drop is within a panel's
    // vertical band, so decide before/after purely by the vertical midpoint.
    // The horizontal (sameVisualRow) heuristic only makes sense for a 2D
    // wrapping grid; using it here would always read clientX (the left-side
    // drag handle) as "before", making it impossible to drop a section below
    // another one.
    let after;
    if (st?.singleColumn) {
        after = clientY > hit.centerY;
    }
    else {
        const sameVisualRow = clientY >= hit.rect.top - 24 && clientY <= hit.rect.bottom + 24;
        after = sameVisualRow ? clientX > hit.centerX : clientY > hit.centerY;
    }
    return hit.index + (after ? 1 : 0);
}
function _moveDashboardPanelPlaceholder(st, clientX, clientY) {
    const panels = Array.from(st.stack.querySelectorAll('.dashboard-panel[data-panel-id]'))
        .filter(panel => panel !== st.sourceEl && panel !== st.placeholder && panel.offsetParent !== null);
    const dropIndex = Math.max(0, Math.min(_dashboardPanelDropIndexAtPoint(st, clientX, clientY), panels.length));
    const before = panels[dropIndex] || null;
    if (before !== st.placeholder?.nextElementSibling) {
        if (st.placeholder)
            st.stack.insertBefore(st.placeholder, before);
    }
    st.targetIndex = _dashboardPanelOrderFromDragState(st).indexOf(st.panelId);
}
function _scheduleDashboardPanelCloneMove(st, clientX, clientY) {
    if (!st)
        return;
    st.nextCloneX = clientX - st.pointerOffsetX - st.cloneBaseLeft;
    st.nextCloneY = clientY - st.pointerOffsetY - st.cloneBaseTop;
    if (st.cloneFrame)
        return;
    st.cloneFrame = requestAnimationFrame(() => {
        st.cloneFrame = 0;
        if (!st.clone?.isConnected)
            return;
        st.clone.style.transform = `translate3d(${st.nextCloneX}px, ${st.nextCloneY}px, 0)`;
    });
}
// On narrow (single-column) layouts the panels stack collapses to one column via
// CSS, so absolute grid coordinates (col_start/row_start) are ignored. In that
// mode we reorder by array index instead — exactly how Home Assistant handles
// section reordering. Detect it from the live grid geometry.
function _dashboardStackIsSingleColumn(stack) {
    if (!stack)
        return false;
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches)
        return true;
    const styles = getComputedStyle(stack);
    // Mobile collapses the section stack to a vertical flexbox. Grid geometry
    // then reports no columns (gridTemplateColumns: none), and colCount falls
    // back to 12, so we must detect the flex/empty-template case explicitly.
    if ((styles.display || '').includes('flex'))
        return true;
    const cols = (styles.gridTemplateColumns || '')
        .split(' ')
        .filter(v => v && v !== 'none');
    return cols.length <= 1;
}
function _clearDashboardPanelDelay() {
    if (!_panelDelay)
        return;
    clearTimeout(_panelDelay.timer);
    _panelDelay.cleanup?.();
    _panelDelay = null;
}
// Home Assistant-style press-and-hold gate for touch input. A normal finger
// swipe (movement >10px before the timer) keeps scrolling the page; only a
// deliberate ~140ms hold starts the drag. Returns true when it has deferred the
// start (caller should stop), false for non-touch input (caller starts now).
function _touchHoldGate(event, begin) {
    if (event.pointerType !== 'touch')
        return false;
    event.stopPropagation?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    _clearDashboardPanelDelay();
    const cancel = (e) => {
        if (e?.type === 'pointermove' && Math.hypot(e.clientX - startX, e.clientY - startY) <= 10)
            return;
        _clearDashboardPanelDelay();
    };
    const cleanup = () => {
        document.removeEventListener('pointermove', cancel);
        document.removeEventListener('pointerup', cancel);
        document.removeEventListener('pointercancel', cancel);
    };
    _panelDelay = {
        cleanup,
        timer: setTimeout(() => {
            cleanup();
            _panelDelay = null;
            if (navigator.vibrate) {
                try {
                    navigator.vibrate(8);
                }
                catch (_) { }
            }
            begin({
                pointerType: 'touch',
                pointerId,
                clientX: startX,
                clientY: startY,
                currentTarget: handle,
                target: handle,
                preventDefault() { },
                stopPropagation() { },
            });
        }, 140),
    };
    document.addEventListener('pointermove', cancel, { passive: true });
    document.addEventListener('pointerup', cancel, { passive: true });
    document.addEventListener('pointercancel', cancel, { passive: true });
    return true;
}
// Public entry point bound on the drag handle. For touch we apply the
// press-and-hold gate so a normal finger swipe still scrolls the page.
export function startDashboardPanelDrag(event, panelId) {
    const pe = _asPointerEvent(event);
    if (pe.button !== undefined && pe.button !== 0)
        return;
    if (!canEditDashboard())
        return;
    if (!getEditMode())
        return;
    if (pe.button !== undefined && pe.button !== 0)
        return;
    if (_touchHoldGate(pe, (synthetic) => _beginDashboardPanelDrag(synthetic, panelId)))
        return;
    _beginDashboardPanelDrag(pe, panelId);
}
function _beginDashboardPanelDrag(event, panelId) {
    event.preventDefault?.();
    event.stopPropagation?.();
    const sourceEl = (_asHTMLElement(event.currentTarget)?.closest?.('.dashboard-panel[data-panel-id]')
        || document.querySelector(`.dashboard-panel[data-panel-id="${CSS.escape(String(panelId || ''))}"]`));
    const stack = _asHTMLElement(sourceEl?.closest?.('.dashboard-panels-stack'));
    if (!sourceEl || !stack)
        return;
    const panelKey = String(panelId || sourceEl.dataset.panelId || '');
    const fromIndex = _dashboardPanelCacheIndex(panelKey);
    if (fromIndex < 0)
        return;
    const panel = getCache().panels[fromIndex];
    const rect = sourceEl.getBoundingClientRect();
    const geom = _readGridGeometry(stack);
    const span = _dashboardPanelSpan(panel);
    span.col = _dashboardPanelRenderedColSpan(sourceEl, geom, span.col);
    span.row = _dashboardPanelRenderedRowSpan(sourceEl, geom, span.row);
    const renderedPosition = _cardCurrentPosition(sourceEl, stack, geom, { col: span.col, row: span.row, colStart: span.colStart, rowStart: span.rowStart });
    const startCol = span.colStart || renderedPosition.col;
    const startRow = span.rowStart || renderedPosition.row;
    span.colStart = startCol;
    span.rowStart = startRow;
    panel.col_start = startCol;
    panel.row_start = startRow;
    panel.row_span = span.row;
    const clone = sourceEl.cloneNode(true);
    clone.classList.add('dashboard-panel-clone');
    clone.removeAttribute('onpointerdown');
    clone.querySelectorAll('button').forEach((el) => el.removeAttribute('onclick'));
    clone.style.position = 'fixed';
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.left = `${rect.left}px`;
    clone.style.top = `${rect.top}px`;
    clone.style.transform = 'translate3d(0, 0, 0)';
    document.body.appendChild(clone);
    const singleColumn = _dashboardStackIsSingleColumn(stack);
    // Single-column (mobile) → array-index reorder with a placeholder gap.
    // Multi-column (desktop) → absolute 2D grid placement with a drop ghost.
    let ghost = null;
    let placeholder = null;
    if (singleColumn) {
        placeholder = document.createElement('div');
        placeholder.className = 'dashboard-panel__reorder-placeholder';
        placeholder.style.height = `${rect.height}px`;
        stack.insertBefore(placeholder, sourceEl);
        sourceEl.style.display = 'none';
    }
    else {
        ghost = document.createElement('div');
        ghost.className = 'dashboard-panel__drop-ghost dashboard-panel__drop-ghost--section';
        _positionDashboardDropGhost(ghost, geom, startCol, startRow, span);
        stack.appendChild(ghost);
    }
    sourceEl.setAttribute('data-panel-drag-source', 'true');
    document.documentElement.setAttribute('data-dashboard-panel-dragging', 'true');
    _panelDragState = {
        panelId: panelKey,
        panel,
        sourceEl,
        stack,
        clone,
        ghost,
        placeholder,
        singleColumn,
        span,
        fromIndex,
        targetIndex: fromIndex,
        targetCol: startCol,
        targetRow: startRow,
        startCol,
        startRow,
        pointerId: event.pointerId,
        pointerOffsetX: event.clientX - rect.left,
        pointerOffsetY: event.clientY - rect.top,
        cloneBaseLeft: rect.left,
        cloneBaseTop: rect.top,
        nextCloneX: 0,
        nextCloneY: 0,
        cloneFrame: 0,
        moved: false,
    };
    try {
        event.currentTarget?.setPointerCapture?.(event.pointerId);
    }
    catch (_) { }
    document.addEventListener('pointermove', _handleDashboardPanelDragMove, { passive: false });
    document.addEventListener('pointerup', _finishDashboardPanelDrag, { passive: false });
    document.addEventListener('pointercancel', _finishDashboardPanelDrag, { passive: false });
}
function _handleDashboardPanelDragMove(event) {
    const st = _panelDragState;
    if (!st)
        return;
    event.preventDefault?.();
    st.moved = true;
    _scheduleDashboardPanelCloneMove(st, event.clientX, event.clientY);
    if (st.singleColumn) {
        _moveDashboardPanelPlaceholder(st, event.clientX, event.clientY);
        return;
    }
    const geom = _readGridGeometry(st.stack);
    const cell = _pointerToGridCell(st.stack, geom, event.clientX, event.clientY, st.span, st.pointerOffsetX, st.pointerOffsetY);
    st.targetCol = cell.col;
    st.targetRow = cell.row;
    _positionDashboardDropGhost(st.ghost, geom, cell.col, cell.row, st.span);
}
async function _finishDashboardPanelDrag(event) {
    const st = _panelDragState;
    if (!st)
        return;
    const cancelled = event?.type === 'pointercancel';
    document.removeEventListener('pointermove', _handleDashboardPanelDragMove);
    document.removeEventListener('pointerup', _finishDashboardPanelDrag);
    document.removeEventListener('pointercancel', _finishDashboardPanelDrag);
    _panelDragState = null;
    // The single-column commit derives the new order from the placeholder's
    // position in the DOM, so capture it BEFORE the placeholder is removed.
    if (st.singleColumn)
        st.finalOrder = _dashboardPanelOrderFromDragState(st);
    if (st.cloneFrame)
        cancelAnimationFrame(st.cloneFrame);
    st.clone?.remove();
    st.ghost?.remove();
    st.placeholder?.remove();
    if (st.singleColumn)
        st.sourceEl.style.display = '';
    st.sourceEl.removeAttribute('data-panel-drag-source');
    document.documentElement.removeAttribute('data-dashboard-panel-dragging');
    if (st.singleColumn) {
        if (cancelled || !st.moved)
            return;
        await _commitSingleColumnPanelOrder(st);
        return;
    }
    const samePos = st.targetCol === st.startCol && st.targetRow === st.startRow;
    if (cancelled || !st.moved || samePos)
        return;
    await _commitDashboardPanelLayout(st);
}
// Mobile / single-column commit: reorder the panels array (HA-style) and persist
// via adjacent moves, which the backend applies as a stable pop+insert.
async function _commitSingleColumnPanelOrder(st) {
    const order = st.finalOrder || _dashboardPanelOrderFromDragState(st);
    const pos = order.indexOf(st.panelId);
    if (pos < 0)
        return;
    const beforeSectionId = order[pos + 1] || null;
    const full = Array.isArray(getCache().panels) ? getCache().panels.slice() : [];
    const oldFullIndex = full.findIndex(p => String(p?.id || '') === st.panelId);
    if (oldFullIndex < 0)
        return;
    const [moved] = full.splice(oldFullIndex, 1);
    let insertAt = full.length;
    if (beforeSectionId) {
        const bi = full.findIndex(p => String(p?.id || '') === String(beforeSectionId));
        if (bi >= 0)
            insertAt = bi;
    }
    if (insertAt === oldFullIndex)
        return;
    full.splice(insertAt, 0, moved);
    getCache().panels = full;
    renderDashboardWithFlip();
    try {
        await _persistDashboardPanelMove(st.panelId, oldFullIndex, insertAt);
        showToast(t('dashboard.section_moved'), 'success');
    }
    catch (e) {
        showToast(_errMsg(e) || t('dashboard.section_move_error'), 'error');
        await loadDashboard();
    }
}
async function _commitDashboardPanelOrder(panelId, fromIndex, targetIndex) {
    const panels = Array.isArray(getCache().panels) ? getCache().panels : [];
    const currentIndex = _dashboardPanelCacheIndex(panelId);
    if (currentIndex < 0)
        return;
    const [moved] = panels.splice(currentIndex, 1);
    const insertAt = Math.max(0, Math.min(targetIndex, panels.length));
    panels.splice(insertAt, 0, moved);
    getCache().panels = panels;
    renderDashboardWithFlip();
    try {
        await _persistDashboardPanelMove(panelId, fromIndex, targetIndex);
        showToast(t('dashboard.section_moved'), 'success');
    }
    catch (e) {
        showToast(_errMsg(e) || t('dashboard.section_move_error'), 'error');
        await loadDashboard();
    }
}
async function _commitDashboardPanelLayout(st) {
    const panel = (getCache().panels || []).find(item => String(item?.id || '') === String(st.panelId));
    if (!panel)
        return;
    // Anchor the dragged section where the user dropped it; the grid packer in
    // _syncDashboardPanelGridSpans then resolves the final, overlap-free layout
    // for every section (re-flowing neighbours around the new position). The
    // priority id makes the just-dropped section win any slot conflict.
    panel.col_start = st.targetCol;
    panel.row_start = st.targetRow;
    panel.row_span = st.span.row;
    _panelLayoutPriorityId = st.panelId;
    renderDashboardWithFlip();
    _panelLayoutPriorityId = null;
    try {
        // Persist sequentially: each /layout call does a read-modify-write of the
        // whole page config, so parallel writes would clobber each other.
        const sections = (getCache().panels || []).filter(p => !isStandalonePanel(p));
        for (const p of sections) {
            await _persistDashboardPanelLayout(String(p.id || ''), {
                col_start: p.col_start,
                row_start: p.row_start,
                row_span: p.row_span,
            });
        }
        showToast(t('dashboard.section_moved'), 'success');
    }
    catch (e) {
        showToast(_errMsg(e) || t('dashboard.section_move_error'), 'error');
        await loadDashboard();
    }
}
async function _persistDashboardPanelLayout(panelId, layout) {
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
async function _persistDashboardPanelMove(panelId, fromIndex, targetIndex) {
    const direction = targetIndex < fromIndex ? 'left' : 'right';
    const steps = Math.abs(targetIndex - fromIndex);
    if (!steps)
        return;
    const params = getCurrentPageId() ? `?page_id=${encodeURIComponent(getCurrentPageId())}` : '';
    for (let i = 0; i < steps; i++) {
        const res = await apiCall(`/api/dashboard/panels/${encodeURIComponent(panelId)}/move${params}`, {
            method: 'POST',
            body: { direction },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiErr(err.detail, 'dashboard.save_section_order_failed'));
        }
    }
}
function _handleDashboardMoveDrag(event) {
    const st = _moveState;
    if (!st)
        return;
    event.preventDefault();
    st.moved = true;
    _scheduleDashboardCloneMove(st, event.clientX, event.clientY);
    // Detect which panel the pointer is over (cross-panel drag support).
    let panelGrid = null;
    const elsAtPoint = document.elementsFromPoint(event.clientX, event.clientY);
    for (const el of elsAtPoint) {
        const cand = el.closest?.('[data-panel-grid]');
        if (cand) {
            panelGrid = cand;
            break;
        }
    }
    if (!panelGrid)
        panelGrid = st.sourceGrid;
    const targetGrid = _asHTMLElement(panelGrid) || st.sourceGrid;
    if (targetGrid !== st.targetGrid) {
        if (st.ghost.parentElement)
            st.ghost.parentElement.removeChild(st.ghost);
        panelGrid.appendChild(st.ghost);
        st.sourceGrid.closest('.dashboard-panel')?.removeAttribute('data-drag-target');
        st.targetGrid.closest('.dashboard-panel')?.removeAttribute('data-drag-target');
        _asHTMLElement(panelGrid)?.closest('.dashboard-panel')?.setAttribute('data-drag-target', 'true');
        st.targetGrid = targetGrid;
        st.targetPanelId = panelGrid.getAttribute('data-panel-grid') ?? '';
    }
    const geom = _readGridGeometry(st.targetGrid);
    const cell = _pointerToGridCell(st.targetGrid, geom, event.clientX, event.clientY, st.span, st.pointerOffsetX, st.pointerOffsetY);
    const targetChanged = cell.col !== st.targetCol || cell.row !== st.targetRow;
    _positionDashboardDropGhost(st.ghost, geom, cell.col, cell.row, st.span);
    if (targetChanged) {
        st.targetCol = cell.col;
        st.targetRow = cell.row;
    }
}
async function _finishDashboardMoveDrag(event) {
    const st = _moveState;
    if (!st)
        return;
    const cancelled = event?.type === 'pointercancel';
    document.removeEventListener('pointermove', _handleDashboardMoveDrag);
    document.removeEventListener('pointerup', _finishDashboardMoveDrag);
    document.removeEventListener('pointercancel', _finishDashboardMoveDrag);
    _moveState = null;
    // Cleanup visuals.
    if (st.cloneFrame)
        cancelAnimationFrame(st.cloneFrame);
    st.clone.remove();
    st.ghost.remove();
    st.card.removeAttribute('data-drag-source');
    document.documentElement.removeAttribute('data-dashboard-dragging');
    document.querySelectorAll('.dashboard-panel[data-drag-target="true"]').forEach(p => p.removeAttribute('data-drag-target'));
    if (cancelled || !st.moved)
        return;
    const samePos = (st.targetCol === st.startCol && st.targetRow === st.startRow);
    const samePanel = (st.targetPanelId === st.sourcePanelId);
    if (samePos && samePanel)
        return;
    await _commitDashboardWidgetMove(st);
}
async function _commitDashboardWidgetMove(st) {
    if (st.targetPanelId === DASHBOARD_STANDALONE_PANEL_ID && st.targetGrid?.classList?.contains('dashboard-panels-stack')) {
        await _commitDashboardRootWidgetMove(st);
        return;
    }
    const samePanel = (st.targetPanelId === st.sourcePanelId);
    st.widget.col_start = st.targetCol;
    st.widget.row_start = st.targetRow;
    st.widget.col_span = st.span.col;
    st.widget.row_span = st.span.row;
    if (!samePanel && st.targetPanelId === DASHBOARD_STANDALONE_PANEL_ID) {
        ensureStandalonePanelLocal();
    }
    if (!samePanel) {
        // Move widget across panels in the local cache so re-render is correct.
        _moveWidgetBetweenPanelsLocal(st.widgetId, st.sourcePanelId, st.targetPanelId);
    }
    // Resolve collisions. Same-panel drops onto an occupied slot behave like a
    // swap; insert/cross-panel moves keep the old push-down behavior.
    const movingRect = {
        id: st.widgetId,
        col: st.targetCol,
        row: st.targetRow,
        colSpan: st.span.col,
        rowSpan: st.span.row,
    };
    const targetWidgets = _panelWidgets(st.targetPanelId);
    const displaced = new Map();
    const swapCandidate = samePanel
        ? _findDashboardSwapCandidate(movingRect, targetWidgets, st.targetGrid)
        : null;
    if (swapCandidate) {
        const w = swapCandidate.widget;
        const wspan = widgetSpan(w);
        const swapRect = {
            ...swapCandidate.rect,
            col: _clampColStartForSpan(st.startCol, wspan.col),
            row: st.startRow,
            colSpan: wspan.col,
            rowSpan: wspan.row,
        };
        w.col_span = wspan.col;
        w.row_span = wspan.row;
        w.col_start = swapRect.col;
        w.row_start = swapRect.row;
        displaced.set(w.id, swapRect);
    }
    else {
        const pushed = _resolveOverlaps(movingRect, targetWidgets, st.targetGrid);
        for (const [id, rect] of pushed.entries()) {
            const w = targetWidgets.find(x => x.id === id);
            if (!w)
                continue;
            // Freeze legacy widgets first if they didn't have explicit start cols.
            // Also persist the resolved spans so the v2 flag doesn't shrink them.
            const wspan = widgetSpan(w);
            w.col_span = wspan.col;
            w.row_span = wspan.row;
            w.col_start = rect.col;
            w.row_start = rect.row;
            displaced.set(id, rect);
        }
    }
    // Final safety pass: walk the whole panel and guarantee zero overlap.
    const normalized = _normalizePanelLayout(targetWidgets, st.targetGrid);
    for (const [id, rect] of normalized.entries()) {
        const w = targetWidgets.find(x => x.id === id);
        if (!w)
            continue;
        w.col_start = rect.col;
        w.row_start = rect.row;
        if (!displaced.has(id))
            displaced.set(id, rect);
        else
            displaced.set(id, rect);
    }
    renderDashboardWithFlip();
    // Persist.
    const activePageId = getCurrentPageId() || getCache().current_page_id || getCache().page_id || '';
    const pageQS = activePageId ? `?page_id=${encodeURIComponent(activePageId)}` : '';
    try {
        if (!samePanel && st.targetPanelId) {
            // First relocate to the new panel...
            const relocBody = { target_panel_id: st.targetPanelId };
            const relocUrl = activePageId
                ? `/api/dashboard/widgets/${encodeURIComponent(st.widgetId)}/relocate?page_id=${encodeURIComponent(activePageId)}`
                : `/api/dashboard/widgets/${encodeURIComponent(st.widgetId)}/relocate`;
            const r1 = await apiCall(relocUrl, { method: 'POST', body: relocBody });
            if (!r1.ok) {
                const err = await r1.json().catch(() => ({}));
                throw new Error(dashApiErr(err.detail, 'dashboard.move_panel_failed'));
            }
        }
        // ...then save the snap position. Persist the resolved spans too.
        const r2 = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(st.widgetId)}${pageQS}`, {
            method: 'PATCH',
            body: {
                col_start: st.targetCol,
                row_start: st.targetRow,
                col_span: st.span.col,
                row_span: st.span.row,
            },
        });
        if (!r2.ok) {
            const err = await r2.json().catch(() => ({}));
            throw new Error(dashApiErr(err.detail, 'dashboard.save_position_failed'));
        }
        // Persist any widgets we displaced as a side-effect of the move.
        if (displaced.size) {
            await Promise.all(Array.from(displaced.entries()).map(([id, rect]) => {
                const w = targetWidgets.find(x => x.id === id) || findWidget(id);
                const wspan = w ? widgetSpan(w) : { col: rect.colSpan, row: rect.rowSpan };
                return apiCall(`/api/dashboard/widgets/${encodeURIComponent(id)}${pageQS}`, {
                    method: 'PATCH',
                    body: {
                        col_start: rect.col,
                        row_start: rect.row,
                        col_span: wspan.col,
                        row_span: wspan.row,
                    },
                }).catch(() => null);
            }));
        }
    }
    catch (e) {
        showToast(_errMsg(e) || t('dashboard.move_error'), 'error');
        await loadDashboard();
    }
}
async function _commitDashboardRootWidgetMove(st) {
    const samePanel = (st.targetPanelId === st.sourcePanelId);
    const activePageId = getCurrentPageId() || getCache().current_page_id || getCache().page_id || '';
    const pageQS = activePageId ? `?page_id=${encodeURIComponent(activePageId)}` : '';
    if (!samePanel && st.targetPanelId === DASHBOARD_STANDALONE_PANEL_ID) {
        ensureStandalonePanelLocal();
    }
    if (!samePanel) {
        _moveWidgetBetweenPanelsLocal(st.widgetId, st.sourcePanelId, st.targetPanelId);
    }
    st.widget.col_start = st.targetCol;
    st.widget.row_start = st.targetRow;
    st.widget.col_span = st.span.col;
    st.widget.row_span = st.span.row;
    const movingRect = {
        id: `widget:${st.widgetId}`,
        itemKind: 'widget',
        itemId: st.widgetId,
        col: st.targetCol,
        row: st.targetRow,
        colSpan: st.span.col,
        rowSpan: st.span.row,
    };
    _applyDashboardRootRect(movingRect);
    const changed = new Map();
    changed.set(String(movingRect.id ?? `widget:${st.widgetId}`), movingRect);
    const canSwapRoot = samePanel && st.sourcePanelId === DASHBOARD_STANDALONE_PANEL_ID;
    const swapCandidate = canSwapRoot ? _findDashboardRootSwapCandidate(movingRect, st.targetGrid) : null;
    if (swapCandidate) {
        const swapRect = {
            ...swapCandidate.rect,
            col: _clampColStartForSpan(st.startCol, swapCandidate.rect.colSpan),
            row: st.startRow,
        };
        _applyDashboardRootRect(swapRect);
        changed.set(String(swapRect.id), swapRect);
    }
    else {
        const pushed = _resolveDashboardRootOverlaps(movingRect, st.targetGrid);
        for (const [id, rect] of pushed.entries()) {
            _applyDashboardRootRect(rect);
            changed.set(id, rect);
        }
    }
    const normalized = _normalizeDashboardRootLayout(st.targetGrid);
    for (const [id, rect] of normalized.entries()) {
        _applyDashboardRootRect(rect);
        changed.set(id, rect);
    }
    renderDashboardWithFlip();
    try {
        if (!samePanel && st.targetPanelId) {
            const relocUrl = activePageId
                ? `/api/dashboard/widgets/${encodeURIComponent(st.widgetId)}/relocate?page_id=${encodeURIComponent(activePageId)}`
                : `/api/dashboard/widgets/${encodeURIComponent(st.widgetId)}/relocate`;
            const reloc = await apiCall(relocUrl, {
                method: 'POST',
                body: { target_panel_id: st.targetPanelId },
            });
            if (!reloc.ok) {
                const err = await reloc.json().catch(() => ({}));
                throw new Error(dashApiErr(err.detail, 'dashboard.move_panel_failed'));
            }
        }
        await Promise.all(Array.from(changed.values()).map(rect => _persistDashboardRootRect(rect, pageQS)));
    }
    catch (e) {
        showToast(_errMsg(e) || t('dashboard.move_error'), 'error');
        await loadDashboard();
    }
}
/** Move a widget object between panel arrays in the local cache (no API). */
function _moveWidgetBetweenPanelsLocal(widgetId, fromPanelId, toPanelId) {
    if (!fromPanelId || !toPanelId || fromPanelId === toPanelId)
        return;
    const panels = getCache().panels || [];
    const from = panels.find(p => String(p.id) === String(fromPanelId));
    let to = panels.find(p => String(p.id) === String(toPanelId));
    if (!to && String(toPanelId) === DASHBOARD_STANDALONE_PANEL_ID) {
        to = ensureStandalonePanelLocal();
    }
    if (!from || !to)
        return;
    const fromWidgets = from.widgets || [];
    const idx = fromWidgets.findIndex(w => w.id === widgetId);
    if (idx < 0)
        return;
    const [moved] = fromWidgets.splice(idx, 1);
    from.widgets = fromWidgets;
    to.widgets = to.widgets || [];
    // Inherit first-page id of target panel if it has tabs.
    if (Array.isArray(to.pages) && to.pages.length) {
        moved.page_id = String(to.pages[0].id || '');
    }
    else {
        moved.page_id = null;
    }
    to.widgets.push(moved);
}
// ── Collision resolution: push overlapping widgets downward ──────────
/** Return a flat list of widget objects for a given panel id (cache lookup). */
function _panelWidgets(panelId) {
    if (!panelId) {
        const panels = Array.isArray(getCache().panels) ? getCache().panels : [];
        if (panels.length === 1 && Array.isArray(panels[0].widgets))
            return panels[0].widgets;
        return getCache().widgets || [];
    }
    const panel = (getCache().panels || []).find(p => String(p.id) === String(panelId));
    return (panel && panel.widgets) || [];
}
/** True when two rectangles {col,row,colSpan,rowSpan} overlap (1-indexed). */
function _rectsOverlap(a, b) {
    if (!a || !b)
        return false;
    const ax2 = a.col + a.colSpan, ay2 = a.row + a.rowSpan;
    const bx2 = b.col + b.colSpan, by2 = b.row + b.rowSpan;
    return a.col < bx2 && b.col < ax2 && a.row < by2 && b.row < ay2;
}
function _rectOverlapArea(a, b) {
    if (!_rectsOverlap(a, b))
        return 0;
    const left = Math.max(a.col, b.col);
    const right = Math.min(a.col + a.colSpan, b.col + b.colSpan);
    const top = Math.max(a.row, b.row);
    const bottom = Math.min(a.row + a.rowSpan, b.row + b.rowSpan);
    return Math.max(0, right - left) * Math.max(0, bottom - top);
}
function _clampColStartForSpan(colStart, colSpan) {
    const parsedStart = parseInt(String(colStart), 10);
    const parsedSpan = parseInt(String(colSpan), 10);
    const start = Number.isFinite(parsedStart) ? parsedStart : 1;
    const span = Number.isFinite(parsedSpan) ? parsedSpan : 1;
    return Math.max(1, Math.min(start, DASHBOARD_GRID_COLS - Math.max(1, span) + 1));
}
function _findDashboardSwapCandidate(movingRect, panelWidgets, panelGridEl) {
    let best = null;
    for (const widget of panelWidgets || []) {
        if (!widget || widget.id === movingRect.id)
            continue;
        const rect = _widgetRect(widget, panelGridEl);
        const area = _rectOverlapArea(movingRect, rect);
        if (area <= 0)
            continue;
        if (!best || area > best.area)
            best = { widget, rect, area };
    }
    return best;
}
/**
 * Build the placement rectangle for a widget. Falls back to the rendered grid
 * position for legacy widgets that don't have explicit col_start/row_start yet.
 */
function _widgetRect(widget, panelGridEl) {
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
function _resolveOverlaps(movingRect, panelWidgets, panelGridEl) {
    const rects = new Map();
    for (const w of panelWidgets) {
        if (w.id === movingRect.id)
            continue;
        rects.set(w.id, _widgetRect(w, panelGridEl));
    }
    const original = new Map();
    for (const [id, r] of rects.entries())
        original.set(id, r.row);
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
                if (newRow > r.row) {
                    r.row = newRow;
                    collided = true;
                }
            }
        }
        // Then resolve internal collisions between displaced widgets.
        const list = Array.from(rects.values()).sort((a, b) => a.row - b.row || a.col - b.col);
        for (let i = 0; i < list.length; i++) {
            for (let j = i + 1; j < list.length; j++) {
                if (_rectsOverlap(list[i], list[j])) {
                    const newRow = list[i].row + list[i].rowSpan;
                    if (newRow > list[j].row) {
                        list[j].row = newRow;
                        collided = true;
                    }
                }
            }
        }
        if (!collided)
            break;
    }
    const changes = new Map();
    for (const [id, r] of rects.entries()) {
        if (r.row !== original.get(id))
            changes.set(id, r);
    }
    return changes;
}
/**
 * Final pass: walk the panel sorted by (row, col) and push any widget down
 * until it no longer overlaps any earlier-placed widget. Guarantees zero
 * overlap regardless of how it was reached. Returns Map of changes.
 */
function _normalizePanelLayout(panelWidgets, panelGridEl) {
    if (!panelWidgets || panelWidgets.length < 2)
        return new Map();
    const items = panelWidgets.map(w => ({ w, rect: _widgetRect(w, panelGridEl) }));
    items.sort((a, b) => a.rect.row - b.rect.row || a.rect.col - b.rect.col);
    const original = new Map(items.map(({ w, rect }) => [w.id, rect.row]));
    const placed = [];
    for (const it of items) {
        // Push down while it overlaps anyone already placed.
        let safety = 500;
        while (safety-- > 0) {
            const hit = placed.find(p => _rectsOverlap(p.rect, it.rect));
            if (!hit)
                break;
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
function renderDashboardWithFlip() {
    const grid = document.getElementById('dashboard-grid');
    if (!grid) {
        renderDashboard();
        return;
    }
    // Capture rects of all cards before the re-render (FIRST).
    const before = new Map();
    grid.querySelectorAll('[data-dashboard-widget-id]').forEach(el => {
        before.set(`widget:${el.getAttribute('data-dashboard-widget-id')}`, el.getBoundingClientRect());
    });
    grid.querySelectorAll('.dashboard-panel[data-panel-id]').forEach(el => {
        before.set(`panel:${el.getAttribute('data-panel-id')}`, el.getBoundingClientRect());
    });
    renderDashboard();
    // After re-render, measure new positions (LAST), invert with transform, then play.
    requestAnimationFrame(() => {
        grid.querySelectorAll('[data-dashboard-widget-id]').forEach(el => {
            const id = `widget:${el.getAttribute('data-dashboard-widget-id')}`;
            const prev = before.get(id);
            if (!prev)
                return;
            const cur = el.getBoundingClientRect();
            const dx = prev.left - cur.left;
            const dy = prev.top - cur.top;
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5)
                return;
            el.setAttribute('data-flip-suppress', 'true');
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            // Force layout flush, then animate to identity.
            void el.offsetWidth;
            el.removeAttribute('data-flip-suppress');
            el.style.transform = '';
        });
        grid.querySelectorAll('.dashboard-panel[data-panel-id]').forEach(el => {
            const id = `panel:${el.getAttribute('data-panel-id')}`;
            const prev = before.get(id);
            if (!prev)
                return;
            const cur = el.getBoundingClientRect();
            const dx = prev.left - cur.left;
            const dy = prev.top - cur.top;
            if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5)
                return;
            el.setAttribute('data-flip-suppress', 'true');
            el.style.transform = `translate(${dx}px, ${dy}px)`;
            // Force layout flush, then animate to identity.
            void el.offsetWidth;
            el.removeAttribute('data-flip-suppress');
            el.style.transform = '';
        });
    });
}
// ── HA-style live resize (drag bottom-right handle) ──────────────────
export function startDashboardResize(event, widgetId, direction = 'se') {
    const pe = _asPointerEvent(event);
    if (!canEditDashboard())
        return;
    if (!getEditMode())
        return;
    if (pe.button !== undefined && pe.button !== 0)
        return;
    pe.preventDefault();
    pe.stopPropagation();
    const card = _asHTMLElement(pe.currentTarget)?.closest?.('[data-dashboard-widget-id]');
    if (!card)
        return;
    const grid = _asHTMLElement(card.closest('[data-panel-grid]') || card.parentElement);
    if (!grid)
        return;
    const styles = getComputedStyle(grid);
    const gap = parseFloat(styles.columnGap || styles.gap || '0') || 0;
    const rowGap = parseFloat(styles.rowGap || styles.gap || '0') || 0;
    const cols = (styles.gridTemplateColumns || '').split(' ').filter(Boolean);
    const rows = (styles.gridTemplateRows || '').split(' ').filter(Boolean);
    const colWidth = cols.length
        ? cols.reduce((sum, w) => sum + parseFloat(w), 0) / cols.length
        : 200;
    const rowHeight = rows.length
        ? (parseFloat(rows[0]) || 50)
        : 50;
    const widget = findWidget(widgetId);
    const initial = widgetSpan(widget || {});
    let tooltip = card.querySelector('.hyve-dashboard-card__resize-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'hyve-dashboard-card__resize-tooltip';
        card.appendChild(tooltip);
    }
    tooltip.textContent = `${initial.col} × ${initial.row}`;
    card.setAttribute('data-resizing', 'true');
    document.documentElement.setAttribute('data-dashboard-resizing', 'true');
    // Preserve start position while resizing so the card doesn't jump.
    const colRule = initial.colStart ? `${initial.colStart} / span ${initial.col}` : `span ${initial.col}`;
    const rowRule = initial.rowStart ? `${initial.rowStart} / span ${initial.row}` : `span ${initial.row}`;
    card.style.gridColumn = colRule;
    card.style.gridRow = rowRule;
    const gridCols = Math.min(cols.length || SECTION_COLS, SECTION_COLS);
    const maxCols = initial.colStart
        ? Math.max(1, gridCols - initial.colStart + 1)
        : gridCols;
    const maxRows = 8;
    // Lock the axis that this handle does not control.
    const lockCol = (direction === 's');
    const lockRow = (direction === 'e');
    _resizeState = {
        widgetId,
        card: card,
        tooltip,
        startX: pe.clientX,
        startY: pe.clientY,
        colUnit: colWidth + gap,
        rowUnit: rowHeight + rowGap,
        startCol: initial.col,
        startRow: initial.row,
        col: initial.col,
        row: initial.row,
        colStart: initial.colStart,
        rowStart: initial.rowStart,
        maxCols,
        maxRows,
        lockCol,
        lockRow,
        pointerId: pe.pointerId,
    };
    try {
        _asHTMLElement(pe.target)?.setPointerCapture?.(pe.pointerId);
    }
    catch (_) { }
    document.addEventListener('pointermove', _handleDashboardResizeMove, { passive: false });
    document.addEventListener('pointerup', _finishDashboardResize, { passive: false });
    document.addEventListener('pointercancel', _finishDashboardResize, { passive: false });
}
function _handleDashboardResizeMove(event) {
    const st = _resizeState;
    if (!st)
        return;
    event.preventDefault();
    const dx = event.clientX - st.startX;
    const dy = event.clientY - st.startY;
    const newCol = st.lockCol
        ? st.startCol
        : Math.min(Math.max(1, st.startCol + Math.round(dx / st.colUnit)), st.maxCols);
    const newRow = st.lockRow
        ? st.startRow
        : Math.min(Math.max(1, st.startRow + Math.round(dy / st.rowUnit)), st.maxRows);
    if (newCol === st.col && newRow === st.row)
        return;
    st.col = newCol;
    st.row = newRow;
    st.card.style.gridColumn = st.colStart ? `${st.colStart} / span ${newCol}` : `span ${newCol}`;
    st.card.style.gridRow = st.rowStart ? `${st.rowStart} / span ${newRow}` : `span ${newRow}`;
    st.card.setAttribute('data-dashboard-cols', String(newCol));
    st.card.setAttribute('data-dashboard-rows', String(newRow));
    _applyWeatherResizeTier(st.card, newRow);
    if (st.tooltip)
        st.tooltip.textContent = `${newCol} × ${newRow}`;
}
function _applyWeatherResizeTier(card, rowSpan) {
    if (!card?.classList?.contains('hyve-dashboard-card--weather-rich'))
        return;
    const parsed = parseInt(String(rowSpan), 10);
    if (!Number.isFinite(parsed) || parsed < 1)
        return;
    card.setAttribute('data-weather-rows', String(Math.min(parsed, 8)));
}
async function _finishDashboardResize(event) {
    const st = _resizeState;
    if (!st)
        return;
    document.removeEventListener('pointermove', _handleDashboardResizeMove);
    document.removeEventListener('pointerup', _finishDashboardResize);
    document.removeEventListener('pointercancel', _finishDashboardResize);
    _resizeState = null;
    st.card.removeAttribute('data-resizing');
    document.documentElement.removeAttribute('data-dashboard-resizing');
    if (st.tooltip)
        st.tooltip.remove();
    const sizeChanged = (st.col !== st.startCol) || (st.row !== st.startRow);
    if (!sizeChanged)
        return;
    // Update local cache immediately so re-renders keep the new size.
    const widget = findWidget(st.widgetId);
    if (widget) {
        widget.col_span = st.col;
        widget.row_span = st.row;
    }
    // Persist via PATCH; restore previous size on failure.
    const activePageId = getCurrentPageId() || getCache().current_page_id || getCache().page_id || '';
    const pageQS = activePageId ? `?page_id=${encodeURIComponent(activePageId)}` : '';
    try {
        const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(st.widgetId)}${pageQS}`, {
            method: 'PATCH',
            body: { col_span: st.col, row_span: st.row },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiErr(err.detail, 'dashboard.save_size_failed'));
        }
        // Re-render so any layout-dependent content (gauges, weather rows, etc.)
        // updates without requiring a manual page refresh.
        renderDashboardWithFlip();
    }
    catch (e) {
        if (widget) {
            widget.col_span = st.startCol;
            widget.row_span = st.startRow;
        }
        st.card.style.gridColumn = `span ${st.startCol}`;
        st.card.style.gridRow = `span ${st.startRow}`;
        st.card.setAttribute('data-dashboard-cols', String(st.startCol));
        st.card.setAttribute('data-dashboard-rows', String(st.startRow));
        _applyWeatherResizeTier(st.card, st.startRow);
        showToast(_errMsg(e) || t('dashboard.resize_error'), 'error');
    }
}
export async function moveDashboardWidget(widgetId, direction = 'right') {
    if (!requireDashboardEditAccess())
        return;
    try {
        const res = await apiCall(`/api/dashboard/widgets/${encodeURIComponent(widgetId)}/move`, {
            method: 'POST',
            body: { direction },
        });
        if (res.ok) {
            await loadDashboard();
            return;
        }
        if (res.status !== 404) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiErr(err.detail, 'dashboard.rearrange_widget_failed'));
        }
    }
    catch (e) {
        if (String(_errMsg(e) || '').includes(t('dashboard.rearrange_widget_failed'))) {
            showToast(_errMsg(e), 'error');
            return;
        }
    }
    try {
        const section = await readDashboardSectionFallback();
        const widgets = Array.isArray(section.widgets) ? section.widgets : [];
        const idx = widgets.findIndex(item => item.id === widgetId);
        if (idx < 0)
            return;
        const target = (direction === 'left' || direction === 'up') ? idx - 1 : idx + 1;
        if (target < 0 || target >= widgets.length)
            return;
        [widgets[idx], widgets[target]] = [widgets[target], widgets[idx]];
        section.widgets = widgets;
        await writeDashboardSectionFallback(section);
        await loadDashboard();
    }
    catch (e) {
        showToast(_errMsg(e) || t('dashboard.rearrange_error'), 'error');
    }
}
