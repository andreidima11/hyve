/**
 * Shared deps, module state, and small helpers for dashboard drag/resize.
 */
import { dashApiError } from '../helpers.js';
export function _errMsg(err) {
    if (err instanceof Error)
        return err.message;
    return String(err ?? '');
}
export function _asPointerEvent(event) {
    return event;
}
export function _asHTMLElement(el) {
    return el instanceof HTMLElement ? el : null;
}
export function _gridEl(el) {
    const node = el?.closest?.('[data-panel-grid]') ?? el;
    return _asHTMLElement(node);
}
export const dragResizeState = {
    deps: null,
    moveState: null,
    panelDragState: null,
    panelLayoutPriorityId: null,
    resizeState: null,
    panelDelay: null,
};
export function initDashboardDragResize(deps) {
    dragResizeState.deps = deps;
}
export function deps() {
    if (!dragResizeState.deps)
        throw new Error('Dashboard drag/resize not initialized');
    return dragResizeState.deps;
}
export function getCache() { return deps().getCache(); }
export function getCurrentPageId() { return deps().getCurrentPageId(); }
export function getEditMode() { return deps().getEditMode(); }
export function findWidget(id) { return deps().findWidget(id); }
export function widgetSpan(w) { return deps().widgetSpan(w); }
export function panelColSpan(p) { return deps().panelColSpan(p); }
export function isStandalonePanel(p) { return deps().isStandalonePanel(p); }
export function ensureStandalonePanelLocal() { return deps().ensureStandalonePanelLocal(); }
export function renderDashboard() { return deps().renderDashboard(); }
export function loadDashboard() { return deps().loadDashboard(); }
export function readDashboardSectionFallback() { return deps().readDashboardSectionFallback(); }
export function writeDashboardSectionFallback(s) { return deps().writeDashboardSectionFallback(s); }
export function apiCall(url, options) { return deps().apiCall(url, options); }
export function t(key, params) { return deps().t(key, params); }
export function showToast(message, type) { return deps().showToast(message, type); }
export function dashApiErr(d, k) { return dashApiError(d, k); }
export function _nestedInteractiveTarget(event) {
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
export function _eventPoint(event) {
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
export function _scheduleDashboardCloneMove(st, clientX, clientY) {
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
export function _scheduleDashboardPanelCloneMove(st, clientX, clientY) {
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
export function _clearDashboardPanelDelay() {
    if (!dragResizeState.panelDelay)
        return;
    clearTimeout(dragResizeState.panelDelay.timer);
    dragResizeState.panelDelay.cleanup?.();
    dragResizeState.panelDelay = null;
}
// Home Assistant-style press-and-hold gate for touch input. A normal finger
// swipe (movement >10px before the timer) keeps scrolling the page; only a
// deliberate ~140ms hold starts the drag. Returns true when it has deferred the
// start (caller should stop), false for non-touch input (caller starts now).
export function _touchHoldGate(event, begin) {
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
    dragResizeState.panelDelay = {
        cleanup,
        timer: setTimeout(() => {
            cleanup();
            dragResizeState.panelDelay = null;
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
