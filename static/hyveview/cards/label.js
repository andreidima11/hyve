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
import { HyveviewCardBase } from '../core/card-base.js';

function _escape(s) {
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
  static getStubConfig() {
    return { title: '', entity_name: '', show_background: false };
  }

  setConfig(widget) {
    this._config = widget || {};
    this._render();
  }

  setState(_state) { /* label has no entity state */ }

  _render() {
    const w = this._config || {};
    const title = _escape(Object.prototype.hasOwnProperty.call(w, 'title') ? String(w.title ?? '') : 'Titlu');
    const sub = w.entity_name ? `<div class="hyve-dashboard-label__sub">${_escape(w.entity_name)}</div>` : '';
    this.innerHTML = `
      <div class="hyve-dashboard-label__title">${title}</div>
      ${sub}
    `;
  }
}
