/**
 * <hv-card-light> — Mushroom-style light card.
 * Header (icon shape + name + state) with a row of bar sliders
 * (brightness / color temperature / hue) that collapses when off.
 */
import { HyveviewCardBase } from '../../core/card-base.js';
import { host, widgetTitle } from '../../host.js';
import { t, tState } from '../../../js/lang/index.js';
import {
  hexToHsv,
  lightColorToHex,
  resolveLightControlFlags,
} from '../../../js/light_controls.js';
import type { CardWidget, HyveviewEntityState } from '../../types/card-widget.js';

interface LightCardOptions {
  collapseWhenOff: boolean;
  showBrightness: boolean;
  showColor: boolean;
  showColorTemp: boolean;
}

const DEFAULT_LIGHT_ACCENT = '#ff9800';

/** Sticky per-widget choice of which control the single visible slider shows. */
const _activeModeByWidget = new Map<string, string>();

/** After a local slider interaction, ignore incoming state for this long. */
const LOCAL_HOLD_MS = 1600;

const MODE_ORDER = ['brightness', 'temp', 'color'] as const;

const MODE_ICONS: Record<string, string> = {
  brightness: 'fas fa-sun',
  temp: 'fas fa-temperature-half',
  color: 'fas fa-palette',
};

function optionFlag(w: CardWidget, key: string): boolean {
  const cfg = (w.config && typeof w.config === 'object' ? w.config : {}) as Record<string, unknown>;
  const raw = Object.prototype.hasOwnProperty.call(cfg, key) ? cfg[key] : w[key];
  return raw !== false && raw !== 'false' && raw !== 0;
}

function readLightOptions(w: CardWidget): LightCardOptions {
  return {
    collapseWhenOff: optionFlag(w, 'collapse_when_off'),
    showBrightness: optionFlag(w, 'show_brightness'),
    showColor: optionFlag(w, 'show_color'),
    showColorTemp: optionFlag(w, 'show_color_temp'),
  };
}

