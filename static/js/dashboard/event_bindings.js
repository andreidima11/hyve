/**
 * Dashboard UI event delegation — replaces inline onclick/onpointerdown in HTML/JS templates.
 */
let _handlers = null;
let _bound = false;
function _ctx(el, event) {
    const slideRaw = el.dataset.slideIndex;
    const deltaRaw = el.dataset.delta;
    const widgetHost = el.closest('[data-dashboard-widget-id]');
    return {
        event,
        el,
        widgetId: el.dataset.widgetId
            || widgetHost?.getAttribute('data-dashboard-widget-id')
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
    if (!_handlers)
        return;
    const fn = _handlers[action];
    if (typeof fn !== 'function')
        return;
    void fn(_ctx(el, event));
}
function _onClick(event) {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const el = target.closest('[data-dash-action]');
    if (!(el instanceof HTMLElement))
        return;
    if (el.dataset.dashCloseMenu === 'true') {
        _run('closeMenu', el, event);
    }
    if (el.dataset.dashStopPropagation === 'true') {
        event.stopPropagation();
    }
    if (el.dataset.dashPreventDefault === 'true') {
        event.preventDefault();
    }
    _run(el.dataset.dashAction || '', el, event);
}
function _onKeydown(event) {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const el = target.closest('[data-dash-action-key]');
    if (!(el instanceof HTMLElement))
        return;
    if (event.key !== 'Enter' && event.key !== ' ')
        return;
    const article = el.closest('[data-dashboard-widget-id]');
    if (article && article.getAttribute('data-clickable') !== 'true')
        return;
    event.preventDefault();
    _run(el.dataset.dashActionKey || '', el, event);
}
function _onPointerDown(event) {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const el = target.closest('[data-dash-pointer]');
    if (!(el instanceof HTMLElement))
        return;
    _run(el.dataset.dashPointer || '', el, event);
}
function _onChange(event) {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const el = target.closest('[data-dash-change]');
    if (!(el instanceof HTMLElement))
        return;
    _run(el.dataset.dashChange || '', el, event);
}
function _onInput(event) {
    const target = event.target;
    if (!(target instanceof Element))
        return;
    const el = target.closest('[data-dash-input]');
    if (!(el instanceof HTMLElement))
        return;
    _run(el.dataset.dashInput || '', el, event);
}
export function initDashboardEventBindings(handlers = {}) {
    _handlers = handlers;
    if (_bound)
        return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
    document.addEventListener('keydown', _onKeydown, false);
    document.addEventListener('pointerdown', _onPointerDown, false);
    document.addEventListener('change', _onChange, false);
    document.addEventListener('input', _onInput, false);
}
