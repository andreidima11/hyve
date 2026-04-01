export function createConferenceLobbyStateSaver({
    storageKey,
    debounce,
    saveLobbyStateToStorage,
    saveLobbyPrefsToServer,
    getSnapshot,
}) {
    const serverSave = debounce(async () => {
        const snapshot = getSnapshot();
        try {
            await saveLobbyPrefsToServer({
                selected_personas: snapshot.selectedPersonas,
                selected_mode: snapshot.selectedMode,
                persona_overrides: snapshot.personaOverrides,
                expert_memory_enabled: snapshot.expertMemoryEnabled,
            });
        } catch (e) {
            // best-effort, don't block UI
        }
    }, 600);

    return function saveLobbyState() {
        const snapshot = getSnapshot();
        saveLobbyStateToStorage(storageKey, snapshot);
        serverSave();
    };
}
