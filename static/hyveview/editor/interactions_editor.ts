/**
 * Card interaction editor (tap / double-tap / hold) for the Hyveview card modal.
 */

import { t } from '../../js/lang/index.js';
import { host } from '../host.js';
import type { HyveviewEditorCard } from '../types/editor.js';

type GestureKey = 'tap' | 'double_tap' | 'hold';
type ActionKey =
  | ''
  | 'none'
  | 'toggle'
  | 'more_info'
  | 'history'
  | 'perform_action'
  | 'navigate'
  | 'url';

interface InteractionRowState {
  action: ActionKey;
  hours: number;
  confirmation: boolean;
  perform: string;
  page_id: string;
  url: string;
}

const GESTURES: GestureKey[] = ['tap', 'double_tap', 'hold'];

const ACTION_OPTIONS: Array<{ value: ActionKey; labelKey: string }> = [
  { value: '', labelKey: 'dashboard.interactions.action_default' },
  { value: 'none', labelKey: 'dashboard.interactions.action_none' },
  { value: 'toggle', labelKey: 'dashboard.interactions.action_toggle' },
  { value: 'more_info', labelKey: 'dashboard.interactions.action_more_info' },
  { value: 'history', labelKey: 'dashboard.interactions.action_history' },
  { value: 'perform_action', labelKey: 'dashboard.interactions.action_perform' },
  { value: 'navigate', labelKey: 'dashboard.interactions.action_navigate' },
  { value: 'url', labelKey: 'dashboard.interactions.action_url' },
];

const HOUR_OPTIONS = [1, 6, 24, 168];

const PERFORM_OPTIONS: Record<string, Array<{ value: string; labelKey: string }>> = {
  lock: [
    { value: 'domain_default', labelKey: 'dashboard.interactions.perform_default' },
    { value: 'lock', labelKey: 'dashboard.interactions.perform_lock' },
    { value: 'unlock', labelKey: 'dashboard.interactions.perform_unlock' },
  ],
  vacuum: [
    { value: 'domain_default', labelKey: 'dashboard.interactions.perform_default' },
    { value: 'start', labelKey: 'dashboard.interactions.perform_start' },
    { value: 'pause', labelKey: 'dashboard.interactions.perform_pause' },
    { value: 'stop', labelKey: 'dashboard.interactions.perform_stop' },
    { value: 'return_to_base', labelKey: 'dashboard.interactions.perform_dock' },
  ],
  lawn_mower: [
    { value: 'domain_default', labelKey: 'dashboard.interactions.perform_default' },
    { value: 'start', labelKey: 'dashboard.interactions.perform_start' },
    { value: 'pause', labelKey: 'dashboard.interactions.perform_pause' },
    { value: 'stop', labelKey: 'dashboard.interactions.perform_stop' },
    { value: 'return_to_base', labelKey: 'dashboard.interactions.perform_dock' },
  ],
  scene: [
    { value: 'domain_default', labelKey: 'dashboard.interactions.perform_default' },
    { value: 'activate', labelKey: 'dashboard.interactions.perform_activate' },
  ],
  button: [
    { value: 'domain_default', labelKey: 'dashboard.interactions.perform_default' },
    { value: 'activate', labelKey: 'dashboard.interactions.perform_activate' },
  ],
  script: [
    { value: 'domain_default', labelKey: 'dashboard.interactions.perform_default' },
    { value: 'activate', labelKey: 'dashboard.interactions.perform_activate' },
  ],
};

function _label(key: string, fallback: string): string {
  const out = t(key);
  return out !== key ? out : fallback;
}

function _entityDomain(card: HyveviewEditorCard): string {
  const entityId = String(card.entity || card.config?.entity_id || '').trim();
  const dot = entityId.indexOf('.');
  return dot > 0 ? entityId.slice(0, dot).toLowerCase() : '';
}

function _performOptions(card: HyveviewEditorCard): Array<{ value: string; labelKey: string }> {
  const domain = _entityDomain(card);
  return PERFORM_OPTIONS[domain] || [{ value: 'domain_default', labelKey: 'dashboard.interactions.perform_default' }];
}

function _dashboardPages(): Array<{ id: string; title?: string }> {
  if (typeof host.listDashboardPages === 'function') {
    return host.listDashboardPages();
  }
  return [];
}

function _emptyRow(): InteractionRowState {
  return {
    action: '',
    hours: 24,
    confirmation: false,
    perform: 'domain_default',
    page_id: '',
    url: '',
  };
}

function _readStored(card: HyveviewEditorCard): Partial<Record<GestureKey, InteractionRowState>> {
  const config = card.config && typeof card.config === 'object' ? card.config : {};
  const raw = (config.interactions && typeof config.interactions === 'object'
    ? config.interactions
    : {}) as Record<string, {
      action?: string;
      hours?: number;
      confirmation?: boolean;
      perform?: string;
      page_id?: string;
      url?: string;
    }>;
  const out: Partial<Record<GestureKey, InteractionRowState>> = {};
  for (const gesture of GESTURES) {
    const spec = raw[gesture];
    if (!spec || typeof spec !== 'object') continue;
    out[gesture] = {
      action: String(spec.action || '') as ActionKey,
      hours: Number(spec.hours) || 24,
      confirmation: spec.confirmation === true,
      perform: String(spec.perform || 'domain_default'),
      page_id: String(spec.page_id || ''),
      url: String(spec.url || ''),
    };
  }
  return out;
}

