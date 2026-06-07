/**
 * <hv-card-weather-simple> — minimal weather card (icon + temp + condition).
 */
import { HyveviewCardBase } from '../core/card-base.js';
import { host, widgetTitle } from '../host.js';

export class HyveviewWeatherSimpleCard extends HyveviewCardBase {
  static meta = {
    name: 'Weather (compact)',
    description: 'Icon + temperature + condition, single-row layout.',
    icon: '⛅',
  };
  static schema = {
    fields: [
      { key: 'entity_id', label: 'Weather entity', type: 'entity', domains: ['weather'], required: true },
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Auto from entity if blank' },
    ],
  };
  static getStubConfig(entityId) {
    return { entity_id: entityId || '', title: '' };
  }

  constructor() {
    super();
    this._iconEl = null;
    this._stateEl = null;
  }

  setConfig(widget) {
    this._config = widget || {};
    this._render();
    this._applyState();
  }

  setState(entity) {
    if (!entity) return;
    const w = this._config || {};
    if (entity.entity_id && entity.entity_id !== w.entity_id) return;
    w.current_state = entity.state;
    w.attributes = { ...(w.attributes || {}), ...(entity.attributes || {}) };
    w.available = entity.available !== false;
    this._applyState();
  }

  _render() {
    const w = this._config || {};
    const escape = host.escape;
    const title = widgetTitle(w);
    this.innerHTML = `
      <div class="hyve-dashboard-card__row">
        <span class="hyve-dashboard-card__icon"><i data-icon class="fas fa-cloud"></i></span>
        <div class="hyve-dashboard-card__body">
          <div class="hyve-dashboard-card__title" data-title>${escape(title)}</div>
          <div class="hyve-dashboard-card__state" data-state></div>
        </div>
      </div>
    `;
    this._iconEl = this.querySelector('[data-icon]');
    this._stateEl = this.querySelector('[data-state]');
  }

  _applyState() {
    if (!this._stateEl) return;
    const w = this._config || {};
    const attrs = w.attributes || {};
    const cond = String(w.current_state || '');
    const temp = attrs.temperature != null ? `${attrs.temperature}°` : '—';
    const isNight = typeof host.weatherIsNight === 'function' ? host.weatherIsNight(attrs) : false;
    if (this._iconEl) {
      const icon = typeof host.weatherIcon === 'function' ? host.weatherIcon(cond, isNight) : 'fas fa-cloud';
      this._iconEl.className = icon;
    }
    this._stateEl.textContent = `${cond} · ${temp}`;

    const available = w.available !== false;
    const article = this.parentElement && this.parentElement.tagName === 'ARTICLE'
      ? this.parentElement : this.closest('article');
    if (article) {
      article.setAttribute('data-unavailable', available ? 'false' : 'true');
    }
  }
}
