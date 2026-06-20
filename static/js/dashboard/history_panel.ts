/**
 * Shared history chart panel (modal + more-info tab).
 */

import { apiCall } from '../api.js';
import { t, translateApiDetail } from '../lang/index.js';
import {
  computeHistoryStats,
  renderHistoryChartSVG,
  type HistoryPoint,
} from './history_chart.js';
import type { DashboardWidgetLike } from './interactions/types.js';

const RANGE_OPTIONS = [
  { hours: 1, key: 'dashboard.interactions.range_1h', fallback: '1 hour' },
  { hours: 6, key: 'dashboard.interactions.range_6h', fallback: '6 hours' },
  { hours: 24, key: 'dashboard.interactions.range_24h', fallback: '24 hours' },
  { hours: 168, key: 'dashboard.interactions.range_7d', fallback: '7 days' },
];

export interface HistoryPanelElements {
  ranges: HTMLElement | null;
  status: HTMLElement | null;
  chart: HTMLElement | null;
  stats: HTMLElement | null;
  stateEl?: HTMLElement | null;
}

function _label(key: string, fallback: string): string {
  const out = t(key);
  return out !== key ? out : fallback;
}

function entityDomain(widget: DashboardWidgetLike): string {
  const domain = String(widget.domain || '').trim().toLowerCase();
  if (domain) return domain;
  const eid = String(widget.entity_id || '');
  const dot = eid.indexOf('.');
  return dot > 0 ? eid.slice(0, dot).toLowerCase() : '';
}

function formatValue(value: number | null, unit = ''): string {
  if (value == null || Number.isNaN(value)) return '—';
  const rounded = Math.abs(value) >= 100 ? value.toFixed(1) : value.toFixed(2);
  return unit ? `${rounded} ${unit}`.trim() : rounded;
}

export function renderHistoryStatsHtml(
  stats: ReturnType<typeof computeHistoryStats>,
  unit: string,
): string {
  const deltaSign = (stats.delta ?? 0) > 0 ? '+' : '';
  return `
    <div class="dashboard-history-stat"><span>${_label('dashboard.interactions.stat_current', 'Current')}</span><strong>${formatValue(stats.current, unit)}</strong></div>
    <div class="dashboard-history-stat"><span>${_label('dashboard.interactions.stat_min', 'Min')}</span><strong>${formatValue(stats.min, unit)}</strong></div>
    <div class="dashboard-history-stat"><span>${_label('dashboard.interactions.stat_max', 'Max')}</span><strong>${formatValue(stats.max, unit)}</strong></div>
    <div class="dashboard-history-stat"><span>${_label('dashboard.interactions.stat_avg', 'Avg')}</span><strong>${formatValue(stats.avg, unit)}</strong></div>
    <div class="dashboard-history-stat"><span>${_label('dashboard.interactions.stat_delta', 'Change')}</span><strong>${stats.delta == null ? '—' : `${deltaSign}${formatValue(stats.delta, unit)}`}</strong></div>`;
}

export function renderHistoryRangesHtml(activeHours: number): string {
  return RANGE_OPTIONS.map((opt) => `
    <button type="button" class="dashboard-history-range${opt.hours === activeHours ? ' is-active' : ''}" data-hours="${opt.hours}">
      ${_label(opt.key, opt.fallback)}
    </button>`).join('');
}

export function bindHistoryRangeButtons(
  rangesHost: HTMLElement,
  activeHours: number,
  onChange: (hours: number) => void,
): void {
  rangesHost.innerHTML = renderHistoryRangesHtml(activeHours);
  rangesHost.querySelectorAll('[data-hours]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = Number((btn as HTMLElement).dataset.hours) || 24;
      if (next !== activeHours) onChange(next);
    });
  });
}

