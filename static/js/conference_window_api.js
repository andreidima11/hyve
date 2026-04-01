export function bindConferenceWindowAPI({
    togglePersona,
    setMode,
    createConference,
    openPersonaModal,
    closePersonaModal,
    savePersonaSettings,
    resetPromptToDefault,
    openConference,
    deleteConference,
    sendConference,
    stopConferenceStream,
    goBack,
    forkConference,
    editConferenceMeta,
    toggleArtifactPanel,
    toggleArtifactLobby,
    toggleMemoryLobby,
    clearPersonaMemories,
    setConferencePage,
    viewPersonaMemories,
    closeMemoryViewer,
    deleteSingleMemory,
    sendConferenceMessage,
}) {
    window._confTogglePersona = togglePersona;
    window._confSetMode = setMode;
    window._confCreate = createConference;
    window._confEditPersona = openPersonaModal;
    window._confCloseModal = closePersonaModal;
    window._confSavePersona = savePersonaSettings;
    window._confResetPrompt = resetPromptToDefault;
    window._confOpen = openConference;
    window._confDelete = deleteConference;
    window._confSend = sendConference;
    window._confStop = stopConferenceStream;
    window._confBack = goBack;
    window._confFork = forkConference;
    window._confEditMeta = editConferenceMeta;
    window._confToggleArtifactPanel = toggleArtifactPanel;
    window._confToggleArtifact = toggleArtifactLobby;
    window._confToggleMemory = toggleMemoryLobby;
    window._confClearMemories = clearPersonaMemories;
    window._confSetPage = setConferencePage;
    window._confViewMemories = viewPersonaMemories;
    window._confCloseMemoryViewer = closeMemoryViewer;
    window._confDeleteSingleMemory = deleteSingleMemory;

    window._confPickIcon = (icon) => {
        document.getElementById('conf-edit-icon').value = icon;
        document.querySelectorAll('#conf-icon-grid .conf-icon-pick').forEach(b => {
            b.classList.toggle('conf-icon-pick-active', b.dataset.icon === icon);
        });
    };

    window._confPickColor = (color) => {
        document.getElementById('conf-edit-color').value = color;
        document.querySelectorAll('#conf-color-row .conf-color-pick').forEach(b => {
            b.classList.toggle('conf-color-pick-active', b.dataset.color === color);
        });
    };

    window._confVoice = () => {
        if (typeof window.toggleVoiceRecording === 'function') {
            const btn = document.getElementById('conf-voice-btn');
            window.toggleVoiceRecording({ btn, inputId: 'conf-input', sendFn: () => sendConferenceMessage() });
        }
    };
}
