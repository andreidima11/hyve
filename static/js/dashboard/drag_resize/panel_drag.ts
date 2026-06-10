/**
 * Panel drag handlers for dashboard sections.
 */

import { canEditDashboard } from '../edit_access.js';
import {
    dragResizeState,
    _asPointerEvent,
    _asHTMLElement,
    _touchHoldGate,
    _scheduleDashboardPanelCloneMove,
    _errMsg,
    getCache,
    getCurrentPageId,
    getEditMode,
    isStandalonePanel,
    apiCall,
    dashApiErr,
    t,
    showToast,
    loadDashboard,
} from './shared.js';
import {
    _readGridGeometry,
    _cardCurrentPosition,
    _pointerToGridCell,
    _positionDashboardDropGhost,
    _dashboardPanelSpan,
    _dashboardPanelRenderedColSpan,
    _dashboardPanelRenderedRowSpan,
    _persistDashboardPanelLayout,
    renderDashboardWithFlip,
} from './grid_geometry.js';
import type { DashboardPanelDragState } from '../../types/drag_resize.js';
import type { DashboardPanelDropBest } from '../../types/drag_resize.js';

function _dashboardPanelCacheIndex(panelId: string | null | undefined) {
    const panels = Array.isArray(getCache().panels) ? getCache().panels : [];
    return panels.findIndex(panel => String(panel?.id || '') === String(panelId || ''));
}

function _dashboardPanelOrderFromDragState(st: DashboardPanelDragState) {
    if (!st?.stack || !st.placeholder) return [];
    return Array.from(st.stack.children)
        .filter((el): el is HTMLElement => el === st.placeholder || (el instanceof HTMLElement && el.matches?.('.dashboard-panel') && el !== st.sourceEl && !!el.dataset.panelId))
        .map(el => el === st.placeholder ? st.panelId : String((el as HTMLElement).dataset.panelId || ''))
        .filter(Boolean);
}

function _dashboardPanelDropIndexAtPoint(st: DashboardPanelDragState, clientX: number, clientY: number) {
    const panels = Array.from(st.stack.querySelectorAll<HTMLElement>('.dashboard-panel[data-panel-id]'))
        .filter(panel => panel !== st.sourceEl && panel !== st.placeholder && panel.offsetParent !== null);
    if (!panels.length) return 0;

    let best: DashboardPanelDropBest | null = null;
    panels.forEach((panel, index) => {
        const rect = panel.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dist = Math.hypot(clientX - centerX, clientY - centerY);
        if (!best || dist < best.dist) best = { panel, index, rect, centerX, centerY, dist };
    });
    if (!best) return panels.length;

    const hit: DashboardPanelDropBest = best;
    // In a single-column (vertical) stack every drop is within a panel's
    // vertical band, so decide before/after purely by the vertical midpoint.
    // The horizontal (sameVisualRow) heuristic only makes sense for a 2D
    // wrapping grid; using it here would always read clientX (the left-side
    // drag handle) as "before", making it impossible to drop a section below
    // another one.
    let after;
    if (st?.singleColumn) {
        after = clientY > hit.centerY;
    } else {
        const sameVisualRow = clientY >= hit.rect.top - 24 && clientY <= hit.rect.bottom + 24;
        after = sameVisualRow ? clientX > hit.centerX : clientY > hit.centerY;
    }
    return hit.index + (after ? 1 : 0);
}

function _moveDashboardPanelPlaceholder(st: DashboardPanelDragState, clientX: number, clientY: number) {
    const panels = Array.from(st.stack.querySelectorAll<HTMLElement>('.dashboard-panel[data-panel-id]'))
        .filter(panel => panel !== st.sourceEl && panel !== st.placeholder && panel.offsetParent !== null);
    const dropIndex = Math.max(0, Math.min(_dashboardPanelDropIndexAtPoint(st, clientX, clientY), panels.length));
    const before = panels[dropIndex] || null;
    if (before !== st.placeholder?.nextElementSibling) {
        if (st.placeholder) st.stack.insertBefore(st.placeholder, before);
    }
    st.targetIndex = _dashboardPanelOrderFromDragState(st).indexOf(st.panelId);
}

