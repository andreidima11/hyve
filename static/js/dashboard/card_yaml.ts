/**
 * Serialize / parse dashboard card config as YAML (editor + API helpers).
 */

import { parse, stringify } from 'yaml';

export interface CardYamlInput {
  type: string;
  entity?: string | null;
  layout?: { col?: number; row?: number };
  config?: Record<string, unknown>;
  visibility?: Record<string, unknown> | null;
}

function stripEmpty(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (val == null || val === '') continue;
    if (typeof val === 'object' && !Array.isArray(val)) {
      const nested = stripEmpty(val as Record<string, unknown>);
      if (Object.keys(nested).length) out[key] = nested;
      continue;
    }
    if (Array.isArray(val) && !val.length) continue;
    out[key] = val;
  }
  return out;
}

export function buildCardYamlDict(input: CardYamlInput): Record<string, unknown> {
  const cfg = { ...(input.config && typeof input.config === 'object' ? input.config : {}) };
  const interactions = cfg.interactions;
  if (interactions) delete cfg.interactions;

  const raw: Record<string, unknown> = { type: input.type || 'entity' };
  const entityId = String(input.entity || cfg.entity_id || '').trim();
  if (entityId) raw.entity_id = entityId;
  if (input.layout?.col) raw.col_span = input.layout.col;
  if (input.layout?.row) raw.row_span = input.layout.row;
  if (Object.keys(cfg).length) raw.config = cfg;
  if (interactions && typeof interactions === 'object') raw.interactions = interactions;
  if (input.visibility && typeof input.visibility === 'object') raw.visibility = input.visibility;
  return stripEmpty(raw);
}

export function cardToYamlText(input: CardYamlInput): string {
  return stringify(buildCardYamlDict(input), { lineWidth: 0 }).trim();
}

export function parseCardYamlText(text: string): Record<string, unknown> {
  const parsed = parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('YAML root must be a mapping');
  }
  return parsed as Record<string, unknown>;
}

export function cardYamlToEditorFields(parsed: Record<string, unknown>): {
  type: string;
  entity: string;
  layout: { col: number; row: number };
  config: Record<string, unknown>;
  visibility: Record<string, unknown> | null;
} {
  const config = parsed.config && typeof parsed.config === 'object'
    ? { ...(parsed.config as Record<string, unknown>) }
    : {};
  if (parsed.interactions && typeof parsed.interactions === 'object') {
    config.interactions = parsed.interactions;
  }
  const entity = String(parsed.entity_id || config.entity_id || '').trim();
  if (entity) config.entity_id = entity;
  return {
    type: String(parsed.type || 'entity'),
    entity,
    layout: {
      col: Math.min(Math.max(Number(parsed.col_span) || 4, 1), 12),
      row: Math.min(Math.max(Number(parsed.row_span) || 2, 1), 12),
    },
    config,
    visibility: (parsed.visibility && typeof parsed.visibility === 'object'
      ? parsed.visibility
      : null) as Record<string, unknown> | null,
  };
}
