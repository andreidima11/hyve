/**
 * <hv-card-lawn-mower> — robot lawn mower with start / pause / dock actions.
 */
import { HyveviewCardBase } from '../../core/card-base.js';
import { host, widgetTitle } from '../../host.js';
import type { CardWidget, HyveviewEntityState } from '../../types/card-widget.js';

const _STATE_META = {
  mowing:    { icon: 'fa-leaf',           label: 'Tunde',       on: true },
  returning: { icon: 'fa-house',          label: 'Se întoarce', on: true },
  paused:    { icon: 'fa-circle-pause',   label: 'Pauză',       on: false },
  docked:    { icon: 'fa-plug-circle-bolt', label: 'La dock',   on: false },
  idle:      { icon: 'fa-seedling',       label: 'Inactiv',     on: false },
  error:     { icon: 'fa-triangle-exclamation', label: 'Eroare', on: false },
  unknown:   { icon: 'fa-seedling',       label: 'Necunoscut',  on: false },
};

function _meta(state: unknown) {
  const key = String(state || 'unknown').toLowerCase() as keyof typeof _STATE_META;
  return _STATE_META[key] || _STATE_META.unknown;
}

export class HyveviewLawnMowerCard extends HyveviewCardBase {
  protected _batteryEl: HTMLElement | null;
  protected _iconEl: HTMLElement | null;
  protected _startBtn: HTMLElement | null;
  protected _stateEl: HTMLElement | null;
  protected _stopBtn: HTMLElement | null;
  static meta = {
    name: 'Lawn mower',
    description: 'Robot lawn mower with start / pause / dock controls.',
    icon: '🌿',
  };
  static schema = {
    fields: [
      { key: 'entity_id', label: 'Lawn mower entity', type: 'entity', domains: ['lawn_mower'], required: true },
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Auto from entity if blank' },
      { key: 'icon', label: 'Icon', type: 'icon', placeholder: 'fas fa-leaf' },
    ],
  };
  static getStubConfig(entityId?: string) {
    return { entity_id: entityId || '', title: '', icon: '' };
  }

  constructor() {
    super();
    this._iconEl = null;
    this._stateEl = null;
    this._batteryEl = null;
    this._startBtn = null;
    this._stopBtn = null;
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
    w.attributes = { ...(w.attributes || {}), ...(entity.attributes || {}) };
    w.available = entity.available !== false;
    this._applyState();
  }

  _render() {
    const w = (this._config || {}) as CardWidget;
    const escape = host.escape;
    const editMode = !!w._edit_mode;
    const title = widgetTitle(w);
    const wid = escape(w.id || '');
    const showActions = !editMode && w.available !== false;
    this.innerHTML = `
      <div class="hyve-dashboard-card__row">
        <span class="hyve-dashboard-card__icon"><i data-icon class="fas fa-leaf"></i></span>
        <div class="hyve-dashboard-card__body">
          <div class="hyve-dashboard-card__title" data-title>${escape(title)}</div>
          <div class="hyve-dashboard-card__state" data-state></div>
        </div>
        <span class="hyve-dashboard-card__lawn-mower-battery" data-battery hidden></span>
      </div>
      ${showActions ? `
        <div class="hyve-dashboard-card__lawn-mower-actions">
          <button type="button" class="hyve-dashboard-card__lawn-mower-btn" data-start-btn data-active="false"
            title="Start" data-dash-action="lawnMowerAction" data-dash-stop-propagation="true" data-widget-id="${wid}" data-action="start">
            <i class="fas fa-play"></i>
          </button>
          <button type="button" class="hyve-dashboard-card__lawn-mower-btn" data-stop-btn data-active="false"
            title="Stop" data-dash-action="lawnMowerAction" data-dash-stop-propagation="true" data-widget-id="${wid}" data-action="stop">
            <i class="fas fa-stop"></i>
          </button>
          <button type="button" class="hyve-dashboard-card__lawn-mower-btn"
            title="Dock" data-dash-action="lawnMowerAction" data-dash-stop-propagation="true" data-widget-id="${wid}" data-action="return_to_base">
            <i class="fas fa-house"></i>
          </button>
          <button type="button" class="hyve-dashboard-card__lawn-mower-btn"
            title="Pauză" data-dash-action="lawnMowerAction" data-dash-stop-propagation="true" data-widget-id="${wid}" data-action="pause">
            <i class="fas fa-pause"></i>
          </button>
        </div>` : ''}
    `;
    this._iconEl = this.querySelector('[data-icon]');
    this._stateEl = this.querySelector('[data-state]');
    this._batteryEl = this.querySelector('[data-battery]');
    this._startBtn = this.querySelector('[data-start-btn]');
    this._stopBtn = this.querySelector('[data-stop-btn]');
  }

  _applyState() {
    if (!this._stateEl) return;
    const w = (this._config || {}) as CardWidget;
    const state = String(w.current_state == null ? 'unknown' : w.current_state).toLowerCase();
    const meta = _meta(state);
    const attrs = (w.attributes && typeof w.attributes === 'object' ? w.attributes : {}) as Record<string, unknown>;
    const statusKey = String(attrs.status_key || '').trim();
    let statusLabel = null;
    if (statusKey && typeof host.t === 'function') {
      const keyPath = 'hyveview.lawn_mower.status.' + statusKey;
      const translated = host.t(keyPath);
      if (translated && translated !== keyPath) statusLabel = translated;
    }
    if (!statusLabel) {
      const translate = typeof host.tLawnMowerStatus === 'function' ? host.tLawnMowerStatus : null;
      statusLabel = String(translate
        ? translate(attrs.status, state)
        : (attrs.status || meta.label));
    }

    if (this._iconEl) {
      const custom = typeof host.widgetIcon === 'function' ? host.widgetIcon(w) : String(w.icon || '').trim();
      if (custom) {
        this._iconEl.className = host.iconClass ? host.iconClass(custom) : custom;
      } else {
        this._iconEl.className = 'fas ' + meta.icon;
      }
    }
    this._stateEl.textContent = statusLabel;

    const battery = attrs.battery_level != null ? attrs.battery_level : attrs.battery;
    if (this._batteryEl) {
      if (battery != null && battery !== '') {
        const pct = Number(battery);
        const ico = Number.isFinite(pct)
          ? (pct >= 90 ? 'fa-battery-full'
            : pct >= 60 ? 'fa-battery-three-quarters'
            : pct >= 35 ? 'fa-battery-half'
            : pct >= 15 ? 'fa-battery-quarter'
            : 'fa-battery-empty')
          : 'fa-battery-half';
        this._batteryEl.innerHTML = `<i class="fas ${ico}"></i> ${Number.isFinite(pct) ? pct + '%' : host.escape(String(battery))}`;
        this._batteryEl.hidden = false;
      } else {
        this._batteryEl.hidden = true;
      }
    }

    if (this._startBtn) this._startBtn.setAttribute('data-active', meta.on ? 'true' : 'false');
    if (this._stopBtn) this._stopBtn.setAttribute('data-active', (state === 'idle' || state === 'paused') ? 'true' : 'false');

    const available = w.available !== false;
    const article = this.parentElement && this.parentElement.tagName === 'ARTICLE'
      ? this.parentElement : this.closest('article');
    if (article) {
      article.setAttribute('data-on', meta.on ? 'true' : 'false');
      article.setAttribute('data-unavailable', available ? 'false' : 'true');
    }
  }

  refreshI18n() {
    this._applyState();
  }
}