// On narrow (single-column) layouts the panels stack collapses to one column via
// CSS, so absolute grid coordinates (col_start/row_start) are ignored. In that
// mode we reorder by array index instead — exactly how Home Assistant handles
// section reordering. Detect it from the live grid geometry.
function _dashboardStackIsSingleColumn(stack: Element | null | undefined) {
    if (!stack) return false;
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches) return true;
    const styles = getComputedStyle(stack);
    // Mobile collapses the section stack to a vertical flexbox. Grid geometry
    // then reports no columns (gridTemplateColumns: none), and colCount falls
    // back to 12, so we must detect the flex/empty-template case explicitly.
    if ((styles.display || '').includes('flex')) return true;
    const cols = (styles.gridTemplateColumns || '')
        .split(' ')
        .filter(v => v && v !== 'none');
    return cols.length <= 1;
}

// Public entry point bound on the drag handle. For touch we apply the
// press-and-hold gate so a normal finger swipe still scrolls the page.
export function startDashboardPanelDrag(event: Event, panelId: string) {
    const pe = _asPointerEvent(event);
    if (pe.button !== undefined && pe.button !== 0) return;
    if (!canEditDashboard()) return;
    if (!getEditMode()) return;
    if (pe.button !== undefined && pe.button !== 0) return;
    if (_touchHoldGate(pe, (synthetic) => _beginDashboardPanelDrag(synthetic, panelId))) return;
    _beginDashboardPanelDrag(pe, panelId);
}

function _beginDashboardPanelDrag(event: PointerEvent, panelId: string) {
    event.preventDefault?.();
    event.stopPropagation?.();

    const sourceEl = (_asHTMLElement(event.currentTarget as Element | null)?.closest?.('.dashboard-panel[data-panel-id]')
        || document.querySelector(`.dashboard-panel[data-panel-id="${CSS.escape(String(panelId || ''))}"]`)) as HTMLElement | null;
    const stack = _asHTMLElement(sourceEl?.closest?.('.dashboard-panels-stack'));
    if (!sourceEl || !stack) return;

    const panelKey = String(panelId || (sourceEl as HTMLElement).dataset.panelId || '');
    const fromIndex = _dashboardPanelCacheIndex(panelKey);
    if (fromIndex < 0) return;
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

    const clone = sourceEl.cloneNode(true) as HTMLElement;
    clone.classList.add('dashboard-panel-clone');
    clone.removeAttribute('onpointerdown');
    clone.querySelectorAll('button').forEach((el: Element) => el.removeAttribute('onclick'));
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
    } else {
        ghost = document.createElement('div');
        ghost.className = 'dashboard-panel__drop-ghost dashboard-panel__drop-ghost--section';
        _positionDashboardDropGhost(ghost, geom, startCol, startRow, span);
        stack.appendChild(ghost);
    }
    sourceEl.setAttribute('data-panel-drag-source', 'true');
    document.documentElement.setAttribute('data-dashboard-panel-dragging', 'true');

    dragResizeState.panelDragState = {
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

    try { (event.currentTarget as Element | null)?.setPointerCapture?.(event.pointerId); } catch (_) {}
    document.addEventListener('pointermove', _handleDashboardPanelDragMove, { passive: false });
    document.addEventListener('pointerup', _finishDashboardPanelDrag, { passive: false });
    document.addEventListener('pointercancel', _finishDashboardPanelDrag, { passive: false });
}

function _handleDashboardPanelDragMove(event: PointerEvent) {
    const st = dragResizeState.panelDragState;
    if (!st) return;
    event.preventDefault?.();
    st.moved = true;
    _scheduleDashboardPanelCloneMove(st, event.clientX, event.clientY);

    if (st.singleColumn) {
        _moveDashboardPanelPlaceholder(st, event.clientX, event.clientY);
        return;
    }

    const geom = _readGridGeometry(st.stack);
    const cell = _pointerToGridCell(
        st.stack,
        geom,
        event.clientX,
        event.clientY,
        st.span,
        st.pointerOffsetX,
        st.pointerOffsetY
    );
    st.targetCol = cell.col;
    st.targetRow = cell.row;
    _positionDashboardDropGhost(st.ghost, geom, cell.col, cell.row, st.span);
}

