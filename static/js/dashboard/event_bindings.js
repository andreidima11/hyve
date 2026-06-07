/**
 * Dashboard UI event delegation — replaces inline onclick/onpointerdown in HTML/JS templates.
 */

/** @typedef {{
 *   event: Event,
 *   el: Element,
 *   widgetId: string,
 *   panelId: string,
 *   pageId: string,
 *   entityId: string,
 *   mode: string,
 *   delta: number,
 *   climateMode: string,
 *   slideIndex: number,
 *   action: string,
 *   field: string,
 * }} DashActionContext */

/** @type {Record<string, (ctx: DashActionContext) => void | Promise<void>> | null} */
let _handlers = null;
let _bound = false;

function _ctx(el, event) {
    const slideRaw = el.dataset.slideIndex;
    const deltaRaw = el.dataset.delta;
    return {
        event,
        el,
        widgetId: el.dataset.widgetId
            || el.closest('[data-dashboard-widget-id]')?.getAttribute('data-dashboard-widget-id')
            || '',
        panelId: el.dataset.panelId || '',
        pageId: el.dataset.pageId || '',
        entityId: el.dataset.entityId || '',
        mode: el.dataset.mode || '',
        delta: deltaRaw != null && deltaRaw !== '' ? Number(deltaRaw) : 0,
        climateMode: el.dataset.climateMode || '',
        slideIndex: slideRaw != null && slideRaw !== '' ? Number(slideRaw) : -1,
        action: el.dataset.action || '',
        field: el.dataset.field || '',
    };
}

function _run(action, el, event) {
    if (!_handlers) return;
    const fn = _handlers[action];
    if (typeof fn !== 'function') return;
    fn(_ctx(el, event));
}

function _onClick(event) {
    const el = event.target.closest('[data-dash-action]');
    if (!el) return;
    if (el.dataset.dashCloseMenu === 'true') {
        _run('closeMenu', el, event);
    }
    if (el.dataset.dashStopPropagation === 'true') {
        event.stopPropagation();
    }
    if (el.dataset.dashPreventDefault === 'true') {
        event.preventDefault();
    }
    _run(el.dataset.dashAction, el, event);
}

function _onKeydown(event) {
    const el = event.target.closest('[data-dash-action-key]');
    if (!el) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const article = el.closest('[data-dashboard-widget-id]');
    if (article && article.getAttribute('data-clickable') !== 'true') return;
    event.preventDefault();
    _run(el.dataset.dashActionKey, el, event);
}

function _onPointerDown(event) {
    const el = event.target.closest('[data-dash-pointer]');
    if (!el) return;
    _run(el.dataset.dashPointer, el, event);
}

function _onChange(event) {
    const el = event.target.closest('[data-dash-change]');
    if (!el) return;
    _run(el.dataset.dashChange, el, event);
}

function _onInput(event) {
    const el = event.target.closest('[data-dash-input]');
    if (!el) return;
    _run(el.dataset.dashInput, el, event);
}

/**
 * @param {Record<string, (ctx: DashActionContext) => void | Promise<void>>} handlers
 */
export function initDashboardEventBindings(handlers) {
    _handlers = handlers || {};
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
    document.addEventListener('keydown', _onKeydown, false);
    document.addEventListener('pointerdown', _onPointerDown, false);
    document.addEventListener('change', _onChange, false);
    document.addEventListener('input', _onInput, false);
}
