/**
 * <hv-card-tile> — universal tile card used by tile/button/switch/scene/info.
 *
 * The same class is registered for all five renderer types. Behavior is
 * driven by widget.renderer + widget.controllable + widget.switch_style.
 *
 * Outer article (rendered by dashboard.js) owns drag/edit/click plumbing
 * and the [data-on]/[data-pending]/[data-unavailable] attributes that
 * card CSS keys off of. setState() mutates the inner DOM AND mirrors
 * those data-* attrs back onto the parent article so legacy selectors
 * keep working without a full grid re-render.
 */
import { HyveviewCardBase } from '../core/card-base.js';
import { host, widgetTitle } from '../host.js';
import { t, tState } from '../../js/lang/index.js';

export class HyveviewTileCard extends HyveviewCardBase {
  static meta = {
    name: 'Tile',
    description: 'Generic clickable tile (button / switch / scene / info).',
    icon: '🔘',
  };
  static schema = {
    fields: [
      { key: 'entity_id', label: 'Entity', type: 'entity', required: true },
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Auto from entity if blank' },
      { key: 'icon', label: 'Icon', type: 'icon', placeholder: 'fas fa-bolt' },
      { key: 'color', label: 'Accent color', type: 'color' },
      { key: 'switch_style', label: 'Render as toggle switch', type: 'boolean', default: false },
    ],
  };
  static getStubConfig(entityId) {
    return { entity_id: entityId || '', title: '', icon: '', color: '', switch_style: false };
  }

  constructor() {
    super();
    this._titleEl = null;
    this._stateEl = null;
    this._iconEl = null;
    this._toggleEl = null;
    this._unavailableBadge = null;
  }

  setConfig(widget) {
    this._config = widget || {};
    this._render();
    this._applyState(widget?.current_state, widget?.unit, widget?.available !== false);
  }

  setState(entity) {
    if (!entity) return;
    const w = this._config || {};
    if (entity.entity_id && entity.entity_id !== w.entity_id) return;
    w.current_state = entity.state;
    if (entity.unit) w.unit = entity.unit;
    w.attributes = { ...(w.attributes || {}), ...(entity.attributes || {}) };
    w.available = entity.available !== false;
    this._applyState(entity.state, entity.unit || w.unit || '', w.available);
  }

  _render() {
    const w = this._config || {};
    const escape = host.escape;
    const renderer = String(w.renderer || w.type || 'button').toLowerCase();
    const interactive = renderer !== 'info';
    const controllable = interactive && w.controllable !== false
      && (renderer === 'tile' || renderer === 'button' || renderer === 'switch' || renderer === 'scene');
    const showSwitchStyle = w.type === 'switch' || w.switch_style === true;
    const showToggle = controllable && showSwitchStyle;
    const title = widgetTitle(w);
    // Inner DOM only — the article wrapper is owned by the host renderer.
    this.innerHTML = `
      <div class="hyve-dashboard-card__row">
        <span class="hyve-dashboard-card__icon"><i data-icon></i></span>
        <div class="hyve-dashboard-card__body">
          <div class="hyve-dashboard-card__title" data-title>${escape(title)}</div>
          <div class="hyve-dashboard-card__state" data-state></div>
        </div>
        ${showToggle ? `<span data-entity-toggle="${escape(w.entity_id || '')}" data-on="false" class="app-toggle-switch flex-shrink-0 pointer-events-none" aria-hidden="true"><span class="app-toggle-thumb"></span></span>` : ''}
        <span class="hyve-dashboard-card__badge" data-unavailable-badge hidden>${t('entity.unavailable')}</span>
      </div>
    `;
    this._titleEl = this.querySelector('[data-title]');
    this._stateEl = this.querySelector('[data-state]');
    this._iconEl = this.querySelector('[data-icon]');
    this._toggleEl = this.querySelector('[data-entity-toggle]');
    this._unavailableBadge = this.querySelector('[data-unavailable-badge]');
    this._showToggle = showToggle;
    this._renderer = renderer;
    this._applyIcon(typeof host.stateOn === 'function' ? host.stateOn(w.current_state) : false);
  }

  _customIcon(w = this._config || {}) {
    if (typeof host.widgetIcon === 'function') return host.widgetIcon(w);
    const cfg = w.config && typeof w.config === 'object' ? w.config : {};
    return String(w.icon || cfg.icon || '').trim();
  }

  _applyIcon(on) {
    const w = this._config || {};
    const customIcon = this._customIcon(w);
    const iconSpec = customIcon || (typeof host.entityIconForState === 'function'
      ? host.entityIconForState(w.domain, on) : 'fas fa-circle');
    if (this._iconEl) {
      this._iconEl.className = host.iconClass ? host.iconClass(iconSpec) : String(iconSpec);
    }
  }

  _applyState(rawState, presetUnit, available) {
    if (!this._stateEl) return;
    const w = this._config || {};
    const escape = host.escape;
    const stateStr = String(rawState == null ? 'unknown' : rawState);
    const unit = presetUnit || w.unit || '';
    const unitSuffix = unit && !stateStr.endsWith(unit) ? ' ' + unit : '';
    this._stateEl.textContent = tState(stateStr) + unitSuffix;

    const on = typeof host.stateOn === 'function' ? host.stateOn(stateStr) : ['on','open','playing','home','heat','cool','heat_cool','auto','dry','fan_only','active','true','1'].includes(stateStr.toLowerCase());
    this._applyIcon(on);

    // Mirror state onto the host article so CSS selectors targeting
    // .hyve-dashboard-card[data-on] / [data-unavailable] / [data-pending]
    // continue to work without a full grid re-render.
    const article = this.parentElement && this.parentElement.tagName === 'ARTICLE'
      ? this.parentElement : this.closest('article');
    if (article) {
      article.setAttribute('data-on', on ? 'true' : 'false');
      article.setAttribute('data-unavailable', available === false ? 'true' : 'false');
      const pending = typeof host.controlVisuallyPending === 'function' && w.id
        ? host.controlVisuallyPending(w.id) : false;
      article.setAttribute('data-pending', pending ? 'true' : 'false');
      if (w.entity_id) article.setAttribute('data-entity-id', w.entity_id);
    }
    if (this._toggleEl) this._toggleEl.setAttribute('data-on', on ? 'true' : 'false');
    if (this._unavailableBadge) this._unavailableBadge.hidden = available !== false;
  }
}
