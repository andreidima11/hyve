/**
 * Event delegation: maps data-action attributes to handler functions.
 * Usage: <button data-action="deleteReminder" data-job-id="123">Delete</button>
 * Register: registerAction('deleteReminder', (el) => { ... })
 */
const _handlers = {};
export function registerAction(name, fn) {
    _handlers[name] = fn;
}
export function initActionDelegation(root = document) {
    root.addEventListener('click', (e) => {
        const target = e.target;
        if (!(target instanceof Element))
            return;
        const el = target.closest('[data-action]');
        if (!(el instanceof HTMLElement))
            return;
        const action = el.dataset.action;
        const handler = action ? _handlers[action] : undefined;
        if (handler) {
            e.preventDefault();
            e.stopPropagation();
            handler(el, e);
        }
    });
}
