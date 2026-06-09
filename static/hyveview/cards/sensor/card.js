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
import { t, tState } from '../../../js/lang/index.js';

function _parseNumeric(rawState) {
  const m = String(rawState || '').match(/^(-?\d+(?:[.,]\d+)?)/);
  if (!m) return { numeric: null, valueDisplay: String(rawState || ''), tail: '' };
  const numeric = parseFloat(m[1].replace(',', '.'));
  const tail = String(rawState).slice(m[0].length).trim();
  return { numeric: Number.isFinite(numeric) ? numeric : null, valueDisplay: m[1], tail };
}

function _entityDomain(entityId) {
  return String(entityId || '').split('.')[0].trim().toLowerCase();
}

/** Sparklines only for numeric `sensor.*` entities — not binary_sensor / text states. */
function _supportsSparkline(widget) {
  return _entityDomain(widget?.entity_id) === 'sensor';
}

function _dashboardRows(widget, article) {
  const fromArticle = parseInt(article?.dataset?.dashboardRows || '', 10);
  if (Number.isFinite(fromArticle) && fromArticle > 0) return fromArticle;
  const fromWidget = parseInt(widget?.row_span, 10);
  return Number.isFinite(fromWidget) && fromWidget > 0 ? fromWidget : 1;
}

/** 1-row text/binary sensors use the same DOM footprint as tile (no trend/sparkline). */
function _isCompactLayout(widget, numeric, article) {
  if (_entityDomain(widget?.entity_id) === 'binary_sensor') return true;
  if (_dashboardRows(widget, article) <= 1) return true;
  if (numeric == null) return true;
  return false;
}

function _displayLabel(widget) {
  const w = widget || {};
  const eid = String(w.entity_id || '');
  const friendly = String(w.attributes?.friendly_name || w.entity_name || '').trim();
  const label = widgetTitle(w);
  if ((!label || label === eid) && friendly) return friendly;
  return label || friendly || eid;
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
    this._compact = true;
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

  _articleEl() {
    return this.parentElement?.tagName === 'ARTICLE'
      ? this.parentElement
      : this.closest('article');
  }

  _syncCompactClass(compact) {
    this._compact = !!compact;
    const article = this._articleEl();
    if (article) article.classList.toggle('hyve-dashboard-card--sensor-compact', this._compact);
  }

  _render() {
    const w = this._config || {};
    const escape = host.escape;
    const article = this._articleEl();
    const { numeric } = _parseNumeric(w.current_state);
    const compact = _isCompactLayout(w, numeric, article);
    this._syncCompactClass(compact);
    const iconSpec = (typeof host.widgetIcon === 'function' ? host.widgetIcon(w) : w.icon)
      || host.entityIcon(w.domain);
    const iconClass = host.iconClass(iconSpec);
    const label = _displayLabel(w);
    this.dataset.unavailable = w.available === false ? 'true' : 'false';
    // Inner DOM uses display:contents on the host so legacy article CSS
    // remains the layout authority.
    const sparkMarkup = (!compact && _supportsSparkline(w))
      ? `<div class="hyve-dashboard-card__sparkline" data-sparkline-entity="${escape(w.entity_id || '')}" data-spark hidden></div>`
      : '';
    const trendMarkup = compact
      ? ''
      : '<span class="hyve-dashboard-card__sensor-trend" data-trend hidden></span>';
    this.innerHTML = `
      <div class="hyve-dashboard-card__row">
        <span class="hyve-dashboard-card__icon"><i class="${escape(iconClass)}" data-icon></i></span>
        <div class="hyve-dashboard-card__body">
          <div class="hyve-dashboard-card__title" data-label>${escape(label)}</div>
          <div class="hyve-dashboard-card__state" data-value></div>
          ${trendMarkup}
        </div>
      </div>${sparkMarkup}`;
    this._labelEl = this.querySelector('[data-label]');
    this._valueEl = this.querySelector('[data-value]');
    this._unitEl = null;
    this._trendEl = this.querySelector('[data-trend]');
    this._sparkSlot = this.querySelector('[data-spark]');
    this._iconEl = this.querySelector('[data-icon]');
  }

  _applyValue(rawState, presetUnit, entityId) {
    const w = this._config || {};
    const { numeric, valueDisplay, tail } = _parseNumeric(rawState);
    const unit = presetUnit || tail || '';
    const compact = _isCompactLayout(w, numeric, this._articleEl());
    if (compact !== this._compact) {
      w.current_state = rawState;
      this._render();
    }
    if (!this._valueEl) return;
    if (numeric != null && !compact) {
      const unitSuffix = unit ? ` ${unit}` : '';
      this._valueEl.textContent = `${valueDisplay}${unitSuffix}`;
      this._valueEl.dataset.numeric = 'true';
    } else if (numeric != null && compact) {
      const unitSuffix = unit ? ` ${unit}` : '';
      this._valueEl.textContent = `${valueDisplay}${unitSuffix}`;
      this._valueEl.removeAttribute('data-numeric');
    } else {
      const stateStr = String(rawState == null ? 'unknown' : rawState);
      const unitSuffix = unit && !stateStr.endsWith(unit) ? ` ${unit}` : '';
      this._valueEl.textContent = tState(stateStr) + unitSuffix;
      this._valueEl.removeAttribute('data-numeric');
    }
    const article = this._articleEl();
    if (article && typeof host.stateOn === 'function') {
      const on = host.stateOn(String(rawState == null ? 'unknown' : rawState));
      article.setAttribute('data-on', on ? 'true' : 'false');
    }
    // Trend (per-entity, shared with legacy renderer via host.trendCache).
    let trendDir = 'flat';
    if (!compact && numeric != null && entityId) {
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
      const showSpark = !compact && numeric != null && _supportsSparkline(w);
      this._sparkSlot.hidden = !showSpark;
      if (!showSpark) this._sparkSlot.innerHTML = '';
    }
  }

  _maybeEnhanceSparkline() {
    if (!this._sparkSlot || this._sparkSlot.hidden) return;
    try { host.enhanceSparklinesIn(this); } catch (_) {}
  }
}
