(function () {
    const themeOptions = Object.freeze([
        { id: 'obsidian', selector: 'dark', label: 'Obsidian', preview: ['#030712', '#0f172a', '#38bdf8'] },
        { id: 'midnight', selector: 'midnight', label: 'Midnight', preview: ['#111111', '#1f1f1f', '#f59e0b'] },
        { id: 'midnight-white', selector: 'midnight', label: 'Midnight White', preview: ['#111111', '#2a2a2a', '#ffffff'] },
        { id: 'moonlight', selector: 'midnight', label: 'Moonlight', preview: ['#111111', '#242938', '#ffffff'] },
        { id: 'daylight', selector: 'light', label: 'Daylight', preview: ['#f8fafc', '#e2e8f0', '#2563eb'] },
        { id: 'canvas', selector: 'canvas', label: 'Canvas', preview: ['#0a0a0a', '#171717', '#a8c7fa'] },
        { id: 'terra', selector: 'prism', label: 'Terra', preview: ['#171312', '#2c2420', '#d97757'] },
    ]);

    function resolveTheme(themeId) {
        return themeOptions.find((theme) => theme.id === themeId) || themeOptions[0];
    }

    function getStoredThemeId() {
        try {
            return localStorage.getItem('memini_theme') || themeOptions[0].id;
        } catch (_) {
            return themeOptions[0].id;
        }
    }

    function getStoredThemeSelector() {
        try {
            const storedSelector = localStorage.getItem('memini_theme_selector');
            if (storedSelector) return storedSelector;
        } catch (_) {}
        return resolveTheme(getStoredThemeId()).selector;
    }

    window.__MEMINI_THEME_REGISTRY__ = {
        themeOptions,
        resolveTheme,
        getStoredThemeId,
        getStoredThemeSelector,
    };
})();