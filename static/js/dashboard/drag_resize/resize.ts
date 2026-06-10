/**
 * Widget resize and programmatic move handlers.
 */

import { canEditDashboard, requireDashboardEditAccess } from '../edit_access.js';
import { SECTION_COLS } from '../constants.js';
import {
    dragResizeState,
    _asPointerEvent,
    _asHTMLElement,
    _errMsg,
    findWidget,
    getCache,
    getCurrentPageId,
    getEditMode,
    widgetSpan,
    apiCall,
    dashApiErr,
    t,
    showToast,
    loadDashboard,
    readDashboardSectionFallback,
    writeDashboardSectionFallback,
} from './shared.js';
import { renderDashboardWithFlip } from './grid_geometry.js';

export function startDashboardResize(event: Event, widgetId: string, direction: string = 'se') {
    const pe = _asPointerEvent(event);
    if (!canEditDashboard()) return;
    if (!getEditMode()) return;
    if (pe.button !== undefined && pe.button !== 0) return;
    pe.preventDefault();
    pe.stopPropagation();

    const card = _asHTMLElement(pe.currentTarget as Element | null)?.closest?.('[data-dashboard-widget-id]') as HTMLElement | null;
    if (!card) return;
    const grid = _asHTMLElement(card.closest('[data-panel-grid]') || card.parentElement);
    if (!grid) return;

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

    let tooltip = card.querySelector('.hyve-dashboard-card__resize-tooltip') as HTMLElement | null;
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

    dragResizeState.resizeState = {
        widgetId,
        card: card as HTMLElement,
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

    try { _asHTMLElement(pe.target as Element | null)?.setPointerCapture?.(pe.pointerId); } catch (_) {}
    document.addEventListener('pointermove', _handleDashboardResizeMove, { passive: false });
    document.addEventListener('pointerup', _finishDashboardResize, { passive: false });
    document.addEventListener('pointercancel', _finishDashboardResize, { passive: false });
}

function _handleDashboardResizeMove(event: PointerEvent) {
    const st = dragResizeState.resizeState;
    if (!st) return;
    event.preventDefault();
    const dx = event.clientX - st.startX;
    const dy = event.clientY - st.startY;
    const newCol = st.lockCol
        ? st.startCol
        : Math.min(Math.max(1, st.startCol + Math.round(dx / st.colUnit)), st.maxCols);
    const newRow = st.lockRow
        ? st.startRow
        : Math.min(Math.max(1, st.startRow + Math.round(dy / st.rowUnit)), st.maxRows);
    if (newCol === st.col && newRow === st.row) return;
    st.col = newCol;
    st.row = newRow;
    st.card.style.gridColumn = st.colStart ? `${st.colStart} / span ${newCol}` : `span ${newCol}`;
    st.card.style.gridRow = st.rowStart ? `${st.rowStart} / span ${newRow}` : `span ${newRow}`;
    st.card.setAttribute('data-dashboard-cols', String(newCol));
    st.card.setAttribute('data-dashboard-rows', String(newRow));
    _applyWeatherResizeTier(st.card, newRow);
    if (st.tooltip) st.tooltip.textContent = `${newCol} × ${newRow}`;
}

function _applyWeatherResizeTier(card: HTMLElement | null | undefined, rowSpan: number | string) {
    if (!card?.classList?.contains('hyve-dashboard-card--weather-rich')) return;
    const parsed = parseInt(String(rowSpan), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return;
    card.setAttribute('data-weather-rows', String(Math.min(parsed, 8)));
}

async function _finishDashboardResize(event: PointerEvent) {
    const st = dragResizeState.resizeState;
    if (!st) return;
    document.removeEventListener('pointermove', _handleDashboardResizeMove);
    document.removeEventListener('pointerup', _finishDashboardResize);
    document.removeEventListener('pointercancel', _finishDashboardResize);
    dragResizeState.resizeState = null;

    st.card.removeAttribute('data-resizing');
    document.documentElement.removeAttribute('data-dashboard-resizing');
    if (st.tooltip) st.tooltip.remove();

    const sizeChanged = (st.col !== st.startCol) || (st.row !== st.startRow);
    if (!sizeChanged) return;

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
    } catch (e) {
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

export async function moveDashboardWidget(widgetId: string, direction = 'right') {
    if (!requireDashboardEditAccess()) return;
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
    } catch (e) {
        if (String(_errMsg(e) || '').includes(t('dashboard.rearrange_widget_failed'))) {
            showToast(_errMsg(e), 'error');
            return;
        }
    }

    try {
        const section = await readDashboardSectionFallback();
        const widgets = Array.isArray(section.widgets) ? section.widgets : [];
        const idx = widgets.findIndex(item => item.id === widgetId);
        if (idx < 0) return;
        const target = (direction === 'left' || direction === 'up') ? idx - 1 : idx + 1;
        if (target < 0 || target >= widgets.length) return;
        [widgets[idx], widgets[target]] = [widgets[target], widgets[idx]];
        section.widgets = widgets;
        await writeDashboardSectionFallback(section);
        await loadDashboard();
    } catch (e) {
        showToast(_errMsg(e) || t('dashboard.rearrange_error'), 'error');
    }
}
