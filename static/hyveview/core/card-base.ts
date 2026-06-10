/**
 * HyveviewCardBase — base class that every Hyveview card extends.
 */

import type { HyveviewEntityState } from '../types/card.js';

export class HyveviewCardBase extends HTMLElement {
    protected _config: Record<string, unknown> | null = null;
    protected _state: HyveviewEntityState | null = null;
    protected _root: HTMLElement | null = null;

    setConfig(config: Record<string, unknown> | null | undefined): void {
        this._config = config || {};
        this._render();
    }

    setState(state: HyveviewEntityState | null): void {
        this._state = state;
        this._onState(state);
    }

    protected _onState(_state: HyveviewEntityState | null): void { /* no-op */ }

    protected _render(): void { /* no-op */ }

    get config(): Record<string, unknown> | null { return this._config; }
    get state(): HyveviewEntityState | null { return this._state; }

    buildFrame({ title = '', icon = '' }: { title?: string; icon?: string } = {}): {
        wrapper: HTMLDivElement;
        header: HTMLDivElement;
        body: HTMLDivElement;
    } {
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
