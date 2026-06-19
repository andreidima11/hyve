/**
 * <hv-card-select> — controllable select entity with option dropdown.
 */
import { HyveviewCardBase } from '../../core/card-base.js';
import { host, widgetTitle } from '../../host.js';
import { selectOptionsFromEntity } from '../../../js/entity_constants.js';
import type { CardWidget, HyveviewEntityState } from '../../types/card-widget.js';

export class HyveviewSelectCard extends HyveviewCardBase {
  protected _selectEl: HTMLSelectElement | null = null;
  protected _titleEl: HTMLElement | null = null;

  static meta = {
    name: 'Select',
    description: 'Selector entity with dropdown options.',
    icon: '📋',
  };
  static schema = {
    fields: [
      { key: 'entity_id', label: 'Select entity', type: 'entity', domains: ['select'], required: true },
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Auto from entity if blank' },
      { key: 'icon', label: 'Icon', type: 'icon', placeholder: 'fas fa-list' },
    ],
  };
  static getStubConfig(entityId?: string) {
    return { entity_id: entityId || '', title: '', icon: 'fas fa-list' };
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

  _options(widget: CardWidget) {
    const attrs = (widget.attributes && typeof widget.attributes === 'object'
      ? widget.attributes : {}) as Record<string, unknown>;
    const caps = (attrs.capabilities && typeof attrs.capabilities === 'object'
      ? attrs.capabilities : {}) as Record<string, unknown>;
    return selectOptionsFromEntity(attrs, caps);
  }

  _render() {
    const w = (this._config || {}) as CardWidget;
    const escape = host.escape;
    const editMode = !!w._edit_mode;
    const title = widgetTitle(w);
    const wid = escape(w.id || '');
    const showSelect = !editMode && w.available !== false;
    const current = String(w.current_state ?? '').toLowerCase();
    const options = this._options(w);

    const optionsHtml = options.map((opt) => {
      const value = String(opt?.value ?? opt?.label ?? '');
      const label = String(opt?.label ?? opt?.value ?? '');
      const selected = value.toLowerCase() === current || label.toLowerCase() === current;
      return `<option value="${escape(value)}"${selected ? ' selected' : ''}>${escape(label)}</option>`;
    }).join('');

    this.innerHTML = `
      <div class="hyve-dashboard-card__row">
        <span class="hyve-dashboard-card__icon"><i data-icon class="fas fa-list"></i></span>
        <div class="hyve-dashboard-card__body">
          <div class="hyve-dashboard-card__title" data-title>${escape(title)}</div>
        </div>
      </div>
      ${showSelect ? `
        <select class="hyve-dashboard-card__select-native"
          data-select
          data-dash-change="selectChange"
          data-dash-stop-propagation="true"
          data-widget-id="${wid}"
          aria-label="${escape(title)}"
          ${options.length ? '' : 'disabled'}>
          ${optionsHtml || '<option value="">—</option>'}
        </select>` : ''}
    `;
    this._titleEl = this.querySelector('[data-title]');
    this._selectEl = this.querySelector('[data-select]');
    const iconSpec = (typeof host.widgetIcon === 'function' ? host.widgetIcon(w) : w.icon) || 'fas fa-list';
    const iconEl = this.querySelector('[data-icon]');
    if (iconEl) iconEl.className = host.iconClass ? host.iconClass(iconSpec) : String(iconSpec);
  }

  _applyState() {
    const w = (this._config || {}) as CardWidget;
    const current = String(w.current_state ?? '');
    if (this._selectEl) {
      const lower = current.toLowerCase();
      const match = Array.from(this._selectEl.options).find((opt) => (
        opt.value.toLowerCase() === lower || opt.textContent?.trim().toLowerCase() === lower
      ));
      if (match) this._selectEl.value = match.value;
      this._selectEl.disabled = w.available === false || !this._options(w).length;
    }

    const article = this.parentElement?.tagName === 'ARTICLE'
      ? this.parentElement : this.closest('article');
    if (article) {
      article.setAttribute('data-unavailable', w.available === false ? 'true' : 'false');
      article.setAttribute('data-on', 'true');
    }
  }
}
