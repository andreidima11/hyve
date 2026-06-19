/**
 * <hv-card-light> — light entity with brightness control.
 */
import { HyveviewCardBase } from '../../core/card-base.js';
import { host, widgetTitle } from '../../host.js';
import { tState } from '../../../js/lang/index.js';
import type { CardWidget, HyveviewEntityState } from '../../types/card-widget.js';

function lightCaps(widget: CardWidget) {
  const attrs = (widget.attributes && typeof widget.attributes === 'object'
    ? widget.attributes : {}) as Record<string, unknown>;
  const caps = (attrs.capabilities && typeof attrs.capabilities === 'object'
    ? attrs.capabilities : {}) as Record<string, unknown>;
  const scale = Number(caps.brightness_scale) || 254;
  const supportsBrightness = !!(
    caps.brightness_command_topic || caps.brightness || caps.brightness_range || attrs.brightness != null
  );
  return { scale, supportsBrightness };
}

function brightnessPct(widget: CardWidget, on: boolean): number {
  const { scale } = lightCaps(widget);
  const attrs = (widget.attributes && typeof widget.attributes === 'object'
    ? widget.attributes : {}) as Record<string, unknown>;
  const raw = Number(attrs.brightness != null ? attrs.brightness : (on ? scale : 0));
  return Math.max(0, Math.min(100, Math.round((raw / scale) * 100)));
}

export class HyveviewLightCard extends HyveviewCardBase {
  protected _iconWrapEl: HTMLElement | null = null;
  protected _liveValueEl: HTMLElement | null = null;
  protected _sliderActive = false;
  protected _sliderEl: HTMLInputElement | null = null;
  protected _sliderWrapEl: HTMLElement | null = null;
  protected _supportsBrightness = false;

  static meta = {
    name: 'Light',
    description: 'Light with brightness slider.',
    icon: '💡',
  };
  static schema = {
    fields: [
      { key: 'entity_id', label: 'Light entity', type: 'entity', domains: ['light'], required: true },
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Auto from entity if blank' },
      { key: 'icon', label: 'Icon', type: 'icon', placeholder: 'fas fa-lightbulb' },
    ],
  };
  static getStubConfig(entityId?: string) {
    return { entity_id: entityId || '', title: '', icon: 'fas fa-lightbulb' };
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
    const { supportsBrightness } = lightCaps(w);
    this._supportsBrightness = supportsBrightness;
    const title = widgetTitle(w);
    const wid = escape(w.id || '');
    const showSlider = supportsBrightness && !editMode && w.available !== false;

    this.innerHTML = `
      <div class="hyve-dashboard-card__row hyve-light__head">
        <span class="hyve-dashboard-card__icon hyve-light__icon" data-icon-wrap>
          <i data-icon class="fas fa-lightbulb"></i>
        </span>
        <div class="hyve-dashboard-card__body">
          <div class="hyve-dashboard-card__title" data-title>${escape(title)}</div>
          <div class="hyve-light__value" data-live-value>—</div>
        </div>
      </div>
      ${showSlider ? `
        <div class="hyve-light__slider" data-brightness style="--brightness-pct: 0%">
          <input type="range" min="0" max="100" step="1" value="0"
            class="hyve-light__range"
            data-brightness-slider
            data-dash-input="brightnessInput"
            data-dash-change="brightnessChange"
            data-dash-stop-propagation="true"
            data-widget-id="${wid}"
            aria-label="${escape(title)}">
          <div class="hyve-light__bounds">
            <span>0%</span>
            <span>100%</span>
          </div>
        </div>` : ''}
    `;

    this._liveValueEl = this.querySelector('[data-live-value]');
    this._iconWrapEl = this.querySelector('[data-icon-wrap]');
    this._sliderWrapEl = this.querySelector('[data-brightness]');
    this._sliderEl = this.querySelector('[data-brightness-slider]');

    const stateStr = String(w.current_state == null ? 'unknown' : w.current_state);
    const on = typeof host.stateOn === 'function'
      ? host.stateOn(stateStr)
      : ['on', 'true', '1'].includes(stateStr.toLowerCase());
    const iconSpec = (typeof host.widgetIcon === 'function' ? host.widgetIcon(w) : w.icon)
      || (typeof host.entityIconForState === 'function'
        ? host.entityIconForState('light', on)
        : (on ? 'fas fa-lightbulb' : 'far fa-lightbulb'));
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
    const stateStr = String(w.current_state == null ? 'unknown' : w.current_state);
    const on = typeof host.stateOn === 'function'
      ? host.stateOn(stateStr)
      : ['on', 'true', '1'].includes(stateStr.toLowerCase());
    const pct = brightnessPct(w, on);
    const valueText = on
      ? (this._supportsBrightness ? `${pct}%` : tState('on'))
      : tState('off');

    if (this._liveValueEl) this._liveValueEl.textContent = valueText;

    if (this._sliderWrapEl) {
      this._sliderWrapEl.style.setProperty('--brightness-pct', `${pct}%`);
    }
    if (this._iconWrapEl) {
      this._iconWrapEl.style.setProperty('--light-pct', `${pct}`);
    }
    if (this._sliderEl && !this._sliderActive && document.activeElement !== this._sliderEl) {
      this._sliderEl.value = String(pct);
    }

    const iconEl = this.querySelector('[data-icon]');
    if (iconEl) {
      const iconSpec = (typeof host.widgetIcon === 'function' ? host.widgetIcon(w) : w.icon)
        || (typeof host.entityIconForState === 'function'
          ? host.entityIconForState('light', on)
          : (on ? 'fas fa-lightbulb' : 'far fa-lightbulb'));
      iconEl.className = host.iconClass ? host.iconClass(iconSpec) : String(iconSpec);
    }

    const available = w.available !== false;
    const article = this.parentElement?.tagName === 'ARTICLE'
      ? this.parentElement : this.closest('article');
    if (article) {
      article.setAttribute('data-on', on ? 'true' : 'false');
      article.setAttribute('data-unavailable', available ? 'false' : 'true');
      const pending = typeof host.controlVisuallyPending === 'function' && w.id
        ? host.controlVisuallyPending(w.id) : false;
      article.setAttribute('data-pending', pending ? 'true' : 'false');
      if (w.entity_id) article.setAttribute('data-entity-id', w.entity_id);
    }
  }
}
