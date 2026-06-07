/** Chat model / thinking-mode selector balloon toggles. */

export function toggleModelSelector() {
    const balloon = document.getElementById('model-selector-balloon');
    const btn = document.getElementById('btn-model-selector');
    if (!balloon) return;
    const isOpen = !balloon.classList.contains('hidden');
    balloon.classList.toggle('hidden');
    if (btn) btn.setAttribute('aria-expanded', String(!isOpen));
    if (!isOpen) {
        document.getElementById('chat-attach-balloon')?.classList.add('hidden');
    }
}

export function closeModelSelector() {
    const balloon = document.getElementById('model-selector-balloon');
    const btn = document.getElementById('btn-model-selector');
    balloon?.classList.add('hidden');
    btn?.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.model-selector-wrap');
    if (wrap && !wrap.contains(e.target)) closeModelSelector();
});
