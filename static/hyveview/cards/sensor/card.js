/**
 * <hv-card-sensor> — sensor card with live value, unit, trend, and
 * optional sparkline. Migrated from `_renderSensorCard`.
 *
 * Key architectural point: setState() updates ONLY the value/unit/trend
 * nodes in place. The grid is not re-rendered when the entity changes,
 * so animations don't restart and the sparkline DOM survives.
 */
import { HyveviewCardBase } from '../../core/card-base.js';
import { host, widgetTitle } from '../../host.js';
import { t } from '../../../js/lang/index.js';

function _parseNumeric(rawState) {
  const m = String(rawState || '').match(/^(-?\d+(?:[.,]\d+)?)/);
  if (!m) return { numeric: null, valueDisplay: String(rawState || ''), tail: '' };
  const numeric = parseFloat(m[1].replace(',', '.'));
  const tail = String(rawState).slice(m[0].length).trim();
  return { numeric: Number.isFinite(numeric) ? numeric : null, valueDisplay: m[1], tail };
}

export class HyveviewSensorCard extends HyveviewCardBase {
  static meta = {
    name: 'Sensor',
    description: 'Live numeric/text value with trend arrow and optional sparkline.',
    icon: '📊',
  };
  static schema = {
    fields: [
      { key: 'entity_id', label: 'Sensor entity', type: 'entity', domains: ['sensor', 'binary_sensor'], required: true },
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Auto from entity if blank' },
      { key: 'icon', label: 'Icon', type: 'icon', placeholder: 'fas fa-temperature-half' },
    ],
  };
  static getStubConfig(entityId) {
    return { entity_id: entityId || '', title: '', icon: '' };
  }

  constructor() {
    super();
    // Hot-path node refs filled by _render(), reused by _onState().
    this._labelEl = null;
    this._valueEl = null;
    this._unitEl = null;
    this._trendEl = null;
    this._sparkSlot = null;
    this._iconEl = null;
  }

  setConfig(widget) {
    this._config = widget || {};
    this._render();
    // Initialize value/unit/trend from the widget's hydrated state.
    this._applyValue(widget?.current_state, widget?.unit, widget?.entity_id);
    this._maybeEnhanceSparkline();
  }

  setState(entity) {
    if (!entity) return;
    const w = this._config || {};
    if (entity.entity_id && entity.entity_id !== w.entity_id) return;
    // Keep the widget cache in sync so subsequent setConfig (after a
    // re-render triggered by layout changes) starts from the latest.
    w.current_state = entity.state;
    if (entity.unit) w.unit = entity.unit;
    w.attributes = { ...(w.attributes || {}), ...(entity.attributes || {}) };
    w.available = entity.available !== false;
    this._applyValue(entity.state, entity.unit || w.unit || '', w.entity_id);
    this.dataset.unavailable = w.available === false ? 'true' : 'false';
  }

  _render() {
    const w = this._config || {};
    const escape = host.escape;
    const iconSpec = (typeof host.widgetIcon === 'function' ? host.widgetIcon(w) : w.icon)
      || host.entityIcon(w.domain);
    const iconClass = host.iconClass(iconSpec);
    const label = widgetTitle(w);
    this.dataset.unavailable = w.available === false ? 'true' : 'false';
    // Inner DOM uses display:contents on the host so legacy article CSS
    // remains the layout authority.
    this.innerHTML = `
      <div class="hyve-dashboard-card__sensor-row">
        <span class="hyve-dashboard-card__icon"><i class="${escape(iconClass)}" data-icon></i></span>
        <div class="hyve-dashboard-card__sensor-body">
          <div class="hyve-dashboard-card__sensor-label" data-label>${escape(label)}</div>
          <div class="hyve-dashboard-card__sensor-value">
            <span data-value></span><span class="hyve-dashboard-card__sensor-unit" data-unit hidden></span>
          </div>
          <span class="hyve-dashboard-card__sensor-trend" data-trend hidden></span>
        </div>
      </div>
      <div class="hyve-dashboard-card__sparkline" data-sparkline-entity="${escape(w.entity_id || '')}" data-spark hidden></div>
    `;
    this._labelEl = this.querySelector('[data-label]');
    this._valueEl = this.querySelector('[data-value]');
    this._unitEl = this.querySelector('[data-unit]');
    this._trendEl = this.querySelector('[data-trend]');
    this._sparkSlot = this.querySelector('[data-spark]');
    this._iconEl = this.querySelector('[data-icon]');
  }

  _applyValue(rawState, presetUnit, entityId) {
    if (!this._valueEl) return;
    const { numeric, valueDisplay, tail } = _parseNumeric(rawState);
    const unit = presetUnit || tail || '';
    this._valueEl.textContent = valueDisplay;
    if (this._unitEl) {
      if (unit) { this._unitEl.textContent = unit; this._unitEl.hidden = false; }
      else { this._unitEl.hidden = true; this._unitEl.textContent = ''; }
    }
    // Trend (per-entity, shared with legacy renderer via host.trendCache).
    let trendDir = 'flat';
    if (numeric != null && entityId) {
      const cache = host.trendCache;
      const prev = cache?.get(entityId);
      if (prev && Number.isFinite(prev.value)) {
        if (numeric > prev.value) trendDir = 'up';
        else if (numeric < prev.value) trendDir = 'down';
      }
      if (cache && (!prev || prev.value !== numeric)) {
        cache.set(entityId, { value: numeric, ts: Date.now() });
      }
    }
    if (this._trendEl) {
      if (trendDir === 'flat') {
        this._trendEl.hidden = true;
        this._trendEl.removeAttribute('data-dir');
      } else {
        const trendIcon = trendDir === 'up' ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down';
        const trendLabel = trendDir === 'up' ? t('entity.trend_up') : t('entity.trend_down');
        this._trendEl.dataset.dir = trendDir;
        this._trendEl.innerHTML = `<i class="fas ${trendIcon}"></i>${trendLabel}`;
        this._trendEl.hidden = false;
      }
    }
    if (this._sparkSlot) {
      this._sparkSlot.hidden = !(numeric != null);
    }
  }

  _maybeEnhanceSparkline() {
    if (!this._sparkSlot || this._sparkSlot.hidden) return;
    try { host.enhanceSparklinesIn(this); } catch (_) {}
  }
}
