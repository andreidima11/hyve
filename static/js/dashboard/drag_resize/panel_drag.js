/**
 * Panel drag handlers for dashboard sections.
 */
import { canEditDashboard } from '../edit_access.js';
import { dragResizeState, _asPointerEvent, _asHTMLElement, _touchHoldGate, _scheduleDashboardPanelCloneMove, _errMsg, getCache, getCurrentPageId, getEditMode, isStandalonePanel, apiCall, dashApiErr, t, showToast, loadDashboard, } from './shared.js';
import { _readGridGeometry, _cardCurrentPosition, _pointerToGridCell, _positionDashboardSectionDropGhost, _dashboardPanelSpan, _dashboardPanelRenderedColSpan, _dashboardPanelRenderedRowSpan, _dashboardRootLayoutPanels, _dashboardStandalonePanel, _persistDashboardPanelLayout, renderDashboardWithFlip, } from './grid_geometry.js';
function _dashboardPanelCacheIndex(panelId) {
    const panels = Array.isArray(getCache().panels) ? getCache().panels : [];
    return panels.findIndex(panel => String(panel?.id || '') === String(panelId || ''));
}
function _sectionReorderPanels(st) {
    return Array.from(st.stack.querySelectorAll('.dashboard-panel[data-panel-id]'))
        .filter(panel => panel !== st.sourceEl && panel.offsetParent !== null);
}
function _singleColumnOrderFromDropBefore(st, before) {
    const others = _sectionReorderPanels(st).map(panel => String(panel.dataset.panelId || '')).filter(Boolean);
    if (!before)
        return [...others, st.panelId];
    const beforeId = String(before.dataset.panelId || '');
    const idx = others.indexOf(beforeId);
    if (idx < 0)
        return [...others, st.panelId];
    return [...others.slice(0, idx), st.panelId, ...others.slice(idx)];
}
function _dashboardPanelDropIndexAtPoint(st, clientX, clientY) {
    const panels = _sectionReorderPanels(st);
    if (!panels.length)
        return 0;
    if (st.singleColumn) {
        for (let index = 0; index < panels.length; index += 1) {
            const rect = panels[index].getBoundingClientRect();
            if (clientY < rect.top + rect.height / 2)
                return index;
        }
        return panels.length;
    }
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
    const sameVisualRow = clientY >= hit.rect.top - 24 && clientY <= hit.rect.bottom + 24;
    const after = sameVisualRow ? clientX > hit.centerX : clientY > hit.centerY;
    return hit.index + (after ? 1 : 0);
}
function _sectionReorderDropBefore(st, clientX, clientY) {
    const panels = _sectionReorderPanels(st);
    const dropIndex = Math.max(0, Math.min(_dashboardPanelDropIndexAtPoint(st, clientX, clientY), panels.length));
    return panels[dropIndex] || null;
}
function _positionSectionReorderGhost(st, clientX, clientY) {
    if (!st.ghost)
        return;
    const before = _sectionReorderDropBefore(st, clientX, clientY);
    st.dropBefore = before;
    st.finalOrder = _singleColumnOrderFromDropBefore(st, before);
    st.targetIndex = st.finalOrder.indexOf(st.panelId);
    const stackRect = st.stack.getBoundingClientRect();
    const stackStyles = getComputedStyle(st.stack);
    const gap = parseFloat(stackStyles.rowGap || stackStyles.gap || '16') || 16;
    const panels = _sectionReorderPanels(st);
    const padLeft = parseFloat(stackStyles.paddingLeft) || 0;
    const padRight = parseFloat(stackStyles.paddingRight) || 0;
    let top;
    if (before) {
        top = before.getBoundingClientRect().top;
    }
    else if (panels.length) {
        top = panels[panels.length - 1].getBoundingClientRect().bottom + gap;
    }
    else {
        top = stackRect.top;
    }
    st.ghost.style.left = `${stackRect.left + padLeft}px`;
    st.ghost.style.width = `${Math.max(0, stackRect.width - padLeft - padRight)}px`;
    st.ghost.style.height = `${st.sourceHeight}px`;
    st.ghost.style.top = `${top}px`;
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
    clone.querySelectorAll('button, .dashboard-panel__drag').forEach((el) => el.remove());
    clone.style.position = 'fixed';
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.left = `${rect.left}px`;
    clone.style.top = `${rect.top}px`;
    clone.style.transform = 'translate3d(0, 0, 0)';
    document.body.appendChild(clone);
    const singleColumn = _dashboardStackIsSingleColumn(stack);
    // Single-column (mobile) → fixed drop ghost at the insert slot + faded source.
    // Multi-column (desktop) → grid drop ghost sized to the dragged section.
    let ghost = null;
    if (singleColumn) {
        ghost = document.createElement('div');
        ghost.className = 'dashboard-panel__drop-ghost dashboard-panel__drop-ghost--section dashboard-panel__drop-ghost--reorder';
        document.body.appendChild(ghost);
    }
    else {
        ghost = document.createElement('div');
        ghost.className = 'dashboard-panel__drop-ghost dashboard-panel__drop-ghost--section';
        stack.appendChild(ghost);
        _positionDashboardSectionDropGhost(ghost, stack, geom, startCol, startRow, span, sourceEl);
    }
    sourceEl.setAttribute('data-panel-drag-source', 'true');
    document.documentElement.setAttribute('data-dashboard-panel-dragging', 'true');
    window.getSelection?.()?.removeAllRanges?.();
    dragResizeState.panelDragState = {
        panelId: panelKey,
        panel,
        sourceEl,
        stack,
        clone,
        ghost,
        singleColumn,
        span,
        fromIndex,
        targetIndex: fromIndex,
        targetCol: startCol,
        targetRow: startRow,
        startCol,
        startRow,
        sourceHeight: rect.height,
        dropBefore: null,
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
    if (singleColumn)
        _positionSectionReorderGhost(dragResizeState.panelDragState, event.clientX, event.clientY);
    try {
        event.currentTarget?.setPointerCapture?.(event.pointerId);
    }
    catch (_) { }
    document.addEventListener('pointermove', _handleDashboardPanelDragMove, { passive: false });
    document.addEventListener('pointerup', _finishDashboardPanelDrag, { passive: false });
    document.addEventListener('pointercancel', _finishDashboardPanelDrag, { passive: false });
}
function _handleDashboardPanelDragMove(event) {
    const st = dragResizeState.panelDragState;
    if (!st)
        return;
    event.preventDefault?.();
    st.moved = true;
    _scheduleDashboardPanelCloneMove(st, event.clientX, event.clientY);
    if (st.singleColumn) {
        _positionSectionReorderGhost(st, event.clientX, event.clientY);
        return;
    }
    const geom = _readGridGeometry(st.stack);
    const cell = _pointerToGridCell(st.stack, geom, event.clientX, event.clientY, st.span, st.pointerOffsetX, st.pointerOffsetY);
    st.targetCol = cell.col;
    st.targetRow = cell.row;
    _positionDashboardSectionDropGhost(st.ghost, st.stack, geom, cell.col, cell.row, st.span, st.sourceEl);
}
async function _finishDashboardPanelDrag(event) {
    const st = dragResizeState.panelDragState;
    if (!st)
        return;
    const cancelled = event?.type === 'pointercancel';
    document.removeEventListener('pointermove', _handleDashboardPanelDragMove);
    document.removeEventListener('pointerup', _finishDashboardPanelDrag);
    document.removeEventListener('pointercancel', _finishDashboardPanelDrag);
    dragResizeState.panelDragState = null;
    if (st.cloneFrame)
        cancelAnimationFrame(st.cloneFrame);
    st.clone?.remove();
    st.ghost?.remove();
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
function _writeSectionPanelsToCache(sections) {
    const standalone = _dashboardStandalonePanel();
    getCache().panels = standalone ? [...sections, standalone] : sections.slice();
}
async function _commitSingleColumnPanelOrder(st) {
    const order = st.finalOrder || _singleColumnOrderFromDropBefore(st, st.dropBefore);
    const pos = order.indexOf(st.panelId);
    if (pos < 0)
        return;
    const beforeSectionId = order[pos + 1] || null;
    const sections = _dashboardRootLayoutPanels().slice();
    const oldIndex = sections.findIndex(p => String(p?.id || '') === st.panelId);
    if (oldIndex < 0)
        return;
    const [moved] = sections.splice(oldIndex, 1);
    let insertAt = sections.length;
    if (beforeSectionId) {
        const bi = sections.findIndex(p => String(p?.id || '') === String(beforeSectionId));
        if (bi >= 0)
            insertAt = bi;
    }
    if (insertAt === oldIndex)
        return;
    sections.splice(insertAt, 0, moved);
    _writeSectionPanelsToCache(sections);
    renderDashboardWithFlip();
    try {
        await _persistDashboardPanelReorder(st.panelId, beforeSectionId, oldIndex, insertAt);
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
    }
    catch (e) {
        showToast(_errMsg(e) || t('dashboard.section_move_error'), 'error');
        await loadDashboard();
    }
}
async function _persistDashboardPanelReorder(panelId, beforeSectionId, fromIndex, targetIndex) {
    const params = getCurrentPageId() ? `?page_id=${encodeURIComponent(getCurrentPageId())}` : '';
    if (beforeSectionId) {
        const res = await apiCall(`/api/dashboard/panels/${encodeURIComponent(panelId)}/reorder${params}`, {
            method: 'POST',
            body: { target_id: beforeSectionId },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(dashApiErr(err.detail, 'dashboard.save_section_order_failed'));
        }
        return;
    }
    await _persistDashboardPanelMove(panelId, fromIndex, targetIndex);
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
