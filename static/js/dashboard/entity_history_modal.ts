/**
 * Entity history modal — full chart with range selector and stats.
 */

import { t } from '../lang/index.js';
import { showToast } from '../utils.js';
import {
  bindHistoryRangeButtons,
  loadHistoryPanel,
  type HistoryPanelElements,
} from './history_panel.js';
import type { DashboardWidgetLike, InteractionSpec } from './interactions/types.js';

interface ModalState {
  widget: DashboardWidgetLike;
  hours: number;
}

let _state: ModalState | null = null;

function _label(key: string, fallback: string): string {
  const out = t(key);
  return out !== key ? out : fallback;
}

function modalElements(): HistoryPanelElements & {
  modal: HTMLElement | null;
  iconEl: HTMLElement | null;
  labelEl: HTMLElement | null;
} {
  return {
    modal: document.getElementById('dashboard-entity-history-modal'),
    iconEl: document.getElementById('dashboard-entity-history-icon'),
    labelEl: document.getElementById('dashboard-entity-history-label'),
    ranges: document.getElementById('dashboard-entity-history-ranges'),
    status: document.getElementById('dashboard-entity-history-status'),
    chart: document.getElementById('dashboard-entity-history-chart'),
    stats: document.getElementById('dashboard-entity-history-stats'),
    stateEl: document.getElementById('dashboard-entity-history-state'),
  };
}

async function loadHistory(): Promise<void> {
  if (!_state) return;
  const els = modalElements();
  const { widget, hours } = _state;

  if (els.ranges) {
    bindHistoryRangeButtons(els.ranges, hours, (next) => {
      if (!_state || _state.hours === next) return;
      _state.hours = next;
      void loadHistory();
    });
  }

  await loadHistoryPanel(widget, hours, els);
}

export function closeDashboardEntityHistory(): void {
  const { modal } = modalElements();
  _state = null;
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

export function openDashboardEntityHistory(
  widget: DashboardWidgetLike,
  spec: InteractionSpec = { action: 'history', hours: 24 },
): void {
  const { modal, iconEl, labelEl, ranges } = modalElements();
  if (!modal) {
    showToast(_label('dashboard.interactions.history_error', 'Could not load history'), 'error');
    return;
  }

  const entityId = String(widget.entity_id || '').trim();
  const title = String(widget.entity_name || widget.title || entityId || _label('dashboard.interactions.history_title', 'History'));
  _state = {
    widget,
    hours: Number(spec.hours) || 24,
  };

  if (iconEl) iconEl.className = 'fas fa-chart-line text-accent';
  if (labelEl) labelEl.textContent = title;
  if (ranges) ranges.innerHTML = '';

  if (modal.parentNode !== document.body) document.body.appendChild(modal);
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  void loadHistory();
}

export function initDashboardEntityHistoryModal(): void {
  const { modal } = modalElements();
  if (!modal || modal.dataset.bound === 'true') return;
  modal.dataset.bound = 'true';
  modal.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-dashboard-history-stop]')) return;
    if (target.closest('[data-dashboard-history-close]') || target === modal) {
      closeDashboardEntityHistory();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (modal.classList.contains('hidden')) return;
    closeDashboardEntityHistory();
  });
}
