/**
 * Pointer gesture detection for dashboard cards (tap / double-tap / hold).
 */

import { executeCardDoubleTap, executeCardHold, executeCardTap } from './executor.js';

const TAP_MAX_MS = 300;
const HOLD_MS = 500;
const DOUBLE_TAP_MS = 350;
const MOVE_CANCEL_PX = 12;

interface TouchState {
  widgetId: string;
  pointerId: number;
  startX: number;
  startY: number;
  startAt: number;
  holdTimer: number | null;
  holdFired: boolean;
}

let _lastTap: { widgetId: string; at: number } | null = null;
let _active: TouchState | null = null;

function articleFromEvent(event: Event): HTMLElement | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const article = target.closest('article[data-dashboard-widget-id], article[data-widget-id]');
  return article instanceof HTMLElement ? article : null;
}

function widgetIdFromArticle(article: HTMLElement): string {
  return article.dataset.dashboardWidgetId || article.dataset.widgetId || '';
}

function nestedInteractiveTarget(event: Event, article: HTMLElement): Element | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const interactive = target.closest('button, a, input, select, textarea, label, [role="button"]');
  if (!interactive) return null;
  if (interactive === article) return null;
  if (interactive.getAttribute('data-dash-action') === 'cardActivate') return null;
  return interactive;
}

function clearHoldTimer(state: TouchState | null): void {
  if (!state?.holdTimer) return;
  window.clearTimeout(state.holdTimer);
  state.holdTimer = null;
}

function setHoldProgress(article: HTMLElement | null, active: boolean): void {
  if (!article) return;
  article.dataset.holdActive = active ? 'true' : 'false';
}

export function handleDashboardCardPointerDown(event: PointerEvent): void {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  const article = articleFromEvent(event);
  if (!article || article.getAttribute('data-clickable') !== 'true') return;
  if (nestedInteractiveTarget(event, article)) return;

  const widgetId = widgetIdFromArticle(article);
  if (!widgetId) return;

  clearHoldTimer(_active);
  _active = {
    widgetId,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    startAt: Date.now(),
    holdTimer: null,
    holdFired: false,
  };

  _active.holdTimer = window.setTimeout(() => {
    if (!_active || _active.widgetId !== widgetId) return;
    _active.holdFired = true;
    setHoldProgress(article, true);
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(10);
    }
    void executeCardHold(widgetId);
  }, HOLD_MS);

  article.setPointerCapture?.(event.pointerId);
}

export function handleDashboardCardPointerMove(event: PointerEvent): void {
  if (!_active || _active.pointerId !== event.pointerId) return;
  const dx = Math.abs(event.clientX - _active.startX);
  const dy = Math.abs(event.clientY - _active.startY);
  if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) {
    clearHoldTimer(_active);
    _active = null;
  }
}

export function handleDashboardCardPointerUp(event: PointerEvent): void {
  if (!_active || _active.pointerId !== event.pointerId) return;
  const article = articleFromEvent(event);
  const state = _active;
  _active = null;
  clearHoldTimer(state);
  setHoldProgress(article, false);

  if (state.holdFired) return;

  const elapsed = Date.now() - state.startAt;
  if (elapsed >= HOLD_MS) return;

  const now = Date.now();
  if (
    _lastTap
    && _lastTap.widgetId === state.widgetId
    && now - _lastTap.at <= DOUBLE_TAP_MS
  ) {
    _lastTap = null;
    void executeCardDoubleTap(state.widgetId);
    return;
  }

  _lastTap = { widgetId: state.widgetId, at: now };
  window.setTimeout(() => {
    if (!_lastTap || _lastTap.widgetId !== state.widgetId || _lastTap.at !== now) return;
    _lastTap = null;
    if (elapsed <= TAP_MAX_MS) {
      void executeCardTap(state.widgetId);
    }
  }, DOUBLE_TAP_MS + 10);
}

export function handleDashboardCardPointerCancel(event: PointerEvent): void {
  if (!_active || _active.pointerId !== event.pointerId) return;
  clearHoldTimer(_active);
  setHoldProgress(articleFromEvent(event), false);
  _active = null;
}

export function initDashboardCardGestures(root: ParentNode = document): void {
  const host = root instanceof HTMLElement ? root : null;
  if (host?.dataset.cardGesturesBound === 'true') return;
  if (host) host.dataset.cardGesturesBound = 'true';
  root.addEventListener('pointerdown', handleDashboardCardPointerDown as EventListener);
  root.addEventListener('pointermove', handleDashboardCardPointerMove as EventListener);
  root.addEventListener('pointerup', handleDashboardCardPointerUp as EventListener);
  root.addEventListener('pointercancel', handleDashboardCardPointerCancel as EventListener);
}
