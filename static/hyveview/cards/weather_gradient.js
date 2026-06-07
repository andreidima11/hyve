import { HyveviewCardBase } from '../core/card-base.js';
import { host, widgetTitle } from '../host.js';

export class HyveviewWeatherGradientCard extends HyveviewCardBase {
  static meta = {
    name: 'Weather (gradient)',
    description: 'Minimalist weather card with gradient background.',
    icon: '🌈',
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
      <div class="hv-gradient-weather-card" data-gradient-root>
        <div class="hv-gradient-weather-main">
          <div class="hv-gradient-weather-icon" data-icon></div>
          <div class="hv-gradient-weather-info">
            <div class="hv-gradient-weather-temp" data-temp>—</div>
            <div class="hv-gradient-weather-cond" data-cond>—</div>
            <div class="hv-gradient-weather-date" data-date>—</div>
            <div class="hv-gradient-weather-loc" data-loc>${escape(title)}</div>
          </div>
        </div>
      </div>
    `;
    this._iconEl = this.querySelector('[data-icon]');
    this._tempEl = this.querySelector('[data-temp]');
    this._condEl = this.querySelector('[data-cond]');
    this._dateEl = this.querySelector('[data-date]');
    this._locEl = this.querySelector('[data-loc]');
  }

  _applyState() {
    const w = this._config || {};
    const attrs = w.attributes || {};
    const cond = String(w.current_state || '');
    const tempRaw = attrs.temperature;
    const temp = tempRaw != null ? `${Math.round(tempRaw)}°` : '—';
    const iconCls = typeof host.weatherIcon === 'function' ? host.weatherIcon(cond, false) : 'fas fa-cloud';
    const date = attrs.datetime ? this._formatDate(attrs.datetime) : this._todayDate();
    if (this._iconEl) this._iconEl.innerHTML = `<i class="${iconCls}"></i>`;
    if (this._tempEl) this._tempEl.textContent = temp;
    if (this._condEl) this._condEl.textContent = cond.charAt(0).toUpperCase() + cond.slice(1);
    if (this._dateEl) this._dateEl.textContent = date;
  }

  _formatDate(dt) {
    const d = new Date(dt);
    if (isNaN(d)) return '';
    const day = d.getDate().toString().padStart(2, '0');
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
  }
  _todayDate() {
    const d = new Date();
    const day = d.getDate().toString().padStart(2, '0');
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
  }
}

customElements.define('hv-card-weather-gradient', HyveviewWeatherGradientCard);