function _rowOverride(state: InteractionRowState): Record<string, unknown> | null {
  if (!state.action) return null;
  const out: Record<string, unknown> = { action: state.action };
  if (state.action === 'history') out.hours = state.hours;
  if (state.action === 'toggle' && state.confirmation) out.confirmation = true;
  if (state.action === 'perform_action' && state.perform && state.perform !== 'domain_default') {
    out.perform = state.perform;
  }
  if (state.action === 'navigate' && state.page_id) out.page_id = state.page_id;
  if (state.action === 'url' && state.url) out.url = state.url;
  return out;
}

function _previewText(card: HyveviewEditorCard, gesture: GestureKey, row: InteractionRowState): string {
  if (typeof host.describeCardInteraction === 'function') {
    return host.describeCardInteraction(card, gesture, _rowOverride(row));
  }
  if (!row.action) {
    return _label('dashboard.interactions.preview_auto', 'Uses smart default for this entity');
  }
  return _label('dashboard.interactions.preview_custom', 'Custom action configured');
}

export function renderInteractionsEditor(
  hostEl: HTMLElement,
  card: HyveviewEditorCard,
): { read(): Record<string, unknown> | undefined } {
  const stored = _readStored(card);
  const performOptions = _performOptions(card);
  const dashboardPages = _dashboardPages();
  const state: Record<GestureKey, InteractionRowState> = {
    tap: stored.tap || _emptyRow(),
    double_tap: stored.double_tap || _emptyRow(),
    hold: stored.hold || _emptyRow(),
  };

  hostEl.innerHTML = `
    <p class="hv-editor-hint">${_label('dashboard.interactions.editor_hint', 'Configure what happens on tap, double tap, and hold. Leave “Auto” to use smart defaults for this entity.')}</p>
    <div class="hv-interactions-toolbar">
      <button type="button" class="hv-btn-ghost hv-interactions-reset" data-role="reset-all">
        ${_label('dashboard.interactions.reset_defaults', 'Reset all to defaults')}
      </button>
    </div>
    <div class="hv-interactions-grid" data-role="interactions-grid"></div>
  `;

  const grid = hostEl.querySelector('[data-role=interactions-grid]') as HTMLElement;
  if (!grid) {
    return { read: () => undefined };
  }

  const gestureLabel = (gesture: GestureKey) => {
    if (gesture === 'tap') return _label('dashboard.interactions.tap', 'Tap');
    if (gesture === 'double_tap') return _label('dashboard.interactions.double_tap', 'Double tap');
    return _label('dashboard.interactions.hold', 'Hold');
  };

  const rowRefs: Array<{ gesture: GestureKey; row: HTMLElement }> = [];

  const paintExtras = (row: HTMLElement, gesture: GestureKey) => {
    const action = state[gesture].action;
    const hoursWrap = row.querySelector('[data-role=hours-wrap]') as HTMLElement | null;
    const performWrap = row.querySelector('[data-role=perform-wrap]') as HTMLElement | null;
    const confirmWrap = row.querySelector('[data-role=confirm-wrap]') as HTMLElement | null;
    const navigateWrap = row.querySelector('[data-role=navigate-wrap]') as HTMLElement | null;
    const urlWrap = row.querySelector('[data-role=url-wrap]') as HTMLElement | null;
    const previewEl = row.querySelector('[data-role=preview]') as HTMLElement | null;
    if (hoursWrap) hoursWrap.hidden = action !== 'history';
    if (performWrap) performWrap.hidden = action !== 'perform_action';
    if (confirmWrap) confirmWrap.hidden = action !== 'toggle';
    if (navigateWrap) navigateWrap.hidden = action !== 'navigate';
    if (urlWrap) urlWrap.hidden = action !== 'url';
    if (previewEl) previewEl.textContent = _previewText(card, gesture, state[gesture]);
  };

  for (const gesture of GESTURES) {
    const row = document.createElement('div');
    row.className = 'hv-interaction-row';
    row.innerHTML = `
      <label class="hv-field hv-interaction-row__gesture">
        <span>${gestureLabel(gesture)}</span>
        <select data-role="action"></select>
      </label>
      <label class="hv-field hv-interaction-row__hours" data-role="hours-wrap">
        <span>${_label('dashboard.interactions.history_hours', 'History range')}</span>
        <select data-role="hours"></select>
      </label>
      <label class="hv-field hv-interaction-row__perform" data-role="perform-wrap">
        <span>${_label('dashboard.interactions.perform_label', 'Action')}</span>
        <select data-role="perform"></select>
      </label>
      <label class="hv-field hv-interaction-row__navigate" data-role="navigate-wrap">
        <span>${_label('dashboard.interactions.navigate_page', 'Dashboard page')}</span>
        <select data-role="page"></select>
      </label>
      <label class="hv-field hv-interaction-row__url" data-role="url-wrap">
        <span>${_label('dashboard.interactions.url_label', 'URL')}</span>
        <input type="url" data-role="url" placeholder="https://…" />
      </label>
      <label class="hv-field hv-interaction-row__confirm hv-checkbox-field" data-role="confirm-wrap">
        <input type="checkbox" data-role="confirmation" />
        <span>${_label('dashboard.interactions.confirmation_label', 'Ask before toggling')}</span>
      </label>
      <p class="hv-interaction-preview" data-role="preview"></p>
    `;
    const actionSelect = row.querySelector('[data-role=action]') as HTMLSelectElement;
    const hoursSelect = row.querySelector('[data-role=hours]') as HTMLSelectElement;
    const performSelect = row.querySelector('[data-role=perform]') as HTMLSelectElement;
    const pageSelect = row.querySelector('[data-role=page]') as HTMLSelectElement;
    const urlInput = row.querySelector('[data-role=url]') as HTMLInputElement;
    const confirmInput = row.querySelector('[data-role=confirmation]') as HTMLInputElement;
    for (const opt of ACTION_OPTIONS) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = _label(opt.labelKey, opt.value || 'Auto');
      if (state[gesture].action === opt.value) option.selected = true;
      actionSelect.appendChild(option);
    }
    for (const hours of HOUR_OPTIONS) {
      const option = document.createElement('option');
      option.value = String(hours);
      option.textContent = hours === 168
        ? _label('dashboard.interactions.range_7d', '7 days')
        : _label(`dashboard.interactions.range_${hours}h`, `${hours}h`);
      if (state[gesture].hours === hours) option.selected = true;
      hoursSelect.appendChild(option);
    }
    for (const opt of performOptions) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = _label(opt.labelKey, opt.value);
      if (state[gesture].perform === opt.value) option.selected = true;
      performSelect.appendChild(option);
    }
    const pagePlaceholder = document.createElement('option');
    pagePlaceholder.value = '';
    pagePlaceholder.textContent = _label('dashboard.interactions.navigate_page_placeholder', 'Choose a page…');
    pageSelect.appendChild(pagePlaceholder);
    for (const page of dashboardPages) {
      const option = document.createElement('option');
      option.value = page.id;
      option.textContent = page.title || page.id;
      if (state[gesture].page_id === page.id) option.selected = true;
      pageSelect.appendChild(option);
    }
    urlInput.value = state[gesture].url;
    confirmInput.checked = state[gesture].confirmation;
    actionSelect.addEventListener('change', () => {
      state[gesture].action = (actionSelect.value || '') as ActionKey;
      paintExtras(row, gesture);
    });
    hoursSelect.addEventListener('change', () => {
      state[gesture].hours = Number(hoursSelect.value) || 24;
    });
    performSelect.addEventListener('change', () => {
      state[gesture].perform = performSelect.value || 'domain_default';
    });
    pageSelect.addEventListener('change', () => {
      state[gesture].page_id = pageSelect.value || '';
    });
    urlInput.addEventListener('input', () => {
      state[gesture].url = urlInput.value.trim();
    });
    confirmInput.addEventListener('change', () => {
      state[gesture].confirmation = confirmInput.checked;
    });
    paintExtras(row, gesture);
    rowRefs.push({ gesture, row });
    grid.appendChild(row);
  }

  const resetBtn = hostEl.querySelector('[data-role=reset-all]') as HTMLButtonElement | null;
  resetBtn?.addEventListener('click', () => {
    for (const { gesture, row } of rowRefs) {
      state[gesture] = _emptyRow();
      const actionSelect = row.querySelector('[data-role=action]') as HTMLSelectElement;
      const hoursSelect = row.querySelector('[data-role=hours]') as HTMLSelectElement;
      const performSelect = row.querySelector('[data-role=perform]') as HTMLSelectElement;
      const pageSelect = row.querySelector('[data-role=page]') as HTMLSelectElement;
      const urlInput = row.querySelector('[data-role=url]') as HTMLInputElement;
      const confirmInput = row.querySelector('[data-role=confirmation]') as HTMLInputElement;
      actionSelect.value = '';
      hoursSelect.value = '24';
      performSelect.value = 'domain_default';
      pageSelect.value = '';
      urlInput.value = '';
      confirmInput.checked = false;
      paintExtras(row, gesture);
    }
  });

  return {
    read() {
      const interactions: Record<string, Record<string, unknown>> = {};
      for (const gesture of GESTURES) {
        const row = state[gesture];
        if (!row.action) continue;
        const spec: Record<string, unknown> = { action: row.action };
        if (row.action === 'history') spec.hours = row.hours;
        if (row.action === 'toggle' && row.confirmation) spec.confirmation = true;
        if (row.action === 'perform_action' && row.perform && row.perform !== 'domain_default') {
          spec.perform = row.perform;
        }
        if (row.action === 'navigate' && row.page_id) spec.page_id = row.page_id;
        if (row.action === 'url' && row.url) spec.url = row.url;
        interactions[gesture] = spec;
      }
      return Object.keys(interactions).length ? interactions : undefined;
    },
  };
}
