/**
 * Skills view event delegation.
 */

/** @type {Record<string, (...args: unknown[]) => unknown> | null} */
let _handlers = null;
let _bound = false;

function _run(action, el, event) {
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

function _onClick(event) {
    const el = event.target.closest('[data-skills-action]');
    if (!el) return;
    _run(el.dataset.skillsAction, el, event);
}

/**
 * @param {Record<string, (...args: unknown[]) => unknown>} handlers
 */
export function initSkillsEventBindings(handlers) {
    _handlers = handlers || {};
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
}
