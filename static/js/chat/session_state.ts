/**
 * Active chat session id and sidebar display labels.
 */

import { t } from '../lang/index.js';

export let currentSessionId: string | null = localStorage.getItem('hyve_session_id') || null;

export function setCurrentSessionId(id: string | null): void {
    currentSessionId = id;
    try {
        if (id) localStorage.setItem('hyve_session_id', id);
        else localStorage.removeItem('hyve_session_id');
    } catch (_) {}
    const disp = document.getElementById('session-display');
    if (disp) disp.innerText = id ? id.slice(0, 8) + '…' : t('status.connected');
    const btnClear = document.getElementById('btn-clear-context');
    if (btnClear) {
        btnClear.classList.toggle('hidden', !id);
        if (id) btnClear.title = t('sessions.clear_context_tooltip');
    }
}

export function setSessionDisplay(title: string | null | undefined): void {
    const el = document.getElementById('session-name-display');
    if (el) el.textContent = title || '—';
    if (el && title) el.setAttribute('title', title);
}
