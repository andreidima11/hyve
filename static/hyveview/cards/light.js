/**
 * <hv-card-light> — light card with brightness slider.
 *
 * Outer article (rendered by dashboard.js) owns drag/edit/click plumbing
 * and the data-on/data-pending/data-unavailable attributes. The brightness
 * slider keeps legacy window handlers — we only update the slider value, display
 * %, and CSS var in-place on setState() without re-render.
 */
import { HyveviewCardBase } from '../core/card-base.js';
import { host, widgetTitle } from '../host.js';
import { tState } from '../../js/lang/index.js';

export class HyveviewLightCard extends HyveviewCardBase {
  static meta = {
    name: 'Light',
    description: 'Light entity with on/off toggle and brightness slider.',
    icon: '💡',
  };
  static schema = {
    fields: [
      { key: 'entity_id', label: 'Light entity', type: 'entity', domains: ['light', 'switch'], required: true },
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Auto from entity if blank' },
      { key: 'icon', label: 'Icon', type: 'icon', placeholder: 'fas fa-lightbulb' },
    ],
  };
  static getStubConfig(entityId) {
    return { entity_id: entityId || '', title: '', icon: '' };
  }

  constructor() {
    super();
    this._titleEl = null;
    this._stateEl = null;
    this._iconEl = null;
    this._brightnessEl = null;
    this._sliderEl = null;
    this._brightValueEl = null;
    this._supportsBrightness = false;
    // Track whether user is actively dragging slider to avoid clobbering input.
    this._sliderActive = false;
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
    if (entity.unit) w.unit = entity.unit;
    w.attributes = { ...(w.attributes || {}), ...(entity.attributes || {}) };
    w.available = entity.available !== false;
    this._applyState();
  }

  _render() {
    const w = this._config || {};
    const escape = host.escape;
    const attrs = w.attributes || {};
    const caps = (attrs.capabilities || {});
    this._supportsBrightness = !!(caps.brightness_command_topic || attrs.brightness != null);
    const editMode = !!w._edit_mode;
    const title = widgetTitle(w);
    const wid = escape(w.id || '');

    this.innerHTML = `
      <div class="hyve-dashboard-card__row">
        <span class="hyve-dashboard-card__icon"><i data-icon class="fas fa-lightbulb"></i></span>
        <div class="hyve-dashboard-card__body">
          <div class="hyve-dashboard-card__title" data-title>${escape(title)}</div>
          <div class="hyve-dashboard-card__state" data-state></div>
        </div>
      </div>
      ${this._supportsBrightness && !editMode ? `
        <div class="hyve-dashboard-card__brightness" data-brightness style="--brightness-pct: 0%">
          <i class="fas fa-sun"></i>
          <input type="range" min="0" max="100" value="0"
            class="hyve-dashboard-card__brightness-slider"
            data-brightness-slider
            data-dash-input="brightnessInput"
            data-dash-change="brightnessChange"
            data-widget-id="${wid}"
            aria-label="Luminozitate">
          <span class="hyve-dashboard-card__brightness-value" data-brightness-value>0%</span>
        </div>` : ''}
    `;
    this._titleEl = this.querySelector('[data-title]');
    this._stateEl = this.querySelector('[data-state]');
    this._iconEl = this.querySelector('[data-icon]');
    this._brightnessEl = this.querySelector('[data-brightness]');
    this._sliderEl = this.querySelector('[data-brightness-slider]');
    this._brightValueEl = this.querySelector('[data-brightness-value]');

    if (this._sliderEl) {
      // Track user interaction so live updates don't fight the user.
      this._sliderEl.addEventListener('pointerdown', () => { this._sliderActive = true; });
      this._sliderEl.addEventListener('pointerup', () => { this._sliderActive = false; });
      this._sliderEl.addEventListener('pointercancel', () => { this._sliderActive = false; });
      this._sliderEl.addEventListener('blur', () => { this._sliderActive = false; });
    }
  }

  _applyState() {
    if (!this._stateEl) return;
    const w = this._config || {};
    const attrs = w.attributes || {};
    const caps = (attrs.capabilities || {});
    const stateStr = String(w.current_state == null ? 'unknown' : w.current_state);
    const on = typeof host.stateOn === 'function' ? host.stateOn(stateStr)
      : ['on','true','1'].includes(stateStr.toLowerCase());
    const scale = Number(caps.brightness_scale) || 254;
    const rawBrightness = Number(attrs.brightness != null ? attrs.brightness : (on ? scale : 0));
    const pct = Math.max(0, Math.min(100, Math.round((rawBrightness / scale) * 100)));
    const stateText = on ? `${pct}%` : tState('off');
    this._stateEl.textContent = stateText;

    if (this._brightnessEl) {
      this._brightnessEl.style.setProperty('--brightness-pct', pct + '%');
      if (this._brightValueEl) this._brightValueEl.textContent = pct + '%';
      if (this._sliderEl && !this._sliderActive && document.activeElement !== this._sliderEl) {
        this._sliderEl.value = String(pct);
      }
    }

    const available = w.available !== false;
    const article = this.parentElement && this.parentElement.tagName === 'ARTICLE'
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
