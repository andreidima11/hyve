/**
 * Resolve effective card interactions (stored overrides + domain defaults).
 */

import {
  defaultInteractionsForWidget,
  resolveEffectiveInteraction as resolveDefault,
  widgetHasAction as hasAction,
  widgetIsInteractive as isInteractive,
} from './defaults.js';
import type { DashboardWidgetLike, InteractionGesture, InteractionSpec } from './types.js';

export function resolveEffectiveInteraction(
  widget: DashboardWidgetLike | null | undefined,
  gesture: InteractionGesture,
): InteractionSpec {
  return resolveDefault(widget, gesture);
}

export function widgetHasAction(widget: DashboardWidgetLike | null | undefined, gesture: InteractionGesture): boolean {
  return hasAction(widget, gesture);
}

export function widgetIsInteractive(widget: DashboardWidgetLike | null | undefined): boolean {
  return isInteractive(widget);
}

export function defaultInteractions(widget: DashboardWidgetLike | null | undefined) {
  return defaultInteractionsForWidget(widget);
}

export function cardIsClickable(
  widget: DashboardWidgetLike | null | undefined,
  editMode: boolean,
): boolean {
  if (editMode) return false;
  if (widget?.available === false && !String(widget?.entity_id || '').trim()) return false;
  return widgetIsInteractive(widget);
}
