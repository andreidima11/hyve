/**
 * <hv-card-light> — light entity with optional collapsible controls.
 */
import { HyveviewCardBase } from '../../core/card-base.js';
import { host, widgetTitle } from '../../host.js';
import { t, tState } from '../../../js/lang/index.js';
import {
  lightColorToHex,
  renderHyColorPickerMarkup,
  resolveLightControlFlags,
} from '../../../js/light_controls.js';
import type { CardWidget, HyveviewEntityState } from '../../types/card-widget.js';

interface LightCardOptions {
  collapseWhenOff: boolean;
  showBrightness: boolean;
  showColor: boolean;
  showColorTemp: boolean;
}

function readLightOptions(widget: CardWidget): LightCardOptions {
  return {
    collapseWhenOff: widget.collapse_when_off !== false,
    showBrightness: widget.show_brightness !== false,
    showColor: widget.show_color !== false,
    showColorTemp: widget.show_color_temp !== false,
  };
}

function cardLayoutTier(cols: number, rows: number): 'compact' | 'cozy' | 'spacious' {
  const area = cols * rows;
  if (area <= 2 && cols < 2) return 'compact';
  if (area >= 6 || cols >= 3 || rows >= 3) return 'spacious';
  return 'cozy';
}

export class HyveviewLightCard extends HyveviewCardBase {
  protected _iconWrapEl: HTMLElement | null = null;
  protected _liveValueEl: HTMLElement | null = null;
  protected _controlsEl: HTMLElement | null = null;
  protected _sliderActive = false;
  protected _sliderEl: HTMLInputElement | null = null;
  protected _sliderWrapEl: HTMLElement | null = null;
  protected _flags: ReturnType<typeof resolveLightControlFlags> | null = null;

