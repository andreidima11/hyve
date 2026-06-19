/**
 * <hv-card-number> — controllable number entity with range slider.
 */
import { HyveviewCardBase } from '../../core/card-base.js';
import { host, widgetTitle } from '../../host.js';
import type { CardWidget, HyveviewEntityState } from '../../types/card-widget.js';

function numberCaps(widget: CardWidget) {
  const attrs = (widget.attributes && typeof widget.attributes === 'object'
    ? widget.attributes : {}) as Record<string, unknown>;
  const caps = (attrs.capabilities && typeof attrs.capabilities === 'object'
    ? attrs.capabilities : {}) as Record<string, unknown>;
  return {
    min: Number(caps.min ?? 0),
    max: Number(caps.max ?? 100),
    step: Number(caps.step ?? 1) || 1,
    unit: String(widget.unit || caps.unit || ''),
  };
}

function parseNumberState(raw: unknown, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export class HyveviewNumberCard extends HyveviewCardBase {
  protected _liveValueEl: HTMLElement | null = null;
  protected _sliderActive = false;
  protected _sliderEl: HTMLInputElement | null = null;
  protected _titleEl: HTMLElement | null = null;

  static meta = {
    name: 'Number',
    description: 'Numeric entity with min/max slider control.',
    icon: '🔢',
  };
  static schema = {
    fields: [
      { key: 'entity_id', label: 'Number entity', type: 'entity', domains: ['number'], required: true },
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Auto from entity if blank' },
      { key: 'icon', label: 'Icon', type: 'icon', placeholder: 'fas fa-sliders' },
    ],
  };
  static getStubConfig(entityId?: string) {
    return { entity_id: entityId || '', title: '', icon: 'fas fa-sliders' };
  }

  setConfig(widget: CardWidget | null | undefined) {
    this._config = widget || {};
    this._render();
    this._applyState();
  }

  setState(entity: HyveviewEntityState | null) {
    if (!entity) return;
    const w = (this._config || {}) as CardWidget;
    if (entity.entity_id && entity.entity_id !== w.entity_id) return;
    w.current_state = entity.state;
    if (entity.unit) w.unit = entity.unit;
    w.attributes = { ...(w.attributes || {}), ...(entity.attributes || {}) };
    w.available = entity.available !== false;
    this._applyState();
  }

  _render() {
    const w = (this._config || {}) as CardWidget;
    const escape = host.escape;
    const editMode = !!w._edit_mode;
    const { min, max, step, unit } = numberCaps(w);
    const current = parseNumberState(w.current_state, min);
    const title = widgetTitle(w);
    const wid = escape(w.id || '');
    const showSlider = !editMode && w.available !== false;

    this.innerHTML = `
      <div class="hyve-dashboard-card__row">
        <span class="hyve-dashboard-card__icon"><i data-icon class="fas fa-sliders"></i></span>
        <div class="hyve-dashboard-card__body">
          <div class="hyve-dashboard-card__title" data-title>${escape(title)}</div>
          <div class="hyve-dashboard-card__state hyve-dashboard-card__number-value" data-live-value>
            ${escape(String(current))}${unit ? ` ${escape(unit)}` : ''}
          </div>
        </div>
      </div>
      ${showSlider ? `
        <div class="hyve-dashboard-card__number" data-number>
          <input type="range" min="${min}" max="${max}" step="${step}" value="${current}"
            class="hyve-dashboard-card__number-slider"
            data-number-slider
            data-dash-input="numberInput"
            data-dash-change="numberChange"
            data-dash-stop-propagation="true"
            data-widget-id="${wid}"
            aria-label="${escape(title)}">
          <div class="hyve-dashboard-card__number-bounds">
            <span>${escape(String(min))}${unit ? ` ${escape(unit)}` : ''}</span>
            <span>${escape(String(max))}${unit ? ` ${escape(unit)}` : ''}</span>
          </div>
        </div>` : ''}
    `;
    this._titleEl = this.querySelector('[data-title]');
    this._liveValueEl = this.querySelector('[data-live-value]');
    this._sliderEl = this.querySelector('[data-number-slider]');
    const iconSpec = (typeof host.widgetIcon === 'function' ? host.widgetIcon(w) : w.icon) || 'fas fa-sliders';
    const iconEl = this.querySelector('[data-icon]');
    if (iconEl) iconEl.className = host.iconClass ? host.iconClass(iconSpec) : String(iconSpec);

    if (this._sliderEl) {
      this._sliderEl.addEventListener('pointerdown', () => { this._sliderActive = true; });
      this._sliderEl.addEventListener('pointerup', () => { this._sliderActive = false; });
      this._sliderEl.addEventListener('pointercancel', () => { this._sliderActive = false; });
      this._sliderEl.addEventListener('blur', () => { this._sliderActive = false; });
    }
  }

  _applyState() {
    const w = (this._config || {}) as CardWidget;
    const { min, max, unit } = numberCaps(w);
    const current = parseNumberState(w.current_state, min);
    const clamped = Math.min(max, Math.max(min, current));

    if (this._liveValueEl) {
      this._liveValueEl.textContent = `${clamped}${unit ? ` ${unit}` : ''}`;
    }
    if (this._sliderEl && !this._sliderActive) {
      this._sliderEl.min = String(min);
      this._sliderEl.max = String(max);
      this._sliderEl.value = String(clamped);
    }

    const article = this.parentElement?.tagName === 'ARTICLE'
      ? this.parentElement : this.closest('article');
    if (article) {
      article.setAttribute('data-unavailable', w.available === false ? 'true' : 'false');
      article.setAttribute('data-on', 'true');
    }
  }
}
