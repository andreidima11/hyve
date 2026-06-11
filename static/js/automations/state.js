export const automationState = {
    editorRevision: null,
    editorId: null,
    editorMode: 'builder',
    builderTriggers: [],
    builderConditions: [],
    builderActions: [],
    capabilities: null,
    capabilitiesPromise: null,
    idManuallyEdited: false,
    historyItems: [],
    historyPage: 1,
};
export const AUTO_HISTORY_PAGE_SIZE = 10;
export function automationIdString(id) {
    if (typeof id !== 'string')
        return null;
    const s = id.trim();
    return s || null;
}
export function editorAutomationId() {
    return automationIdString(automationState.editorId);
}
