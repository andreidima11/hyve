/**
 * Dashboard card interaction types (shared with hyveview defaults).
 */

export type InteractionGesture = 'tap' | 'double_tap' | 'hold';
export type InteractionAction =
  | 'none'
  | 'toggle'
  | 'more_info'
  | 'history'
  | 'perform_action'
  | 'navigate'
  | 'url';

export interface InteractionSpec {
  action: InteractionAction;
  hours?: number;
  perform?: string;
  action_id?: string;
  page_id?: string;
  url?: string;
  tab?: 'overview' | 'history' | 'attributes';
  confirmation?: boolean;
}

export type InteractionMap = Partial<Record<InteractionGesture, InteractionSpec>>;

export interface DashboardWidgetLike {
  id?: string;
  type?: string;
  renderer?: string;
  entity_id?: string;
  entity_name?: string;
  title?: string;
  domain?: string;
  source?: string;
  switch_style?: boolean;
  controllable?: boolean;
  available?: boolean;
  current_state?: string | number | null;
  attributes?: Record<string, unknown>;
  unit?: string;
  config?: Record<string, unknown> | null;
  interactions?: Partial<Record<InteractionGesture, InteractionSpec>>;
}
