import { apiCall } from './api.js';

export const DEFAULT_CONFERENCE_MODES = [
    { id: 'brainstorm', name: 'Brainstorm', icon: 'fa-lightbulb', color: '#f59e0b', builtin: true },
    { id: 'debate', name: 'Dezbatere', icon: 'fa-comments', color: '#ef4444', builtin: true },
    { id: 'review', name: 'Review', icon: 'fa-search', color: '#10b981', builtin: true },
];

export function loadLobbyStateFromStorage(storageKey) {
    try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

export function saveLobbyStateToStorage(storageKey, state) {
    try {
        localStorage.setItem(storageKey, JSON.stringify(state));
        return true;
    } catch (e) {
        return false;
    }
}

export async function loadLobbyPrefsFromServer() {
    const resp = await apiCall('/api/conference/lobby-prefs');
    if (!resp.ok) return null;
    return await resp.json();
}

export async function saveLobbyPrefsToServer(payload) {
    return await apiCall('/api/conference/lobby-prefs', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

export async function fetchConferencePersonas() {
    const resp = await apiCall('/api/conference/personas');
    if (!resp.ok) return null;
    return await resp.json();
}

export async function fetchConferenceModelProfiles() {
    const resp = await apiCall('/api/model-profiles');
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.profiles || [];
}

export async function fetchConferenceList() {
    const resp = await apiCall('/api/conference/list');
    if (!resp.ok) return [];
    return await resp.json();
}

export async function fetchPersonaMemoryCounts() {
    const resp = await apiCall('/api/conference/persona-memories/counts');
    if (!resp.ok) return {};
    return await resp.json();
}

export async function fetchConferenceModes() {
    const resp = await apiCall('/api/conference/modes');
    if (!resp.ok) return DEFAULT_CONFERENCE_MODES;
    return await resp.json();
}

export async function fetchConferenceById(confId) {
    const resp = await apiCall(`/api/conference/${confId}`);
    if (!resp.ok) return null;
    return await resp.json();
}

export async function removeConference(confId) {
    return await apiCall(`/api/conference/${confId}`, { method: 'DELETE' });
}
