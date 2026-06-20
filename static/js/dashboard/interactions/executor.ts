/**
 * Execute dashboard card interaction actions.
 */

import { showToast } from '../../utils.js';
import { t } from '../../lang/index.js';
import { toggleDashboardWidget } from '../widget_toggle.js';
import { performCardDomainAction } from './perform_action.js';
import { resolveEffectiveInteraction } from './resolver.js';
import type { DashboardWidgetLike, InteractionGesture, InteractionSpec } from './types.js';

export interface InteractionExecutorDeps {
  findWidget: (widgetId: string) => DashboardWidgetLike | null | undefined;
  getEditMode: () => boolean;
  controlPending: (widgetId: string) => boolean;
  openMoreInfo?: (widget: DashboardWidgetLike, spec: InteractionSpec) => void | Promise<void>;
  openHistory?: (widget: DashboardWidgetLike, spec: InteractionSpec) => void | Promise<void>;
  navigatePage?: (pageId: string) => void;
}

let _deps: InteractionExecutorDeps | null = null;

export function initDashboardInteractionExecutor(deps: InteractionExecutorDeps): void {
  _deps = deps;
}

function deps(): InteractionExecutorDeps {
  if (!_deps) throw new Error('Dashboard interaction executor not initialized');
  return _deps;
}

async function runToggle(widgetId: string, spec: InteractionSpec): Promise<void> {
  if (spec.confirmation) {
    const ok = window.confirm(t('dashboard.interactions.confirm_toggle') || 'Toggle this entity?');
    if (!ok) return;
  }
  await toggleDashboardWidget(widgetId);
}

async function runAction(widget: DashboardWidgetLike, widgetId: string, spec: InteractionSpec): Promise<void> {
  const d = deps();
  switch (spec.action) {
  case 'none':
    return;
  case 'toggle':
    await runToggle(widgetId, spec);
    return;
  case 'more_info':
    if (d.openMoreInfo) {
      await d.openMoreInfo(widget, spec);
      return;
    }
    return;
  case 'history':
    if (d.openHistory) {
      await d.openHistory(widget, spec);
      return;
    }
    return;
  case 'perform_action':
    await performCardDomainAction(widget, spec);
    return;
  case 'navigate':
    if (spec.page_id && d.navigatePage) {
      d.navigatePage(spec.page_id);
      return;
    }
    showToast(t('dashboard.interactions.navigate_missing') || 'Page not configured', 'warning');
    return;
  case 'url':
    if (spec.url) {
      const prompt = t('dashboard.interactions.confirm_url') || 'Open this link in a new tab?';
      const ok = window.confirm(`${prompt}\n\n${spec.url}`);
      if (!ok) return;
      window.open(spec.url, '_blank', 'noopener,noreferrer');
      return;
    }
    showToast(t('dashboard.interactions.url_missing') || 'URL not configured', 'warning');
    return;
  default:
    return;
  }
}

export async function executeCardInteraction(widgetId: string, gesture: InteractionGesture): Promise<void> {
  const d = deps();
  if (d.getEditMode()) return;
  if (d.controlPending(widgetId)) return;
  const widget = d.findWidget(widgetId);
  if (!widget) return;
  const spec = resolveEffectiveInteraction(widget, gesture);
  if (spec.action === 'none') return;
  await runAction(widget, widgetId, spec);
}

export async function executeCardTap(widgetId: string): Promise<void> {
  await executeCardInteraction(widgetId, 'tap');
}

export async function executeCardDoubleTap(widgetId: string): Promise<void> {
  await executeCardInteraction(widgetId, 'double_tap');
}

export async function executeCardHold(widgetId: string): Promise<void> {
  await executeCardInteraction(widgetId, 'hold');
}
