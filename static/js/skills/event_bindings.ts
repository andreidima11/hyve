/**
 * Skills view event delegation.
 */

import type { DelegatedEventHandlers } from '../types/integration.js';

let _handlers: DelegatedEventHandlers | null = null;
let _bound = false;

function _run(action: string, el: HTMLElement, event: Event): void {
    if (!_handlers) return;
    if (action === 'toggleDesc') {
        _handlers.toggleDesc?.(el.dataset.skillName || '', event, el);
        return;
    }
    if (action === 'toggleDisabled') {
        _handlers.toggleDisabled?.(el.dataset.skillName || '', event, el);
        return;
    }
    if (action === 'openEdit') {
        _handlers.openEdit?.(el.dataset.skillName || '', event, el);
        return;
    }
    if (action === 'deleteSkill') {
        _handlers.deleteSkill?.(el.dataset.skillName || '', event, el);
        return;
    }
    const fn = _handlers[action];
    if (typeof fn === 'function') fn(event, el);
}

function _onClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const el = target.closest('[data-skills-action]');
    if (!(el instanceof HTMLElement)) return;
    _run(el.dataset.skillsAction || '', el, event);
}

export function initSkillsEventBindings(handlers: DelegatedEventHandlers = {}): void {
    _handlers = handlers;
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
}
