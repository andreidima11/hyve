import { t } from './lang/index.js';

const STORAGE_KEY = 'hyve_thinking_mode';
const VALID_MODES = ['auto', 'think', 'no_think'];

export function normalizeThinkingMode(mode) {
    const raw = String(mode || 'auto').trim().toLowerCase().replace(/-/g, '_');
    if (raw === 'no_think' || raw === 'nothink' || raw === 'no think') return 'no_think';
    return VALID_MODES.includes(raw) ? raw : 'auto';
}

export function getThinkingMode() {
    try {
        return normalizeThinkingMode(localStorage.getItem(STORAGE_KEY));
    } catch (_) {
        return 'auto';
    }
}

export function setThinkingMode(mode) {
    const normalized = normalizeThinkingMode(mode);
    try {
        localStorage.setItem(STORAGE_KEY, normalized);
    } catch (_) { /* ignore */ }
    updateThinkingModeUi(normalized);
    return normalized;
}

export function updateThinkingModeUi(mode = getThinkingMode()) {
    const normalized = normalizeThinkingMode(mode);
    const btn = document.getElementById('btn-model-selector');
    const list = document.getElementById('thinking-mode-options');
    if (btn) {
        btn.classList.remove('mode-auto', 'mode-think', 'mode-no_think');
        btn.classList.add(`mode-${normalized}`);
    }
    if (list) {
        list.querySelectorAll('.thinking-segment-btn[data-mode]').forEach((el) => {
            const active = el.getAttribute('data-mode') === normalized;
            el.classList.toggle('active', active);
            el.setAttribute('aria-checked', active ? 'true' : 'false');
        });
    }
}

export function initThinkingModeSelector() {
    updateThinkingModeUi(getThinkingMode());
}