function setPanelStatus(
  statusEl: HTMLElement | null,
  message: string,
  tone: 'muted' | 'error' | 'busy' = 'muted',
): void {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

export async function loadHistoryPanel(
  widget: DashboardWidgetLike,
  hours: number,
  elements: HistoryPanelElements,
): Promise<void> {
  const entityId = String(widget.entity_id || '').trim();
  if (!entityId) return;

  const { chart, stats, stateEl, ranges, status } = elements;
  setPanelStatus(status, _label('dashboard.interactions.history_loading', 'Loading history…'), 'busy');
  if (chart) chart.innerHTML = '<div class="dashboard-history-skeleton"></div>';
  if (stats) stats.innerHTML = '';

  const unit = String((widget.attributes as Record<string, unknown> | undefined)?.unit_of_measurement
    || widget.unit
    || '').trim();
  if (stateEl) {
    const stateText = String(widget.current_state ?? '—');
    stateEl.textContent = unit && !stateText.endsWith(unit) ? `${stateText} ${unit}` : stateText;
  }

  try {
    const res = await apiCall(
      `/api/dashboard/history?entity_id=${encodeURIComponent(entityId)}&hours=${encodeURIComponent(String(hours))}`,
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { detail?: unknown };
      const translated = translateApiDetail(err.detail);
      const message = translated || _label('dashboard.interactions.history_error', 'Could not load history');
      setPanelStatus(status, message, 'error');
      if (chart) chart.innerHTML = `<div class="dashboard-history-empty">${message}</div>`;
      return;
    }
    const data = await res.json() as { points?: HistoryPoint[] };
    const points = Array.isArray(data.points) ? data.points : [];
    if (!points.length) {
      const empty = _label('dashboard.interactions.history_empty', 'No history recorded for this period.');
      setPanelStatus(status, empty, 'muted');
      if (chart) chart.innerHTML = `<div class="dashboard-history-empty">${empty}</div>`;
      if (stats) stats.innerHTML = '';
      return;
    }
    const domain = entityDomain(widget);
    const svg = renderHistoryChartSVG(points, {
      width: 720,
      height: 240,
      mode: 'auto',
      gradientId: `hyve-history-fill-${entityId.replace(/[^a-z0-9]+/gi, '-')}`,
      showAxes: true,
    }, domain);
    if (chart) {
      chart.innerHTML = svg || `<div class="dashboard-history-empty">${_label('dashboard.interactions.history_empty', 'No history recorded for this period.')}</div>`;
    }
    if (stats) stats.innerHTML = renderHistoryStatsHtml(computeHistoryStats(points), unit);
    setPanelStatus(status, '', 'muted');
  } catch {
    const message = _label('dashboard.interactions.history_error', 'Could not load history');
    setPanelStatus(status, message, 'error');
    if (chart) chart.innerHTML = `<div class="dashboard-history-empty">${message}</div>`;
  }
}

export function mountHistoryPanelShell(container: HTMLElement): HistoryPanelElements {
  container.innerHTML = `
    <div class="dashboard-history-toolbar dashboard-history-toolbar--embedded flex flex-wrap items-center gap-3 mb-3">
      <div data-role="ranges" class="dashboard-history-ranges"></div>
      <div data-role="state" class="dashboard-history-current ml-auto text-sm font-semibold text-slate-200"></div>
    </div>
    <div data-role="status" class="dashboard-history-status text-xs text-slate-400"></div>
    <div data-role="chart" class="dashboard-history-chart"></div>
    <div data-role="stats" class="dashboard-history-stats"></div>
  `;
  return {
    ranges: container.querySelector('[data-role=ranges]') as HTMLElement | null,
    status: container.querySelector('[data-role=status]') as HTMLElement | null,
    chart: container.querySelector('[data-role=chart]') as HTMLElement | null,
    stats: container.querySelector('[data-role=stats]') as HTMLElement | null,
    stateEl: container.querySelector('[data-role=state]') as HTMLElement | null,
  };
}

export async function mountAndLoadHistoryPanel(
  container: HTMLElement,
  widget: DashboardWidgetLike,
  hours: number,
): Promise<{ reload: (nextHours: number) => Promise<void> }> {
  const elements = mountHistoryPanelShell(container);
  let currentHours = hours;

  const reload = async (nextHours: number) => {
    currentHours = nextHours;
    if (elements.ranges) {
      bindHistoryRangeButtons(elements.ranges, currentHours, (h) => { void reload(h); });
    }
    await loadHistoryPanel(widget, currentHours, elements);
  };

  await reload(currentHours);
  return { reload };
}