async function _finishDashboardPanelDrag(event: PointerEvent) {
    const st = dragResizeState.panelDragState;
    if (!st) return;
    const cancelled = event?.type === 'pointercancel';
    document.removeEventListener('pointermove', _handleDashboardPanelDragMove);
    document.removeEventListener('pointerup', _finishDashboardPanelDrag);
    document.removeEventListener('pointercancel', _finishDashboardPanelDrag);
    dragResizeState.panelDragState = null;

    // The single-column commit derives the new order from the placeholder's
    // position in the DOM, so capture it BEFORE the placeholder is removed.
    if (st.singleColumn) st.finalOrder = _dashboardPanelOrderFromDragState(st);

    if (st.cloneFrame) cancelAnimationFrame(st.cloneFrame);
    st.clone?.remove();
    st.ghost?.remove();
    st.placeholder?.remove();
    if (st.singleColumn) st.sourceEl.style.display = '';
    st.sourceEl.removeAttribute('data-panel-drag-source');
    document.documentElement.removeAttribute('data-dashboard-panel-dragging');

    if (st.singleColumn) {
        if (cancelled || !st.moved) return;
        await _commitSingleColumnPanelOrder(st);
        return;
    }

    const samePos = st.targetCol === st.startCol && st.targetRow === st.startRow;
    if (cancelled || !st.moved || samePos) return;
    await _commitDashboardPanelLayout(st);
}

// Mobile / single-column commit: reorder the panels array (HA-style) and persist
// via adjacent moves, which the backend applies as a stable pop+insert.
async function _commitSingleColumnPanelOrder(st: DashboardPanelDragState) {
    const order = st.finalOrder || _dashboardPanelOrderFromDragState(st);
    const pos = order.indexOf(st.panelId);
    if (pos < 0) return;
    const beforeSectionId = order[pos + 1] || null;
    const full = Array.isArray(getCache().panels) ? getCache().panels.slice() : [];
    const oldFullIndex = full.findIndex(p => String(p?.id || '') === st.panelId);
    if (oldFullIndex < 0) return;
    const [moved] = full.splice(oldFullIndex, 1);
    let insertAt = full.length;
    if (beforeSectionId) {
        const bi = full.findIndex(p => String(p?.id || '') === String(beforeSectionId));
        if (bi >= 0) insertAt = bi;
    }
    if (insertAt === oldFullIndex) return;
    full.splice(insertAt, 0, moved);
    getCache().panels = full;
    renderDashboardWithFlip();

    try {
        await _persistDashboardPanelMove(st.panelId, oldFullIndex, insertAt);
        showToast(t('dashboard.section_moved'), 'success');
    } catch (e) {
        showToast(_errMsg(e) || t('dashboard.section_move_error'), 'error');
        await loadDashboard();
    }
}

async function _commitDashboardPanelOrder(panelId: string, fromIndex: number, targetIndex: number) {
    const panels = Array.isArray(getCache().panels) ? getCache().panels : [];
    const currentIndex = _dashboardPanelCacheIndex(panelId);
    if (currentIndex < 0) return;
    const [moved] = panels.splice(currentIndex, 1);
    const insertAt = Math.max(0, Math.min(targetIndex, panels.length));
    panels.splice(insertAt, 0, moved);
    getCache().panels = panels;
    renderDashboardWithFlip();

    try {
        await _persistDashboardPanelMove(panelId, fromIndex, targetIndex);
        showToast(t('dashboard.section_moved'), 'success');
    } catch (e) {
        showToast(_errMsg(e) || t('dashboard.section_move_error'), 'error');
        await loadDashboard();
    }
}

async function _commitDashboardPanelLayout(st: DashboardPanelDragState) {
    const panel = (getCache().panels || []).find(item => String(item?.id || '') === String(st.panelId));
    if (!panel) return;

    // Anchor the dragged section where the user dropped it; the grid packer in
    // syncDashboardPanelGridSpans then resolves the final, overlap-free layout
    // for every section (re-flowing neighbours around the new position). The
    // priority id makes the just-dropped section win any slot conflict.
    panel.col_start = st.targetCol;
    panel.row_start = st.targetRow;
    panel.row_span = st.span.row;
    dragResizeState.panelLayoutPriorityId = st.panelId;
    renderDashboardWithFlip();
    dragResizeState.panelLayoutPriorityId = null;

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
    } catch (e) {
        showToast(_errMsg(e) || t('dashboard.section_move_error'), 'error');
        await loadDashboard();
    }
}

async function _persistDashboardPanelMove(panelId: string, fromIndex: number, targetIndex: number) {
    const direction = targetIndex < fromIndex ? 'left' : 'right';
    const steps = Math.abs(targetIndex - fromIndex);
    if (!steps) return;
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
