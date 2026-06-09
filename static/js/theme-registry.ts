const themeOptions = Object.freeze([
    { id: 'canvas', selector: 'canvas', label: 'Canvas', preview: ['#0a0a0a', '#171717', '#a8c7fa'] },
    { id: 'obsidian', selector: 'dark', label: 'Obsidian', preview: ['#030712', '#0f172a', '#38bdf8'] },
    { id: 'daylight', selector: 'light', label: 'Daylight', preview: ['#f8fafc', '#e2e8f0', '#2563eb'] },
]);

function resolveTheme(themeId: string) {
    return themeOptions.find((theme) => theme.id === themeId) || themeOptions[0];
}

function getStoredThemeId(): string {
    try {
        return localStorage.getItem('hyve_theme') || themeOptions[0].id;
    } catch (_) {
        return themeOptions[0].id;
    }
}

function getStoredThemeSelector(): string {
    try {
        const storedSelector = localStorage.getItem('hyve_theme_selector');
        if (storedSelector) return storedSelector;
    } catch (_) {}
    return resolveTheme(getStoredThemeId()).selector;
}

window.__HYVE_THEME_REGISTRY__ = {
    themeOptions: themeOptions as Array<{ id: string; selector: string; label: string; preview: string[] }>,
    resolveTheme,
    getStoredThemeId,
    getStoredThemeSelector,
};

export {};
