/**
 * Intelligence / memory / automations view event delegation.
 */

/** @type {Record<string, (...args: unknown[]) => unknown> | null} */
let _handlers = null;
let _bound = false;

function _inMemoryScope(el) {
    if (!el) return false;
    // Panels may live under #view-memory or be moved into config standalone (Automatizări / Memorii hub).
    // Kebab menus are portaled to document.body (see toggleAutoMenu).
    return !!(
        el.closest('#view-memory')
        || el.closest('#intelligence-panel-automations')
        || el.closest('#intelligence-panel-memories')
        || el.closest('#automation-editor-modal')
        || el.closest('#auto-menu-portal')
    );
}

function _syncAutomationOpts(el) {
    const rerender = el.dataset.memoryRerender || '';
    if (rerender === 'triggers') return { rerenderTriggers: true };
    if (rerender === 'conditions') return { rerenderConditions: true };
    if (rerender === 'actions') return { rerenderActions: true };
    return {};
}

function _run(action, el, event) {
    if (!_handlers || !_inMemoryScope(el)) return;

    switch (action) {
    case 'switchIntelligenceTab':
        _handlers.switchIntelligenceTab?.(el.dataset.memoryTab || '', event, el);
        return;
    case 'switchMemorySubtab':
        _handlers.switchMemorySubtab?.(el.dataset.memorySubtab || '', event, el);
        return;
    case 'changeMemPage':
        _handlers.changeMemPage?.(Number(el.dataset.memoryDelta || 0), event, el);
        return;
    case 'switchAutomationEditorMode':
        _handlers.switchAutomationEditorMode?.(el.dataset.memoryMode || '', event, el);
        return;
    case 'addAutomationBuilderTrigger':
        _handlers.addAutomationBuilderTrigger?.(el.dataset.memoryKind || '', event, el);
        return;
    case 'addAutomationBuilderCondition':
        _handlers.addAutomationBuilderCondition?.(el.dataset.memoryKind || '', event, el);
        return;
    case 'addAutomationBuilderAction':
        _handlers.addAutomationBuilderAction?.(el.dataset.memoryKind || '', event, el);
        return;
    case 'removeAutomationBuilderTrigger':
        _handlers.removeAutomationBuilderTrigger?.(Number(el.dataset.memoryIndex ?? -1), event, el);
        return;
    case 'removeAutomationBuilderCondition':
        _handlers.removeAutomationBuilderCondition?.(Number(el.dataset.memoryIndex ?? -1), event, el);
        return;
    case 'removeAutomationBuilderAction':
        _handlers.removeAutomationBuilderAction?.(Number(el.dataset.memoryIndex ?? -1), event, el);
        return;
    case 'removeBlueprintCreatorInput':
        _handlers.removeBlueprintCreatorInput?.(Number(el.dataset.memoryIndex ?? -1), event, el);
        return;
    case 'insertBlueprintCreatorPlaceholder':
        _handlers.insertBlueprintCreatorPlaceholder?.(el.dataset.memoryInputId || '', el.dataset.memorySlugify === 'true', event, el);
        return;
    case 'toggleMemLogDetails':
        _handlers.toggleMemLogDetails?.(el.dataset.memoryDetailsId || '', event, el);
        return;
    case 'removeExtractionExample':
        _handlers.removeExtractionExample?.(Number(el.dataset.memoryIndex ?? -1), event, el);
        return;
    case 'deleteMemRow':
        _handlers.deleteMemBulk?.([el.dataset.memoryMemId || ''], event, el);
        return;
    case 'toggleAutoMenu':
        _handlers.toggleAutoMenu?.(event, el.dataset.memoryDefId || '', el);
        return;
    case 'showAutoDotTooltip':
        _handlers.showAutoDotTooltip?.(event, el);
        return;
    case 'runAutomationDefinition':
        _handlers.runAutomationDefinition?.(el.dataset.memoryDefId || '', event, el);
        if (el.dataset.memoryCloseMenu === 'true') _handlers.closeAutoMenu?.(event, el);
        return;
    case 'openAutomationEditorFromList':
        _handlers.openAutomationEditor?.(el.dataset.memoryDefId || undefined, event, el);
        if (el.dataset.memoryCloseMenu === 'true') _handlers.closeAutoMenu?.(event, el);
        return;
    case 'toggleAutomationDefinition':
        _handlers.toggleAutomationDefinition?.(
            el.dataset.memoryDefId || '',
            el.dataset.memoryEnabled === 'true',
            Number(el.dataset.memoryRevision || 1),
            event,
            el,
        );
        if (el.dataset.memoryCloseMenu === 'true') _handlers.closeAutoMenu?.(event, el);
        return;
    case 'deleteAutomation':
        _handlers.deleteAutomation?.(el.dataset.memoryDefId || '', event, el);
        if (el.dataset.memoryCloseMenu === 'true') _handlers.closeAutoMenu?.(event, el);
        return;
    case 'closeAutoMenu':
        _handlers.closeAutoMenu?.(event, el);
        return;
    case 'loadMemoryEvents':
        _handlers.loadMemoryEvents?.(Number(el.dataset.memoryOffset ?? 0), event, el);
        return;
    case 'openAutomationEditor':
        _handlers.openAutomationEditor?.(undefined, event, el);
        return;
    default: {
        const fn = _handlers[action];
        if (typeof fn === 'function') fn(event, el);
    }
    }
}

