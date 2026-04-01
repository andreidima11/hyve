/**
 * Event delegation: maps data-action attributes to handler functions.
 * Usage: <button data-action="deleteReminder" data-job-id="123">Delete</button>
 * Register: registerAction('deleteReminder', (el) => { ... })
 *
 * This approach eliminates inline onclick handlers and window.* globals.
 * Migrate features.js handlers here incrementally.
 */

const _handlers = {};

export function registerAction(name, fn) {
    _handlers[name] = fn;
}

export function initActionDelegation(root = document) {
    root.addEventListener('click', (e) => {
        const el = e.target.closest('[data-action]');
        if (!el) return;
        const action = el.dataset.action;
        const handler = _handlers[action];
        if (handler) {
            e.preventDefault();
            e.stopPropagation();
            handler(el, e);
        }
    });
}