  static meta = {
    name: 'Light',
    description: 'Light with optional brightness, color, and temperature controls.',
    icon: '💡',
  };
  static schema = {
    fields: [
      { key: 'entity_id', label: 'Light entity', type: 'entity', domains: ['light'], required: true },
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Auto from entity if blank' },
      { key: 'icon', label: 'Icon', type: 'icon', placeholder: 'fas fa-lightbulb' },
      {
        key: 'collapse_when_off',
        label: 'Collapse when off',
        type: 'boolean',
        default: true,
        inline: true,
        hint: 'Hide sliders and color controls while the light is off.',
      },
      {
        key: 'show_brightness',
        label: 'Brightness slider',
        type: 'boolean',
        default: true,
        inline: true,
      },
      {
        key: 'show_color',
        label: 'Color picker',
        type: 'boolean',
        default: true,
        inline: true,
        hint: 'Shown when the light supports RGB/HS color.',
      },
      {
        key: 'show_color_temp',
        label: 'Color temperature',
        type: 'boolean',
        default: true,
        inline: true,
        hint: 'Shown when the light supports warm/cool white.',
      },
    ],
  };
  static getStubConfig(entityId?: string) {
    return {
      entity_id: entityId || '',
      title: '',
      icon: 'fas fa-lightbulb',
      collapse_when_off: true,
      show_brightness: true,
      show_color: true,
      show_color_temp: true,
    };
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

  _parentArticle(): HTMLElement | null {
    if (this.parentElement?.tagName === 'ARTICLE') return this.parentElement;
    return this.closest('article');
  }

  _readCardSpan(): { cols: number; rows: number } {
    const article = this._parentArticle();
    return {
      cols: Math.max(1, Number(article?.getAttribute('data-dashboard-cols') || 1)),
      rows: Math.max(1, Number(article?.getAttribute('data-dashboard-rows') || 1)),
    };
  }

  _render() {
    const w = (this._config || {}) as CardWidget;
    const escape = host.escape;
    const escAttr = (value: unknown) => escape(String(value ?? ''));
    const editMode = !!w._edit_mode;
    const opts = readLightOptions(w);
    const { cols, rows } = this._readCardSpan();
    const layout = cardLayoutTier(cols, rows);
    const on = this._isOn(w);
    const flags = resolveLightControlFlags(
      { state: w.current_state, attributes: w.attributes },
      on,
    );
    this._flags = flags;

    const title = widgetTitle(w);
    const wid = escape(w.id || '');
    const colorHex = lightColorToHex((w.attributes || {}) as Record<string, unknown>);

    const showBrightness = opts.showBrightness && flags.hasBrightness && !editMode;
    const showColor = opts.showColor && flags.hasColor && !editMode;
    const showColorTemp = opts.showColorTemp && flags.hasColorTemp && !editMode;
    const hasControls = showBrightness || showColor || showColorTemp;

    const brightnessBlock = showBrightness ? `
      <div class="hyve-light__control hyve-light__control--brightness">
        <div class="hyve-light__control-head">
          <span>${escape(t('entity.render.brightness') || 'Brightness')}</span>
          <span class="hyve-light__brightness-label" data-brightness-label>0%</span>
        </div>
        <div class="hyve-light__slider" data-brightness style="--brightness-pct: 0%">
          <input type="range" min="0" max="100" step="1" value="0"
            class="hyve-light__range"
            data-brightness-slider
            data-dash-input="brightnessInput"
            data-dash-change="brightnessChange"
            data-dash-stop-propagation="true"
            data-widget-id="${wid}"
            aria-label="${escape(title)}">
        </div>
      </div>` : '';

    let colorBlock = '';
    if (showColor) {
      if (layout === 'compact') {
        colorBlock = `
      <div class="hyve-light__control hyve-light__control--color">
        <div class="hyve-light__control-head">
          <span>${escape(t('entity.render.color') || 'Color')}</span>
        </div>
        <input type="color" class="hyve-light__color-native" value="${escAttr(colorHex)}"
          data-dash-change="lightColorChange"
          data-dash-stop-propagation="true"
          data-widget-id="${wid}"
          aria-label="${escape(title)}">
      </div>`;
      } else {
        const dashAttrs = `data-dash-widget-id="${wid}" data-dash-light-input="color" data-dash-stop-propagation="true"`;
        colorBlock = `
      <div class="hyve-light__control hyve-light__control--color">
        ${renderHyColorPickerMarkup(
          colorHex,
          dashAttrs,
          escape,
          escAttr,
          {
            color: t('entity.render.color') || 'Color',
            hue: t('entity.render.hue') || 'Hue',
          },
          { compact: layout !== 'spacious' },
        )}
      </div>`;
      }
    }

    const colorTempBlock = showColorTemp ? `
      <div class="hyve-light__control hyve-light__control--temp">
        <div class="hyve-light__control-head">
          <span>${escape(t('entity.render.color_temp') || 'Color temp')}</span>
          <span class="hyve-light__temp-label" data-color-temp-label>${flags.colorTempValue}</span>
        </div>
        <input type="range" min="${flags.colorTempMin}" max="${flags.colorTempMax}" step="1"
          value="${flags.colorTempValue}"
          class="hyve-light__range hyve-light__range--temp"
          data-dash-input="lightColorTempInput"
          data-dash-change="lightColorTempChange"
          data-dash-stop-propagation="true"
          data-widget-id="${wid}"
          aria-label="${escape(t('entity.render.color_temp') || 'Color temp')}">
      </div>` : '';

    this.innerHTML = `
      <div class="hyve-light" data-layout="${layout}">
        <div class="hyve-light__head">
          <span class="hyve-dashboard-card__icon hyve-light__icon" data-icon-wrap style="--light-accent:${escAttr(colorHex)}">
            <i data-icon class="fas fa-lightbulb"></i>
          </span>
          <div class="hyve-dashboard-card__body hyve-light__body">
            <div class="hyve-dashboard-card__title" data-title>${escape(title)}</div>
            <div class="hyve-light__value" data-live-value>—</div>
          </div>
        </div>
        ${hasControls ? `
        <div class="hyve-light__controls" data-controls>
          ${brightnessBlock}
          ${colorBlock}
          ${colorTempBlock}
        </div>` : ''}
      </div>`;

    this._liveValueEl = this.querySelector('[data-live-value]');
    this._iconWrapEl = this.querySelector('[data-icon-wrap]');
    this._controlsEl = this.querySelector('[data-controls]');
    this._sliderWrapEl = this.querySelector('[data-brightness]');
    this._sliderEl = this.querySelector('[data-brightness-slider]');

    this._syncIcon(w, on);

    if (this._sliderEl) {
      this._sliderEl.addEventListener('pointerdown', () => { this._sliderActive = true; });
      this._sliderEl.addEventListener('pointerup', () => { this._sliderActive = false; });
      this._sliderEl.addEventListener('pointercancel', () => { this._sliderActive = false; });
      this._sliderEl.addEventListener('blur', () => { this._sliderActive = false; });
    }

    const article = this._parentArticle();
    if (article) {
      article.setAttribute('data-light-layout', layout);
      article.setAttribute('data-light-controls', hasControls ? 'true' : 'false');
    }
  }

  _isOn(w: CardWidget): boolean {
    const stateStr = String(w.current_state == null ? 'unknown' : w.current_state);
    return typeof host.stateOn === 'function'
      ? host.stateOn(stateStr)
      : ['on', 'true', '1'].includes(stateStr.toLowerCase());
  }

  _syncIcon(w: CardWidget, on: boolean) {
    const iconEl = this.querySelector('[data-icon]');
    if (!iconEl) return;
    const iconSpec = (typeof host.widgetIcon === 'function' ? host.widgetIcon(w) : w.icon)
      || (typeof host.entityIconForState === 'function'
        ? host.entityIconForState('light', on)
        : (on ? 'fas fa-lightbulb' : 'far fa-lightbulb'));
    iconEl.className = host.iconClass ? host.iconClass(iconSpec) : String(iconSpec);
  }

  _applyState() {
    const w = (this._config || {}) as CardWidget;
    const opts = readLightOptions(w);
    const on = this._isOn(w);
    const flags = this._flags || resolveLightControlFlags(
      { state: w.current_state, attributes: w.attributes },
      on,
    );
    const scale = flags.brightnessScale || 254;
    const rawBright = Number((w.attributes as Record<string, unknown> | undefined)?.brightness);
    const pct = on && Number.isFinite(rawBright)
      ? Math.max(0, Math.min(100, Math.round((rawBright / scale) * 100)))
      : (on ? 100 : 0);

    const valueText = on
      ? (flags.hasBrightness ? `${pct}%` : tState('on'))
      : tState('off');
    if (this._liveValueEl) this._liveValueEl.textContent = valueText;

    const brightLabel = this.querySelector('[data-brightness-label]');
    if (brightLabel) brightLabel.textContent = `${pct}%`;

    if (this._sliderWrapEl) {
      this._sliderWrapEl.style.setProperty('--brightness-pct', `${pct}%`);
    }
    if (this._iconWrapEl) {
      this._iconWrapEl.style.setProperty('--light-pct', String(pct));
      const hex = lightColorToHex((w.attributes || {}) as Record<string, unknown>);
      this._iconWrapEl.style.setProperty('--light-accent', hex);
    }
    if (this._sliderEl && !this._sliderActive && document.activeElement !== this._sliderEl) {
      this._sliderEl.value = String(pct);
    }

    const ctRaw = Number((w.attributes as Record<string, unknown> | undefined)?.color_temp);
    const ctLabel = this.querySelector('[data-color-temp-label]');
    const ctSlider = this.querySelector('.hyve-light__range--temp') as HTMLInputElement | null;
    if (Number.isFinite(ctRaw)) {
      if (ctLabel) ctLabel.textContent = String(ctRaw);
      if (ctSlider && document.activeElement !== ctSlider) ctSlider.value = String(ctRaw);
    }

    this._syncIcon(w, on);

    const available = w.available !== false;
    const expanded = on || !opts.collapseWhenOff;
    const article = this._parentArticle();
    if (article) {
      article.setAttribute('data-on', on ? 'true' : 'false');
      article.setAttribute('data-unavailable', available ? 'false' : 'true');
      article.setAttribute('data-expanded', expanded ? 'true' : 'false');
      const pending = typeof host.controlVisuallyPending === 'function' && w.id
        ? host.controlVisuallyPending(w.id) : false;
      article.setAttribute('data-pending', pending ? 'true' : 'false');
      if (w.entity_id) article.setAttribute('data-entity-id', w.entity_id);
    }
    if (this._controlsEl) {
      this._controlsEl.toggleAttribute('hidden', !expanded);
    }
  }
}
