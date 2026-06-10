/**
 * <hv-card-gauge> — semicircular SVG gauge.
 */
import { HyveviewCardBase } from '../../core/card-base.js';
import { host, widgetTitle } from '../../host.js';
const ARC_LEN = 100.53;
export class HyveviewGaugeCard extends HyveviewCardBase {
    static getStubConfig(entityId) {
        return { entity_id: entityId || '', title: '', icon: 'fas fa-gauge-high' };
    }
    constructor() {
        super();
        this._fillEl = null;
        this._valueEl = null;
        this._unitEl = null;
    }
    setConfig(widget) {
        this._config = widget || {};
        this._render();
        this._applyState();
    }
    setState(entity) {
        if (!entity)
            return;
        const w = (this._config || {});
        if (entity.entity_id && entity.entity_id !== w.entity_id)
            return;
        w.current_state = entity.state;
        if (entity.unit)
            w.unit = entity.unit;
        w.attributes = { ...(w.attributes || {}), ...(entity.attributes || {}) };
        w.available = entity.available !== false;
        this._applyState();
    }
    _render() {
        const w = (this._config || {});
        const escape = host.escape;
        const title = widgetTitle(w);
        const iconSpec = (typeof host.widgetIcon === 'function' ? host.widgetIcon(w) : w.icon)
            || 'fas fa-gauge-high';
        this.innerHTML = `
      <div class="hyve-dashboard-card__row" style="margin-bottom:0.25rem;">
        <span class="hyve-dashboard-card__icon"><i class="${escape(host.iconClass(iconSpec))}"></i></span>
        <div class="hyve-dashboard-card__body">
          <div class="hyve-dashboard-card__title" data-title>${escape(title)}</div>
        </div>
      </div>
      <div class="hyve-dashboard-card__gauge-wrap">
        <svg class="hyve-dashboard-card__gauge-svg" viewBox="0 0 80 50">
          <path class="hyve-dashboard-card__gauge-track" d="M 8 42 A 32 32 0 0 1 72 42" />
          <path class="hyve-dashboard-card__gauge-fill" d="M 8 42 A 32 32 0 0 1 72 42"
            stroke-dasharray="${ARC_LEN}" stroke-dashoffset="${ARC_LEN}" data-fill />
        </svg>
        <div class="hyve-dashboard-card__gauge-info">
          <div class="hyve-dashboard-card__gauge-value" data-value>0</div>
          <div class="hyve-dashboard-card__gauge-unit" data-unit></div>
        </div>
      </div>
    `;
        this._fillEl = this.querySelector('[data-fill]');
        this._valueEl = this.querySelector('[data-value]');
        this._unitEl = this.querySelector('[data-unit]');
    }
    _applyState() {
        const w = (this._config || {});
        const attrs = (w.attributes && typeof w.attributes === 'object' ? w.attributes : {});
        const caps = (attrs.capabilities && typeof attrs.capabilities === 'object' ? attrs.capabilities : {});
        const min = Number(caps.min ?? 0);
        const max = Number(caps.max ?? 100);
        const rawState = String(w.current_state == null ? '0' : w.current_state);
        const numericMatch = rawState.match(/^(-?\d+(?:[.,]\d+)?)/);
        const value = numericMatch ? parseFloat(numericMatch[1].replace(',', '.')) : 0;
        const range = Math.max(1, max - min);
        const ratio = Math.max(0, Math.min(1, (value - min) / range));
        const dashOffset = ARC_LEN * (1 - ratio);
        const unit = String(w.unit || caps.unit || '');
        if (this._fillEl)
            this._fillEl.setAttribute('stroke-dashoffset', dashOffset.toFixed(2));
        if (this._valueEl)
            this._valueEl.textContent = numericMatch ? numericMatch[1] : rawState;
        if (this._unitEl)
            this._unitEl.textContent = unit || `${min} – ${max}`;
    }
}
HyveviewGaugeCard.meta = {
    name: 'Gauge',
    description: 'Semicircular gauge for numeric sensors with min/max.',
    icon: '🎯',
};
HyveviewGaugeCard.schema = {
    fields: [
        { key: 'entity_id', label: 'Numeric entity', type: 'entity', domains: ['sensor'], required: true },
        { key: 'title', label: 'Title', type: 'string', placeholder: 'Auto from entity if blank' },
        { key: 'icon', label: 'Icon', type: 'icon', placeholder: 'fas fa-gauge-high', default: 'fas fa-gauge-high' },
    ],
};
