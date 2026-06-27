import { t } from './lang/index.js';
import type { ThinkingMode } from './types/dashboard.js';

const STORAGE_KEY = 'hyve_thinking_mode';
const VALID_MODES: ThinkingMode[] = ['auto', 'think', 'no_think'];

export function normalizeThinkingMode(mode: unknown): ThinkingMode {
    const raw = String(mode || 'auto').trim().toLowerCase().replace(/-/g, '_');
    if (raw === 'no_think' || raw === 'nothink' || raw === 'no think') return 'no_think';
    return (VALID_MODES as string[]).includes(raw) ? (raw as ThinkingMode) : 'auto';
}

export function getThinkingMode(): ThinkingMode {
    try {
        return normalizeThinkingMode(localStorage.getItem(STORAGE_KEY));
    } catch {
        return 'auto';
    }
}

export function setThinkingMode(mode: unknown): ThinkingMode {
    const normalized = normalizeThinkingMode(mode);
    try {
        localStorage.setItem(STORAGE_KEY, normalized);
    } catch { /* ignore */ }
    updateThinkingModeUi(normalized);
    return normalized;
}

export function updateThinkingModeUi(mode: ThinkingMode = getThinkingMode()): void {
    const normalized = normalizeThinkingMode(mode);
    const list = document.getElementById('thinking-mode-options');
    if (list) {
        list.querySelectorAll('.hyd-chip--menu[data-mode]').forEach((el) => {
            const active = el.getAttribute('data-mode') === normalized;
            el.classList.toggle('is-active', active);
            el.setAttribute('aria-checked', active ? 'true' : 'false');
        });
    }
}

export function initThinkingModeSelector(): void {
    updateThinkingModeUi(getThinkingMode());
}
