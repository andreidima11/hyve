/**
 * Shared deps, module state, and small helpers for dashboard drag/resize.
 */

import { dashApiError } from '../helpers.js';
import type { ApiCallOptions } from '../../api.js';
import type {
    DashboardDragResizeDeps,
    DashboardMoveState,
    DashboardPanelDragState,
    DashboardResizeState,
    DashboardTouchHoldDelay,
} from '../../types/drag_resize.js';
import type { DashboardPanel, DashboardWidget } from '../../types/dashboard.js';

export function _errMsg(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err ?? '');
}

export function _asPointerEvent(event: Event): PointerEvent {
    return event as PointerEvent;
}

export function _asHTMLElement(el: Element | null | undefined): HTMLElement | null {
    return el instanceof HTMLElement ? el : null;
}

export function _gridEl(el: Element | null | undefined): HTMLElement | null {
    const node = el?.closest?.('[data-panel-grid]') ?? el;
    return _asHTMLElement(node);
}

export const dragResizeState = {
    deps: null as DashboardDragResizeDeps | null,
    moveState: null as DashboardMoveState | null,
    panelDragState: null as DashboardPanelDragState | null,
    panelLayoutPriorityId: null as string | null,
    resizeState: null as DashboardResizeState | null,
    panelDelay: null as DashboardTouchHoldDelay | null,
};

export function initDashboardDragResize(deps: DashboardDragResizeDeps): void {
    dragResizeState.deps = deps;
}

export function deps(): DashboardDragResizeDeps {
    if (!dragResizeState.deps) throw new Error('Dashboard drag/resize not initialized');
    return dragResizeState.deps;
}

export function getCache() { return deps().getCache(); }
export function getCurrentPageId() { return deps().getCurrentPageId(); }
export function getEditMode() { return deps().getEditMode(); }
export function findWidget(id: string) { return deps().findWidget(id); }
export function widgetSpan(w: DashboardWidget) { return deps().widgetSpan(w); }
export function panelColSpan(p: DashboardPanel) { return deps().panelColSpan(p); }
export function isStandalonePanel(p: DashboardPanel) { return deps().isStandalonePanel(p); }
export function ensureStandalonePanelLocal() { return deps().ensureStandalonePanelLocal(); }
export function renderDashboard() { return deps().renderDashboard(); }
export function loadDashboard() { return deps().loadDashboard(); }
export function readDashboardSectionFallback() { return deps().readDashboardSectionFallback(); }
export function writeDashboardSectionFallback(s: Record<string, unknown>) { return deps().writeDashboardSectionFallback(s); }
export function apiCall(url: string, options?: ApiCallOptions) { return deps().apiCall(url, options); }
export function t(key: string, params?: Record<string, unknown>) { return deps().t(key, params); }
export function showToast(message: string, type?: string) { return deps().showToast(message, type); }
export function dashApiErr(d: unknown, k: string) { return dashApiError(d, k); }

export function _nestedInteractiveTarget(event: Event | undefined | null) {
    const target = event?.target as Element | null;
    if (!target?.closest) return null;
    const interactive = (target as Element).closest('button, a, input, select, textarea, label, [role="button"]');
    if (!interactive) return null;
    const current = event?.currentTarget;
    if (current && interactive === current) return null;
    return interactive;
}

export function _eventPoint(event: Event | undefined | null): { x: number; y: number } | null {
    if (!event) return null;
    const te = event as TouchEvent;
    const touch = te.touches?.[0] || te.changedTouches?.[0];
    if (touch) return { x: touch.clientX, y: touch.clientY };
    const pe = event as PointerEvent | MouseEvent;
    if (Number.isFinite(pe.clientX) && Number.isFinite(pe.clientY)) {
        return { x: pe.clientX, y: pe.clientY };
    }
    return null;
}

export function _scheduleDashboardCloneMove(st: DashboardMoveState | DashboardPanelDragState | null | undefined, clientX: number, clientY: number) {
    if (!st) return;
    st.nextCloneX = clientX - st.pointerOffsetX - st.cloneBaseLeft;
    st.nextCloneY = clientY - st.pointerOffsetY - st.cloneBaseTop;
    if (st.cloneFrame) return;
    st.cloneFrame = requestAnimationFrame(() => {
        st.cloneFrame = 0;
        if (!st.clone?.isConnected) return;
        st.clone.style.transform = `translate3d(${st.nextCloneX}px, ${st.nextCloneY}px, 0)`;
    });
}

export function _scheduleDashboardPanelCloneMove(st: DashboardPanelDragState, clientX: number, clientY: number) {
    if (!st) return;
    st.nextCloneX = clientX - st.pointerOffsetX - st.cloneBaseLeft;
    st.nextCloneY = clientY - st.pointerOffsetY - st.cloneBaseTop;
    if (st.cloneFrame) return;
    st.cloneFrame = requestAnimationFrame(() => {
        st.cloneFrame = 0;
        if (!st.clone?.isConnected) return;
        st.clone.style.transform = `translate3d(${st.nextCloneX}px, ${st.nextCloneY}px, 0)`;
    });
}

export function _clearDashboardPanelDelay() {
    if (!dragResizeState.panelDelay) return;
    clearTimeout(dragResizeState.panelDelay.timer);
    dragResizeState.panelDelay.cleanup?.();
    dragResizeState.panelDelay = null;
}

// Home Assistant-style press-and-hold gate for touch input. A normal finger
// swipe (movement >10px before the timer) keeps scrolling the page; only a
// deliberate ~140ms hold starts the drag. Returns true when it has deferred the
// start (caller should stop), false for non-touch input (caller starts now).
export function _touchHoldGate(event: PointerEvent, begin: (synthetic: PointerEvent) => void) {
    if (event.pointerType !== 'touch') return false;
    event.stopPropagation?.();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    _clearDashboardPanelDelay();

    const cancel = (e?: PointerEvent) => {
        if (e?.type === 'pointermove' && Math.hypot(e.clientX - startX, e.clientY - startY) <= 10) return;
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
            if (navigator.vibrate) { try { navigator.vibrate(8); } catch (_) {} }
            begin({
                pointerType: 'touch',
                pointerId,
                clientX: startX,
                clientY: startY,
                currentTarget: handle,
                target: handle,
                preventDefault() {},
                stopPropagation() {},
            } as PointerEvent);
        }, 140),
    };
    document.addEventListener('pointermove', cancel, { passive: true });
    document.addEventListener('pointerup', cancel, { passive: true });
    document.addEventListener('pointercancel', cancel, { passive: true });
    return true;
}
