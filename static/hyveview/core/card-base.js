/**
 * HyveviewCardBase — base class that every Hyveview card extends.
 */
export class HyveviewCardBase extends HTMLElement {
    constructor() {
        super(...arguments);
        this._config = null;
        this._state = null;
        this._root = null;
    }
    setConfig(config) {
        this._config = config || {};
        this._render();
    }
    setState(state) {
        this._state = state;
        this._onState(state);
    }
    _onState(_state) { }
    _render() { }
    get config() { return this._config; }
    get state() { return this._state; }
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
