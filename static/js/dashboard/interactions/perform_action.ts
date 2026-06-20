/**
 * Domain-specific card actions for perform_action interactions.
 */

import { stateOn } from '../helpers.js';
import {
  onDashboardLawnMowerAction,
  onDashboardLockAction,
  onDashboardVacuumAction,
} from '../widget_actions.js';
import { toggleDashboardWidget } from '../widget_toggle.js';
import type { DashboardWidgetLike, InteractionSpec } from './types.js';

const LOCKED_STATES = new Set(['locked', 'locking']);
const VACUUM_ACTIVE = new Set(['cleaning', 'returning']);
const MOWER_ACTIVE = new Set(['mowing', 'returning']);

function entityDomain(widget: DashboardWidgetLike): string {
  const domain = String(widget.domain || '').trim().toLowerCase();
  if (domain) return domain;
  const entityId = String(widget.entity_id || '').trim();
  const dot = entityId.indexOf('.');
  return dot > 0 ? entityId.slice(0, dot).toLowerCase() : '';
}

function vacuumDefaultAction(state: string): string {
  const value = state.toLowerCase();
  if (VACUUM_ACTIVE.has(value)) return 'pause';
  if (value === 'paused') return 'start';
  return 'start';
}

function lawnMowerDefaultAction(state: string): string {
  const value = state.toLowerCase();
  if (MOWER_ACTIVE.has(value)) return 'pause';
  if (value === 'paused') return 'start';
  return 'start';
}

function lockDefaultAction(state: string): string {
  return LOCKED_STATES.has(String(state || '').toLowerCase()) ? 'unlock' : 'lock';
}

export function resolvePerformAction(widget: DashboardWidgetLike, spec: InteractionSpec): string {
  const explicit = String(spec.perform || spec.action_id || '').trim();
  if (explicit && explicit !== 'domain_default') return explicit;

  const domain = entityDomain(widget);
  const state = String(widget.current_state || 'unknown');

  if (domain === 'lock') return lockDefaultAction(state);
  if (domain === 'vacuum') return vacuumDefaultAction(state);
  if (domain === 'lawn_mower') return lawnMowerDefaultAction(state);
  if (domain === 'scene' || domain === 'button' || domain === 'script') return 'activate';
  if (domain === 'cover') return stateOn(state) ? 'close' : 'open';
  return 'toggle';
}

export async function performCardDomainAction(
  widget: DashboardWidgetLike,
  spec: InteractionSpec,
): Promise<void> {
  const widgetId = String(widget.id || '').trim();
  if (!widgetId) return;

  const domain = entityDomain(widget);
  const action = resolvePerformAction(widget, spec);

  if (action === 'activate' || domain === 'scene' || domain === 'button' || domain === 'script') {
    await toggleDashboardWidget(widgetId);
    return;
  }

  if (domain === 'lock' && (action === 'lock' || action === 'unlock')) {
    await onDashboardLockAction(widgetId, action);
    return;
  }

  if (domain === 'vacuum') {
    await onDashboardVacuumAction(widgetId, action);
    return;
  }

  if (domain === 'lawn_mower') {
    await onDashboardLawnMowerAction(widgetId, action);
    return;
  }

  if (action === 'toggle' || action === 'open' || action === 'close') {
    await toggleDashboardWidget(widgetId);
    return;
  }

  await toggleDashboardWidget(widgetId);
}

export function performOptionsForDomain(domain: string): Array<{ value: string; labelKey: string }> {
  const d = String(domain || '').toLowerCase();
  const base = [{ value: 'domain_default', labelKey: 'dashboard.interactions.perform_default' }];
  if (d === 'lock') {
    return [
      ...base,
      { value: 'lock', labelKey: 'dashboard.interactions.perform_lock' },
      { value: 'unlock', labelKey: 'dashboard.interactions.perform_unlock' },
    ];
  }
  if (d === 'vacuum' || d === 'lawn_mower') {
    return [
      ...base,
      { value: 'start', labelKey: 'dashboard.interactions.perform_start' },
      { value: 'pause', labelKey: 'dashboard.interactions.perform_pause' },
      { value: 'stop', labelKey: 'dashboard.interactions.perform_stop' },
      { value: 'return_to_base', labelKey: 'dashboard.interactions.perform_dock' },
    ];
  }
  if (d === 'scene' || d === 'button' || d === 'script') {
    return [
      ...base,
      { value: 'activate', labelKey: 'dashboard.interactions.perform_activate' },
    ];
  }
  return base;
}
