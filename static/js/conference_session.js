import {
    DEFAULT_CONFERENCE_MODES,
    loadLobbyStateFromStorage,
    loadLobbyPrefsFromServer,
    fetchConferencePersonas,
    fetchConferenceModelProfiles,
    fetchConferenceList,
    fetchPersonaMemoryCounts,
    fetchConferenceModes,
    fetchConferenceById,
    removeConference,
} from './conference_data.js';

export async function restoreConferenceLobbyState(storageKey) {
    try {
        const state = await loadLobbyPrefsFromServer();
        if (state) {
            return {
                selectedPersonas: Array.isArray(state.selected_personas) ? state.selected_personas : [],
                selectedMode: state.selected_mode || 'brainstorm',
                personaOverrides: state.persona_overrides && typeof state.persona_overrides === 'object' ? state.persona_overrides : {},
                artifactEnabled: false,
                expertMemoryEnabled: state.expert_memory_enabled !== undefined ? state.expert_memory_enabled : true,
                loadedFromServer: true,
            };
        }
    } catch (e) {
        // fall back to local storage
    }

    const localState = loadLobbyStateFromStorage(storageKey) || {};
    return {
        selectedPersonas: Array.isArray(localState.selectedPersonas) ? localState.selectedPersonas : [],
        selectedMode: localState.selectedMode || 'brainstorm',
        personaOverrides: localState.personaOverrides && typeof localState.personaOverrides === 'object' ? localState.personaOverrides : {},
        artifactEnabled: localState.artifactEnabled !== undefined ? localState.artifactEnabled : false,
        expertMemoryEnabled: localState.expertMemoryEnabled !== undefined ? localState.expertMemoryEnabled : true,
        loadedFromServer: false,
    };
}

export async function loadConferenceBootstrapData() {
    const [
        personasResult,
        conferencesResult,
        modelProfilesResult,
        memoryCountsResult,
        modesResult,
    ] = await Promise.allSettled([
        fetchConferencePersonas(),
        fetchConferenceList(),
        fetchConferenceModelProfiles(),
        fetchPersonaMemoryCounts(),
        fetchConferenceModes(),
    ]);

    return {
        personas: personasResult.status === 'fulfilled' ? personasResult.value : null,
        conferences: conferencesResult.status === 'fulfilled' ? conferencesResult.value : [],
        modelProfiles: modelProfilesResult.status === 'fulfilled' ? modelProfilesResult.value : [],
        personaMemoryCounts: memoryCountsResult.status === 'fulfilled' ? memoryCountsResult.value : {},
        availableModes: modesResult.status === 'fulfilled' ? modesResult.value : DEFAULT_CONFERENCE_MODES,
    };
}

export function normalizeConferenceLobbyState({
    personas,
    selectedPersonas,
    personaOverrides,
    availableModes,
    selectedMode,
}) {
    const nextSelected = new Set(selectedPersonas || []);
    const nextOverrides = { ...(personaOverrides || {}) };

    if (personas) {
        for (const pid of [...nextSelected]) {
            if (!personas[pid]) {
                nextSelected.delete(pid);
                delete nextOverrides[pid];
            }
        }
    }

    let nextMode = selectedMode || 'brainstorm';
    if (availableModes.length && !availableModes.find(m => m.id === nextMode)) {
        nextMode = availableModes[0].id;
    }

    return {
        selectedPersonas: nextSelected,
        personaOverrides: nextOverrides,
        selectedMode: nextMode,
    };
}

export async function loadConferenceOrNull(confId, onError = console.error) {
    try {
        return await fetchConferenceById(confId);
    } catch (e) {
        onError('Conference: load failed', e);
        return null;
    }
}

export async function deleteConferenceAndComputeState({
    confId,
    conferences,
    activeConf,
    conferencePage,
    conferencesPerPage,
}) {
    const resp = await removeConference(confId);
    if (!resp.ok) {
        return { ok: false };
    }

    const nextConferences = conferences.filter(c => c.id !== confId);
    const totalPages = Math.max(1, Math.ceil(nextConferences.length / conferencesPerPage));
    return {
        ok: true,
        conferences: nextConferences,
        activeConf: activeConf && activeConf.id === confId ? null : activeConf,
        conferencePage: Math.min(conferencePage, totalPages),
    };
}
