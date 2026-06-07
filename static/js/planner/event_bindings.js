/**
 * Planner UI event delegation — static shell + dynamically rendered lists/calendar.
 */

/** @type {Record<string, (...args: unknown[]) => unknown> | null} */
let _handlers = null;
let _bound = false;

function _listId(el) {
    return Number(el.dataset.plannerListId || el.closest('[data-planner-list-id]')?.dataset.plannerListId || 0);
}

function _entryId(el) {
    return Number(el.dataset.plannerEntryId || el.closest('[data-planner-entry-id]')?.dataset.plannerEntryId || 0);
}

function _run(action, el, event) {
    if (!_handlers || !el?.closest('#view-planner')) return;
    if (el.dataset.plannerStopPropagation === 'true') event.stopPropagation();

    if (action === 'setTab') {
        const tab = el.dataset.plannerTab || el.getAttribute('data-tab') || '';
        _handlers.setTab?.(tab, event, el);
        return;
    }
    if (action === 'setFilter') {
        const filter = el.dataset.plannerFilter || el.getAttribute('data-filter') || '';
        _handlers.setFilter?.(filter, event, el);
        return;
    }

    switch (action) {
    case 'selectList':
        _handlers.selectList?.(_listId(el), event, el);
        if (el.dataset.plannerCloseDrawer === 'true') _handlers.closeDrawer?.(event, el);
        return;
    case 'requestDeleteList':
        _handlers.requestDeleteList?.(_listId(el), event, el);
        return;
    case 'deleteList':
        _handlers.deleteList?.(_listId(el), event, el);
        return;
    case 'cancelDeleteList':
        _handlers.cancelDeleteList?.(_listId(el), event, el);
        return;
    case 'toggleDone':
        _handlers.toggleDone?.(_entryId(el), event, el);
        return;
    case 'entryActions':
        _handlers.entryActions?.(_entryId(el), event, el);
        return;
    case 'calPrev':
        _handlers.calPrev?.(event, el);
        return;
    case 'calNext':
        _handlers.calNext?.(event, el);
        return;
    case 'calToday':
        _handlers.calToday?.(event, el);
        return;
    case 'setCalView':
        _handlers.setCalView?.(el.dataset.plannerCalView || '', event, el);
        return;
    case 'calClickDay':
        _handlers.calClickDay?.(el.dataset.plannerCalDay || '', event, el);
        return;
    case 'calClickHour':
        _handlers.calClickHour?.(el.dataset.plannerCalDay || '', Number(el.dataset.plannerCalHour ?? 0), event, el);
        return;
    default: {
        const fn = _handlers[action];
        if (typeof fn === 'function') fn(event, el);
    }
    }
}

function _onClick(event) {
    const el = event.target.closest('[data-planner-action]');
    if (!el) return;
    _run(el.dataset.plannerAction, el, event);
}

function _onKeydown(event) {
    if (event.key !== 'Enter') return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || !target.closest('#view-planner')) return;
    if (target.id === 'planner-new-list-input') {
        event.preventDefault();
        _handlers?.createList?.(event, target);
        return;
    }
    if (target.id === 'planner-add-title') {
        event.preventDefault();
        _handlers?.createEntry?.(event, target);
    }
}

function _onDragStart(event) {
    const el = event.target.closest('[data-planner-drag-start]');
    if (!el?.closest('#view-planner')) return;
    const kind = el.dataset.plannerDragStart;
    const id = _entryId(el);
    if (kind === 'task') _handlers?.taskDragStart?.(event, id, el);
    else if (kind === 'event') _handlers?.eventDragStart?.(event, id, el);
}

function _onDragOver(event) {
    const el = event.target.closest('[data-planner-drag-over]');
    if (!el?.closest('#view-planner')) return;
    const kind = el.dataset.plannerDragOver;
    if (kind === 'task') _handlers?.taskDragOver?.(event, el);
    else if (kind === 'event') _handlers?.eventDragOver?.(event, el);
}

function _onDrop(event) {
    const el = event.target.closest('[data-planner-drop]');
    if (!el?.closest('#view-planner')) return;
    const kind = el.dataset.plannerDrop;
    if (kind === 'task') {
        event.preventDefault();
        _handlers?.taskDrop?.(event, _entryId(el), el);
        return;
    }
    if (kind === 'eventDay') {
        _handlers?.eventDropDay?.(event, el.dataset.plannerCalDay || '', el);
        return;
    }
    if (kind === 'eventHour') {
        _handlers?.eventDropHour?.(
            event,
            el.dataset.plannerCalDay || '',
            Number(el.dataset.plannerCalHour ?? 0),
            el,
        );
    }
}

function _onDragEnd(event) {
    const el = event.target.closest('[data-planner-drag-start]');
    if (!el?.closest('#view-planner')) return;
    const kind = el.dataset.plannerDragStart;
    const id = _entryId(el);
    if (kind === 'task') _handlers?.taskDragEnd?.(event, id, el);
    else if (kind === 'event') _handlers?.eventDragEnd?.(event, id, el);
}

/**
 * @param {Record<string, (...args: unknown[]) => unknown>} handlers
 */
export function initPlannerEventBindings(handlers) {
    _handlers = handlers || {};
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
    document.addEventListener('keydown', _onKeydown, false);
    document.addEventListener('dragstart', _onDragStart, false);
    document.addEventListener('dragover', _onDragOver, false);
    document.addEventListener('drop', _onDrop, false);
    document.addEventListener('dragend', _onDragEnd, false);
}
