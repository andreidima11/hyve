/**
 * Card drag/move handlers for dashboard widgets.
 */
import { canEditDashboard } from '../edit_access.js';
import { DASHBOARD_STANDALONE_PANEL_ID } from '../constants.js';
import { dragResizeState, _asPointerEvent, _asHTMLElement, _nestedInteractiveTarget, _touchHoldGate, _scheduleDashboardCloneMove, _errMsg, findWidget, getCache, getCurrentPageId, getEditMode, widgetSpan, ensureStandalonePanelLocal, apiCall, dashApiErr, t, showToast, loadDashboard, } from './shared.js';
import { _readGridGeometry, _cardCurrentPosition, _pointerToGridCell, _positionDashboardDropGhost, _panelWidgets, _findDashboardSwapCandidate, _resolveOverlaps, _normalizePanelLayout, _clampColStartForSpan, _findDashboardRootSwapCandidate, _resolveDashboardRootOverlaps, _normalizeDashboardRootLayout, _applyDashboardRootRect, _persistDashboardRootRect, renderDashboardWithFlip, } from './grid_geometry.js';
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
    dragResizeState.moveState = {
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
function _handleDashboardMoveDrag(event) {
    const st = dragResizeState.moveState;
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
    const st = dragResizeState.moveState;
    if (!st)
        return;
    const cancelled = event?.type === 'pointercancel';
    document.removeEventListener('pointermove', _handleDashboardMoveDrag);
    document.removeEventListener('pointerup', _finishDashboardMoveDrag);
    document.removeEventListener('pointercancel', _finishDashboardMoveDrag);
    dragResizeState.moveState = null;
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
    await commitDashboardWidgetMove(st);
}
export async function commitDashboardWidgetMove(st) {
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
