/**
 * Default tap / double-tap / hold actions per entity domain and renderer.
 * Keep in sync with core/dashboard/interactions.py.
 */

import * as HVBridge from '/static/hyveview/bridge.js';
import type { DashboardWidgetLike, InteractionGesture, InteractionMap, InteractionSpec } from './types.js';

const GESTURES: InteractionGesture[] = ['tap', 'double_tap', 'hold'];

const READ_ONLY_RENDERERS = new Set(['label', 'info', 'weather', 'weather_rich', 'picture', 'fusion_solar']);
const INLINE_CONTROL_RENDERERS = new Set(['light', 'climate', 'number', 'select']);
const TOGGLE_DOMAINS = new Set(['switch', 'input_boolean', 'light', 'fan', 'cover']);
const TILE_DOMAINS = new Set(['cover', 'fan', 'media_player']);
const ONE_SHOT_DOMAINS = new Set(['scene', 'button', 'script']);

function entityDomain(widget: DashboardWidgetLike | null | undefined): string {
  const domain = String(widget?.domain || '').trim().toLowerCase();
  if (domain) return domain;
  const entityId = String(widget?.entity_id || '').trim();
  const dot = entityId.indexOf('.');
  return dot > 0 ? entityId.slice(0, dot).toLowerCase() : '';
}

function effectiveRenderer(widget: DashboardWidgetLike | null | undefined): string {
  if (!widget) return 'info';
  const renderer = String(widget.renderer || '').trim().toLowerCase();
  if (widget.type === 'entity' || renderer === 'entity') {
    return HVBridge.resolveEntityEffectiveType({
      entity_id: widget.entity_id,
      domain: widget.domain || entityDomain(widget),
      switch_style: widget.switch_style,
      renderer: widget.renderer,
      type: widget.type,
    }).effectiveType;
  }
  return renderer || 'info';
}

function supportsNumericHistory(widget: DashboardWidgetLike | null | undefined): boolean {
  return entityDomain(widget) === 'sensor';
}

export function defaultInteractionsForWidget(widget: DashboardWidgetLike | null | undefined): InteractionMap {
  const renderer = effectiveRenderer(widget);
  const domain = entityDomain(widget);
  const switchStyle = Boolean(widget?.switch_style);

  if (READ_ONLY_RENDERERS.has(renderer) || ['weather', 'person', 'sun', 'device_tracker', 'update'].includes(domain)) {
    return { tap: { action: 'none' }, double_tap: { action: 'none' }, hold: { action: 'none' } };
  }

  if (INLINE_CONTROL_RENDERERS.has(renderer)) {
    return {
      tap: { action: 'none' },
      double_tap: { action: TOGGLE_DOMAINS.has(domain) || switchStyle ? 'toggle' : 'more_info' },
      hold: { action: 'more_info' },
    };
  }

  if (ONE_SHOT_DOMAINS.has(domain) || renderer === 'scene' || renderer === 'button') {
    return {
      tap: { action: 'perform_action', perform: 'domain_default' },
      double_tap: { action: 'more_info' },
      hold: { action: 'none' },
    };
  }

  if (['lock', 'vacuum', 'lawn_mower'].includes(domain) || ['lock', 'vacuum', 'lawn_mower'].includes(renderer)) {
    return {
      tap: { action: 'more_info' },
      double_tap: { action: 'perform_action', perform: 'domain_default' },
      hold: { action: 'none' },
    };
  }

  if (domain === 'sensor' || renderer === 'sensor') {
    const tap: InteractionSpec = supportsNumericHistory(widget)
      ? { action: 'history', hours: 24 }
      : { action: 'more_info' };
    return { tap, double_tap: { action: 'more_info' }, hold: { action: 'none' } };
  }

  if (TOGGLE_DOMAINS.has(domain) || switchStyle || renderer === 'switch' || renderer === 'tile' || TILE_DOMAINS.has(domain)) {
    return {
      tap: { action: 'toggle' },
      double_tap: { action: 'more_info' },
      hold: supportsNumericHistory(widget) ? { action: 'history', hours: 24 } : { action: 'more_info' },
    };
  }

  if (renderer === 'camera') {
    return { tap: { action: 'more_info' }, double_tap: { action: 'none' }, hold: { action: 'none' } };
  }

  return { tap: { action: 'more_info' }, double_tap: { action: 'none' }, hold: { action: 'none' } };
}

function widgetConfig(widget: DashboardWidgetLike | null | undefined): Record<string, unknown> {
  const config = widget?.config;
  return config && typeof config === 'object' ? config : {};
}

export function storedInteractions(widget: DashboardWidgetLike | null | undefined): InteractionMap | null {
  if (!widget) return null;
  const config = widgetConfig(widget);
  const fromConfig = config.interactions;
  if (fromConfig && typeof fromConfig === 'object') {
    return fromConfig as InteractionMap;
  }
  const top = widget.interactions;
  if (top && typeof top === 'object') {
    return top as InteractionMap;
  }
  return null;
}

export function resolveEffectiveInteraction(
  widget: DashboardWidgetLike | null | undefined,
  gesture: InteractionGesture,
): InteractionSpec {
  const defaults = defaultInteractionsForWidget(widget);
  const stored = storedInteractions(widget);
  const override = stored?.[gesture];
  if (override?.action) return { ...override };
  return { ...(defaults[gesture] || { action: 'none' }) };
}

export function resolveEffectiveInteractions(
  widget: DashboardWidgetLike | null | undefined,
): Record<InteractionGesture, InteractionSpec> {
  return GESTURES.reduce((acc, gesture) => {
    acc[gesture] = resolveEffectiveInteraction(widget, gesture);
    return acc;
  }, {} as Record<InteractionGesture, InteractionSpec>);
}

export function widgetHasAction(widget: DashboardWidgetLike | null | undefined, gesture: InteractionGesture): boolean {
  return resolveEffectiveInteraction(widget, gesture).action !== 'none';
}

export function widgetIsInteractive(widget: DashboardWidgetLike | null | undefined): boolean {
  return GESTURES.some((gesture) => widgetHasAction(widget, gesture));
}
