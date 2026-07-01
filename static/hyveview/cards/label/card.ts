/**
 * <hv-card-label> — first migrated card.
 *
 * The label card is stateless (no entity binding, no clicks) and the
 * simplest possible proof of the bridge architecture. It owns its inner
 * markup; the dashboard owns the outer `<article>` shell, drag/edit
 * attrs, and size class.
 *
 * Visual parity check against the legacy `_renderLabelCard`:
 *   - .hyve-dashboard-label__title with widget.title or fallback 'Titlu'
 *   - optional .hyve-dashboard-label__sub with widget.entity_name
 *   - .hyve-dashboard-label--accent vs --bare on the OUTER article
 *     (handled by the bridge outer renderer, not here)
 */
import { HyveviewCardBase } from '../../core/card-base.js';
import type { CardWidget, HyveviewEntityState } from '../../types/card-widget.js';

function _escape(s: unknown) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export class HyveviewLabelCard extends HyveviewCardBase {
  static meta = {
    name: 'Label',
    description: 'Static title/text without entity binding.',
    icon: '🏷️',
  };
  static schema = {
    fields: [
      { key: 'title', label: 'Title', type: 'string', placeholder: 'Living room' },
      { key: 'entity_name', label: 'Subtitle / text', type: 'string', placeholder: 'Optional secondary line' },
      { key: 'show_background', label: 'Show background accent', type: 'boolean', default: false },
    ],
  };
  static getStubConfig(_entityId?: string) {
    return { title: '', entity_name: '', show_background: false };
  }

  setConfig(widget: CardWidget | null | undefined) {
    this._config = widget || {};
    this._render();
  }

  setState(_state: HyveviewEntityState | null) { /* label has no entity state */ }

  _render() {
    const w = (this._config || {}) as CardWidget;
    const titleText = Object.prototype.hasOwnProperty.call(w, 'title') ? String(w.title ?? '') : 'Titlu';
    const title = _escape(titleText);
    const subtitleText = String(w.entity_name ?? '').trim();
    // Legacy saves copied title into entity_name when secondary text was left blank.
    const sub = subtitleText && subtitleText !== titleText.trim()
      ? `<div class="hyve-dashboard-label__sub">${_escape(subtitleText)}</div>`
      : '';
    this.innerHTML = `
      <div class="hyve-dashboard-label__title">${title}</div>
      ${sub}
    `;
  }
}