function _onClick(event) {
    const el = event.target.closest('[data-memory-action]');
    if (!el) return;
    _run(el.dataset.memoryAction, el, event);
}

function _onInput(event) {
    const el = event.target.closest('[data-memory-input]');
    if (!el || !_inMemoryScope(el)) return;
    const kind = el.dataset.memoryInput;
    if (!kind || !_handlers) return;
    if (kind === 'filterMemory') _handlers.filterMemory?.(event, el);
    else if (kind === 'autoSyncAutomationId') {
        _handlers.autoSyncAutomationId?.(event, el);
        _handlers.syncAutomationYamlFromBuilder?.(_syncAutomationOpts(el), event, el);
    } else if (kind === 'markAutomationIdManual') {
        _handlers.markAutomationIdManual?.(event, el);
        _handlers.syncAutomationYamlFromBuilder?.(_syncAutomationOpts(el), event, el);
    } else if (kind === 'syncAutomationYamlFromBuilder') {
        _handlers.syncAutomationYamlFromBuilder?.(_syncAutomationOpts(el), event, el);
    } else if (kind === 'updateAutomationServiceData') {
        _handlers.updateAutomationStructuredServiceData?.(Number(el.dataset.memoryIndex ?? el.dataset.actionIndex ?? -1), event, el);
    } else if (kind === 'updateBlueprintCreatorYaml') _handlers.updateBlueprintCreatorYaml?.(event, el);
}

function _onChange(event) {
    const el = event.target.closest('[data-memory-input]');
    if (!el || !_inMemoryScope(el)) return;
    const kind = el.dataset.memoryInput;
    if (!kind || !_handlers) return;
    if (kind === 'toggleAllMem') _handlers.toggleAllMem?.(el.checked, event, el);
    else if (kind === 'syncAutomationYamlFromBuilder') {
        _handlers.syncAutomationYamlFromBuilder?.(_syncAutomationOpts(el), event, el);
    } else if (kind === 'changeBlueprintCreatorInputType') {
        _handlers.changeBlueprintCreatorInputType?.(Number(el.dataset.memoryIndex ?? -1), el.value, event, el);
    } else if (kind === 'updateBlueprintCreatorYaml') _handlers.updateBlueprintCreatorYaml?.(event, el);
    else if (kind === 'updateMemBulkCount') _handlers.updateMemBulkCount?.(event, el);
}

function _onMouseEnter(event) {
    const el = event.target.closest('[data-memory-hover="showAutoDotTooltip"]');
    if (!el || !_inMemoryScope(el)) return;
    _handlers?.showAutoDotTooltip?.(event, el);
}

function _onMouseLeave(event) {
    const el = event.target.closest('[data-memory-hover="showAutoDotTooltip"]');
    if (!el || !_inMemoryScope(el)) return;
    if (event.relatedTarget && el.contains(event.relatedTarget)) return;
    _handlers?.hideAutoDotTooltip?.(event, el);
}

/**
 * @param {Record<string, (...args: unknown[]) => unknown>} handlers
 */
export function initMemoryEventBindings(handlers) {
    _handlers = handlers || {};
    if (_bound) return;
    _bound = true;
    document.addEventListener('click', _onClick, false);
    document.addEventListener('input', _onInput, false);
    document.addEventListener('change', _onChange, false);
    document.addEventListener('mouseover', _onMouseEnter, false);
    document.addEventListener('mouseout', _onMouseLeave, false);
}
