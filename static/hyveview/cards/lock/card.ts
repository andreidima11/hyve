/**
 * <hv-card-lock> — lock entity with dual action buttons.
 */
import { HyveviewCardBase } from '../../core/card-base.js';
import { host, widgetTitle } from '../../host.js';
import { t, tState } from '../../../js/lang/index.js';
import type { CardWidget, HyveviewEntityState } from '../../types/card-widget.js';

export class HyveviewLockCard extends HyveviewCardBase {
  protected _iconEl: HTMLElement | null;
  protected _lockBtn: HTMLElement | null;
  protected _stateEl: HTMLElement | null;
  protected _unlockBtn: HTMLElement | null;
  static meta = {
    name: 'Lock',
    description: 'Lock entity with dual lock/unlock action buttons.',
    icon: '🔒',
  };
  static schema = {
    fields: [
      { key: 'entity_id', label: 'Lock entity', type: 'entity', domains: ['lock'], required: true },
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Auto from entity if blank' },
      { key: 'icon', label: 'Icon', type: 'icon', placeholder: 'fas fa-lock' },
    ],
  };
  static getStubConfig(entityId?: string) {
    return { entity_id: entityId || '', title: '', icon: '' };
  }

  constructor() {
    super();
    this._iconEl = null;
    this._stateEl = null;
    this._lockBtn = null;
    this._unlockBtn = null;
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
        <span class="hyve-dashboard-card__icon"><i data-icon class="fas fa-lock"></i></span>
        <div class="hyve-dashboard-card__body">
          <div class="hyve-dashboard-card__title" data-title>${escape(title)}</div>
          <div class="hyve-dashboard-card__state" data-state></div>
        </div>
      </div>
      ${showActions ? `
        <div class="hyve-dashboard-card__lock-actions">
          <button type="button" class="hyve-dashboard-card__lock-btn" data-lock-btn data-active="false"
            data-dash-action="lockAction" data-dash-stop-propagation="true" data-widget-id="${wid}" data-action="lock">
            <i class="fas fa-lock"></i> ${t('entity.lock')}
          </button>
          <button type="button" class="hyve-dashboard-card__lock-btn" data-unlock-btn data-active="false"
            data-dash-action="lockAction" data-dash-stop-propagation="true" data-widget-id="${wid}" data-action="unlock">
            <i class="fas fa-lock-open"></i> ${t('entity.unlock')}
          </button>
        </div>` : ''}
    `;
    this._iconEl = this.querySelector('[data-icon]');
    this._stateEl = this.querySelector('[data-state]');
    this._lockBtn = this.querySelector('[data-lock-btn]');
    this._unlockBtn = this.querySelector('[data-unlock-btn]');
  }

  _applyState() {
    if (!this._stateEl) return;
    const w = (this._config || {}) as CardWidget;
    const state = String(w.current_state == null ? 'unknown' : w.current_state).toLowerCase();
    const isLocked = state === 'locked' || state === 'lock';
    const isUnlocked = state === 'unlocked' || state === 'unlock' || state === 'open';
    if (this._iconEl) {
      const custom = typeof host.widgetIcon === 'function' ? host.widgetIcon(w) : String(w.icon || '').trim();
      if (custom) {
        this._iconEl.className = host.iconClass ? host.iconClass(custom) : custom;
      } else {
        this._iconEl.className = 'fas ' + (isLocked ? 'fa-lock' : 'fa-lock-open');
      }
    }
    this._stateEl.textContent = tState(state);
    if (this._lockBtn) this._lockBtn.setAttribute('data-active', isLocked ? 'true' : 'false');
    if (this._unlockBtn) this._unlockBtn.setAttribute('data-active', isUnlocked ? 'true' : 'false');

    const available = w.available !== false;
    const article = this.parentElement && this.parentElement.tagName === 'ARTICLE'
      ? this.parentElement : this.closest('article');
    if (article) {
      article.setAttribute('data-on', isLocked ? 'false' : 'true');
      article.setAttribute('data-unavailable', available ? 'false' : 'true');
    }
  }
}
