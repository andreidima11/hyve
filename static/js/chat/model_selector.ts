/** Chat settings modal (cog) — open/close + dismissal. */

const MODAL_ID = 'chat-settings-modal';

function _modal(): HTMLElement | null {
    return document.getElementById(MODAL_ID);
}

export function openModelSelector(): void {
    const modal = _modal();
    const btn = document.getElementById('btn-model-selector');
    if (!modal) return;
    document.getElementById('chat-attach-balloon')?.classList.add('hidden');
    modal.classList.remove('hidden');
    modal.setAttribute('aria-hidden', 'false');
    btn?.setAttribute('aria-expanded', 'true');
}

export function closeModelSelector(): void {
    const modal = _modal();
    const btn = document.getElementById('btn-model-selector');
    if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
    btn?.setAttribute('aria-expanded', 'false');
}

export function toggleModelSelector(): void {
    const modal = _modal();
    if (!modal) return;
    if (modal.classList.contains('hidden')) openModelSelector();
    else closeModelSelector();
}

// Backdrop click (on the overlay itself) closes the modal.
document.addEventListener('click', (e) => {
    const modal = _modal();
    if (modal && !modal.classList.contains('hidden') && e.target === modal) {
        closeModelSelector();
    }
});

// Escape closes the modal.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = _modal();
    if (modal && !modal.classList.contains('hidden')) closeModelSelector();
});
