/**
 * Human-readable interaction previews for the card editor.
 */

import { t } from '../../lang/index.js';
import { resolveEffectiveInteraction } from './defaults.js';
import type { DashboardWidgetLike, InteractionGesture, InteractionSpec } from './types.js';

function _label(key: string, fallback: string): string {
  const out = t(key);
  return out !== key ? out : fallback;
}

export function cardLikeFromEditor(card: {
  entity?: string | null;
  type?: string;
  config?: Record<string, unknown>;
}): DashboardWidgetLike {
  const entityId = String(card.entity || card.config?.entity_id || '').trim();
  const dot = entityId.indexOf('.');
  const domain = dot > 0 ? entityId.slice(0, dot).toLowerCase() : '';
  return {
    entity_id: entityId,
    domain,
    type: card.type || 'entity',
    renderer: String(card.config?.renderer || ''),
    config: card.config && typeof card.config === 'object' ? card.config : {},
  };
}

function resolvePreviewSpec(
  widget: DashboardWidgetLike,
  gesture: InteractionGesture,
  override?: Partial<InteractionSpec> | null,
): InteractionSpec {
  if (!override?.action) {
    return resolveEffectiveInteraction(widget, gesture);
  }
  const base = resolveEffectiveInteraction(widget, gesture);
  return { ...base, ...override, action: override.action as InteractionSpec['action'] };
}

function performLabel(perform?: string): string {
  const key = perform && perform !== 'domain_default'
    ? `dashboard.interactions.perform_${perform}`
    : 'dashboard.interactions.perform_default';
  return _label(key, perform || 'default');
}

export function describeInteractionPreview(
  widget: DashboardWidgetLike,
  gesture: InteractionGesture,
  override?: Partial<InteractionSpec> | null,
): string {
  const spec = resolvePreviewSpec(widget, gesture, override);
  const entity = String(widget.entity_name || widget.title || widget.entity_id || 'entity');

  switch (spec.action) {
  case 'none':
    return _label('dashboard.interactions.preview_none', 'Does nothing');
  case 'toggle':
    return spec.confirmation
      ? _label('dashboard.interactions.preview_toggle_confirm', 'Toggles {entity} (with confirmation)').replace('{entity}', entity)
      : _label('dashboard.interactions.preview_toggle', 'Toggles {entity}').replace('{entity}', entity);
  case 'more_info':
    return _label('dashboard.interactions.preview_more_info', 'Opens details for {entity}').replace('{entity}', entity);
  case 'history': {
    const hours = Number(spec.hours) || 24;
    return _label('dashboard.interactions.preview_history', 'Shows {hours}h history for {entity}')
      .replace('{hours}', String(hours))
      .replace('{entity}', entity);
  }
  case 'perform_action':
    return _label('dashboard.interactions.preview_perform', 'Runs {action} on {entity}')
      .replace('{action}', performLabel(spec.perform))
      .replace('{entity}', entity);
  case 'navigate':
    return spec.page_id
      ? _label('dashboard.interactions.preview_navigate', 'Opens page “{page}”')
        .replace('{page}', spec.page_id)
      : _label('dashboard.interactions.preview_navigate_missing', 'Opens a dashboard page (not configured)');
  case 'url':
    return spec.url
      ? _label('dashboard.interactions.preview_url', 'Opens link (with confirmation)')
      : _label('dashboard.interactions.preview_url_missing', 'Opens a URL (not configured)');
  default:
    return _label('dashboard.interactions.preview_none', 'Does nothing');
  }
}