export class HyveviewLightCard extends HyveviewCardBase {
  protected _rootEl: HTMLElement | null = null;
  protected _secondaryEl: HTMLElement | null = null;
  protected _actionsEl: HTMLElement | null = null;
  protected _activeSliders = new Set<string>();
  protected _localHold = new Map<string, number>();
  protected _renderSig = '';

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
        key: 'show_brightness',
        label: 'Brightness slider',
        type: 'boolean',
        default: true,
        inline: true,
      },
      {
        key: 'show_color_temp',
        label: 'Color temperature slider',
        type: 'boolean',
        default: true,
        inline: true,
        hint: 'Shown when the light supports warm/cool white.',
      },
      {
        key: 'show_color',
        label: 'Color slider',
        type: 'boolean',
        default: true,
        inline: true,
        hint: 'Shown when the light supports RGB/HS color.',
      },
      {
        key: 'collapse_when_off',
        label: 'Collapse when off',
        type: 'boolean',
        default: true,
        inline: true,
        hint: 'Hide the sliders while the light is off.',
      },
    ],
  };
  static getStubConfig(entityId?: string) {
    return {
      entity_id: entityId || '',
      title: '',
      icon: '',
      collapse_when_off: true,
      show_brightness: true,
      show_color: true,
      show_color_temp: true,
    };
  }

  setConfig(widget: CardWidget | null | undefined) {
    this._config = widget || {};
    this._render();
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

  _isOn(w: CardWidget): boolean {
    const stateStr = String(w.current_state == null ? 'unknown' : w.current_state);
    return typeof host.stateOn === 'function'
      ? host.stateOn(stateStr)
      : ['on', 'true', '1'].includes(stateStr.toLowerCase());
  }

  _visibleControls(w: CardWidget): { brightness: boolean; temp: boolean; color: boolean } {
    const opts = readLightOptions(w);
    const flags = resolveLightControlFlags(
      { state: w.current_state, attributes: w.attributes },
      this._isOn(w),
    );
    return {
      brightness: opts.showBrightness && flags.hasBrightness,
      temp: opts.showColorTemp && flags.hasColorTemp,
      color: opts.showColor && flags.hasColor,
    };
  }

  _signature(w: CardWidget): string {
    const c = this._visibleControls(w);
    return `${c.brightness}|${c.temp}|${c.color}`;
  }

  _availableModes(w: CardWidget): string[] {
    const c = this._visibleControls(w);
    const enabled: Record<string, boolean> = { brightness: c.brightness, temp: c.temp, color: c.color };
    return MODE_ORDER.filter((mode) => enabled[mode]);
  }

  _activeMode(w: CardWidget, modes: string[]): string {
    const wid = String(w.id || '');
    const remembered = _activeModeByWidget.get(wid) || '';
    if (remembered && modes.includes(remembered)) return remembered;
    return modes[0] || '';
  }

  _setActiveMode(mode: string) {
    const w = (this._config || {}) as CardWidget;
    const wid = String(w.id || '');
    if (wid) _activeModeByWidget.set(wid, mode);
    this._syncActiveMode(mode);
  }

  _syncActiveMode(mode: string) {
    this.querySelectorAll('[data-slider]').forEach((node) => {
      const el = node as HTMLElement;
      el.toggleAttribute('hidden', el.dataset.slider !== mode);
    });
    this.querySelectorAll('[data-mode]').forEach((node) => {
      const btn = node as HTMLElement;
      btn.setAttribute('aria-pressed', btn.dataset.mode === mode ? 'true' : 'false');
    });
  }

  _render() {
    const w = (this._config || {}) as CardWidget;
    const escape = host.escape;
    const escAttr = (value: unknown) => escape(String(value ?? ''));
    const flags = resolveLightControlFlags(
      { state: w.current_state, attributes: w.attributes },
      this._isOn(w),
    );
    const controls = this._visibleControls(w);
    this._renderSig = this._signature(w);

    const title = widgetTitle(w);
    const wid = escape(w.id || '');

    const brightnessSlider = controls.brightness ? `
      <div class="hyve-light__slider hyve-light__slider--brightness" data-slider="brightness" style="--value:0">
        <div class="hyve-light__slider-bg"></div>
        <div class="hyve-light__slider-active"></div>
        <div class="hyve-light__slider-indicator"></div>
        <input type="range" min="0" max="100" step="1" value="0"
          data-slider-input="brightness"
          data-dash-input="brightnessInput"
          data-dash-change="brightnessChange"
          data-dash-stop-propagation="true"
          data-widget-id="${wid}"
          aria-label="${escape(t('entity.render.brightness') || 'Brightness')}">
      </div>` : '';

    const tempSlider = controls.temp ? `
      <div class="hyve-light__slider hyve-light__slider--temp" data-slider="temp" style="--value:0.5">
        <div class="hyve-light__slider-bg"></div>
        <div class="hyve-light__slider-indicator"></div>
        <input type="range" min="${flags.colorTempMin}" max="${flags.colorTempMax}" step="1"
          value="${flags.colorTempValue}"
          data-slider-input="temp"
          data-dash-input="lightColorTempInput"
          data-dash-change="lightColorTempChange"
          data-dash-stop-propagation="true"
          data-widget-id="${wid}"
          aria-label="${escape(t('entity.render.color_temp') || 'Color temp')}">
      </div>` : '';

    const colorSlider = controls.color ? `
      <div class="hyve-light__slider hyve-light__slider--color" data-slider="color" style="--value:0">
        <div class="hyve-light__slider-bg"></div>
        <div class="hyve-light__slider-indicator"></div>
        <input type="range" min="0" max="360" step="1" value="0"
          data-slider-input="color"
          data-dash-input="lightHueInput"
          data-dash-change="lightHueChange"
          data-dash-stop-propagation="true"
          data-widget-id="${wid}"
          aria-label="${escape(t('entity.render.color') || 'Color')}">
      </div>` : '';

    const modes = this._availableModes(w);
    const hasControls = modes.length > 0;
    const activeMode = this._activeMode(w, modes);

    const modeLabels: Record<string, string> = {
      brightness: t('entity.render.brightness') || 'Brightness',
      temp: t('entity.render.color_temp') || 'Color temp',
      color: t('entity.render.color') || 'Color',
    };
    const modeButtons = modes.length > 1 ? `
      <div class="hyve-light__modes" data-modes>
        ${modes.map((mode) => `
          <button type="button" class="hyve-light__mode" data-mode="${escAttr(mode)}"
            aria-pressed="${mode === activeMode ? 'true' : 'false'}"
            title="${escAttr(modeLabels[mode] || mode)}" aria-label="${escAttr(modeLabels[mode] || mode)}">
            <i class="${escAttr(MODE_ICONS[mode] || 'fas fa-circle')}" aria-hidden="true"></i>
          </button>`).join('')}
      </div>` : '';

    this.innerHTML = `
      <div class="hyve-light" style="--light-accent:${escAttr(DEFAULT_LIGHT_ACCENT)}">
        <div class="hyve-light__head">
          <span class="hyve-light__shape" data-icon-wrap>
            <i data-icon class="fas fa-lightbulb"></i>
          </span>
          <div class="hyve-light__info">
            <span class="hyve-light__primary" data-title>${escape(title)}</span>
            <span class="hyve-light__secondary" data-live-value>—</span>
          </div>
        </div>
        ${hasControls ? `
        <div class="hyve-light__actions" data-controls>
          ${brightnessSlider}
          ${tempSlider}
          ${colorSlider}
          ${modeButtons}
        </div>` : ''}
      </div>`;

    this._rootEl = this.querySelector('.hyve-light');
    this._secondaryEl = this.querySelector('[data-live-value]');
    this._actionsEl = this.querySelector('[data-controls]');

    this.querySelectorAll('[data-slider-input]').forEach((node) => {
      const input = node as HTMLInputElement;
      const kind = input.dataset.sliderInput || '';
      input.addEventListener('pointerdown', () => { this._activeSliders.add(kind); });
      const release = () => {
        this._activeSliders.delete(kind);
        this._localHold.set(kind, Date.now());
      };
      input.addEventListener('pointerup', release);
      input.addEventListener('pointercancel', release);
      input.addEventListener('blur', release);
      input.addEventListener('input', () => {
        this._localHold.set(kind, Date.now());
        this._onLocalSliderInput(kind, input);
      });
    });

    this.querySelectorAll('[data-mode]').forEach((node) => {
      const btn = node as HTMLButtonElement;
      btn.addEventListener('click', (event) => {
        event.stopPropagation();
        this._setActiveMode(btn.dataset.mode || '');
      });
    });

    this._syncActiveMode(activeMode);
    this._applyState();
  }

  _onLocalSliderInput(kind: string, input: HTMLInputElement) {
    const wrap = input.closest('.hyve-light__slider') as HTMLElement | null;
    if (!wrap) return;
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const value = Number(input.value) || 0;
    const ratio = max > min ? (value - min) / (max - min) : 0;
    wrap.style.setProperty('--value', String(Math.max(0, Math.min(1, ratio))));
    if (kind === 'brightness' && this._secondaryEl) {
      this._secondaryEl.textContent = `${Math.round(value)}%`;
    }
  }

  _setSlider(kind: string, value: number) {
    const wrap = this.querySelector(`[data-slider="${kind}"]`) as HTMLElement | null;
    const input = this.querySelector(`[data-slider-input="${kind}"]`) as HTMLInputElement | null;
    if (!wrap || !input) return;
    if (this._activeSliders.has(kind) || document.activeElement === input) return;
    // Right after a local drag, ignore (possibly stale) incoming state so the
    // slider doesn't snap back before the device reports the new value.
    const heldAt = this._localHold.get(kind) || 0;
    if (heldAt && Date.now() - heldAt < LOCAL_HOLD_MS) return;
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const clamped = Math.max(min, Math.min(max, value));
    input.value = String(clamped);
    const ratio = max > min ? (clamped - min) / (max - min) : 0;
    wrap.style.setProperty('--value', String(ratio));
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
    if (this._signature(w) !== this._renderSig) {
      this._render();
      return;
    }
    const opts = readLightOptions(w);
    const on = this._isOn(w);
    const flags = resolveLightControlFlags(
      { state: w.current_state, attributes: w.attributes },
      on,
    );
    const attrs = (w.attributes || {}) as Record<string, unknown>;

    const scale = flags.brightnessScale || 254;
    const rawBright = Number(attrs.brightness);
    const pct = on && Number.isFinite(rawBright)
      ? Math.max(0, Math.min(100, Math.round((rawBright / scale) * 100)))
      : (on ? 100 : 0);

    if (this._secondaryEl) {
      this._secondaryEl.textContent = on
        ? (flags.hasBrightness ? `${pct}%` : tState('on'))
        : tState('off');
    }

    // Accent: light color when colored, mushroom amber otherwise.
    const hex = lightColorToHex(attrs);
    const accent = (flags.hasColor && /^#[0-9a-f]{6}$/i.test(hex) && hex.toLowerCase() !== '#ffffff')
      ? hex
      : DEFAULT_LIGHT_ACCENT;
    if (this._rootEl) this._rootEl.style.setProperty('--light-accent', accent);

    this._setSlider('brightness', pct);
    const ctRaw = Number(attrs.color_temp);
    if (Number.isFinite(ctRaw)) this._setSlider('temp', ctRaw);
    this._setSlider('color', hexToHsv(hex).h);

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
      this._syncCollapse(article, !expanded);
    }
    if (this._actionsEl) {
      this._actionsEl.toggleAttribute('hidden', !expanded);
    }
  }

  /** Shrink the card to one grid row while collapsed (e.g. 4x2 → 4x1 when off). */
  _syncCollapse(article: HTMLElement, collapsed: boolean) {
    const editMode = article.getAttribute('data-edit') === 'true';
    const shouldCollapse = collapsed && !editMode;
    const already = article.getAttribute('data-collapsed') === 'true';
    if (shouldCollapse === already) return;
    if (shouldCollapse) {
      article.dataset.hyveExpandedRow = article.style.gridRow || '';
      article.dataset.hyveExpandedHr = article.style.getPropertyValue('--hr') || '';
      const startMatch = (article.style.gridRow || '').match(/^\s*(\d+)\s*\/\s*span\s+\d+\s*$/);
      article.style.gridRow = startMatch ? `${startMatch[1]} / span 1` : 'span 1';
      article.style.setProperty('--hr', '1');
      article.setAttribute('data-collapsed', 'true');
    } else {
      if (article.dataset.hyveExpandedRow !== undefined) {
        article.style.gridRow = article.dataset.hyveExpandedRow;
        delete article.dataset.hyveExpandedRow;
      }
      if (article.dataset.hyveExpandedHr !== undefined) {
        if (article.dataset.hyveExpandedHr) {
          article.style.setProperty('--hr', article.dataset.hyveExpandedHr);
        } else {
          article.style.removeProperty('--hr');
        }
        delete article.dataset.hyveExpandedHr;
      }
      article.setAttribute('data-collapsed', 'false');
    }
  }
}
