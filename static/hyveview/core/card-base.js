/**
 * HyveviewCardBase — base class that every Hyveview card extends.
 *
 * Lifecycle contract:
 *   1. The dashboard calls `setConfig(config)` once with the card's saved
 *      config object. Cards should validate, store, and render their static
 *      structure here. May throw to signal an invalid config.
 *   2. The dashboard subscribes to entity state changes for `config.entity`
 *      (when defined) and forwards them via `setState(state)`. Cards should
 *      treat this as a hot path and only update what changed.
 *   3. Subclasses can declare:
 *        - static schema  → editor builds a form from this. See core/schema.js.
 *        - static meta    → { name, description, icon } for the card picker.
 *        - static getStubConfig(entityId) → returns a default config when the
 *          user picks this card type in the editor.
 *
 * Cards never poll on their own; they always read state from the store via
 * the dashboard's subscription. Cards that need extra data (e.g. an MJPEG
 * snapshot) should fetch it lazily and respect visibility (see camera card).
 */

export class HyveviewCardBase extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._state = null;
    this._root = null;
  }

  /**
   * Default: subclasses override this. Must be idempotent — the editor may
   * call it again after a config edit.
   */
  setConfig(config) {
    this._config = config || {};
    this._render();
  }

  setState(state) {
    this._state = state;
    this._onState(state);
  }

  /** Override in subclasses to react to state changes without a full re-render. */
  _onState(_state) { /* no-op */ }

  /** Override to build the static DOM once. */
  _render() { /* no-op */ }

  get config() { return this._config; }
  get state() { return this._state; }

  /**
   * Shared helper for cards that want the standard card frame.
   */
  buildFrame({ title = '', icon = '' } = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = 'hv-card';
    const header = document.createElement('div');
    header.className = 'hv-card-header';
    if (icon) {
      const i = document.createElement('span');
      i.className = 'hv-card-icon';
      i.textContent = icon;
      header.appendChild(i);
    }
    const t = document.createElement('div');
    t.className = 'hv-card-title';
    t.textContent = title;
    header.appendChild(t);
    const body = document.createElement('div');
    body.className = 'hv-card-body';
    wrapper.appendChild(header);
    wrapper.appendChild(body);
    this.replaceChildren(wrapper);
    return { wrapper, header, body };
  }
}
