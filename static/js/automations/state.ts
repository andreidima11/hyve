import type {
    AutomationBuilderRow,
    AutomationCapabilities,
    AutomationEditorMode,
    AutomationHistoryItem,
} from '../types/features_automations.js';

export const automationState = {
    editorRevision: null as string | null,
    editorId: null as string | null,
    editorMode: 'builder' as AutomationEditorMode,
    builderTriggers: [] as AutomationBuilderRow[],
    builderConditions: [] as AutomationBuilderRow[],
    builderActions: [] as AutomationBuilderRow[],
    capabilities: null as AutomationCapabilities | null,
    capabilitiesPromise: null as Promise<AutomationCapabilities | null> | null,
    idManuallyEdited: false,
    historyItems: [] as AutomationHistoryItem[],
    historyPage: 1,
};

export const AUTO_HISTORY_PAGE_SIZE = 10;

export function automationIdString(id: unknown): string | null {
    if (typeof id !== 'string') return null;
    const s = id.trim();
    return s || null;
}

export function editorAutomationId(): string | null {
    return automationIdString(automationState.editorId);
}
