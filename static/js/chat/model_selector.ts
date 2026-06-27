/** Chat model / thinking-mode selector balloon toggles. */

export function closeProfileDropdown(): void {
    const dropdown = document.getElementById('model-profile-dropdown');
    const trigger = document.getElementById('model-profile-trigger');
    dropdown?.classList.add('hidden');
    trigger?.setAttribute('aria-expanded', 'false');
}

export function toggleProfileDropdown(): void {
    const dropdown = document.getElementById('model-profile-dropdown');
    const trigger = document.getElementById('model-profile-trigger');
    if (!dropdown || !trigger) return;
    const willOpen = dropdown.classList.contains('hidden');
    dropdown.classList.toggle('hidden');
    trigger.setAttribute('aria-expanded', String(willOpen));
}

export function toggleModelSelector(): void {
    const balloon = document.getElementById('model-selector-balloon');
    const btn = document.getElementById('btn-model-selector');
    if (!balloon) return;
    const isOpen = !balloon.classList.contains('hidden');
    balloon.classList.toggle('hidden');
    if (btn) btn.setAttribute('aria-expanded', String(!isOpen));
    if (!isOpen) {
        document.getElementById('chat-attach-balloon')?.classList.add('hidden');
    } else {
        closeProfileDropdown();
    }
}

export function closeModelSelector(): void {
    const balloon = document.getElementById('model-selector-balloon');
    const btn = document.getElementById('btn-model-selector');
    balloon?.classList.add('hidden');
    btn?.setAttribute('aria-expanded', 'false');
    closeProfileDropdown();
}

document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.model-selector-wrap');
    if (wrap && e.target instanceof Node && !wrap.contains(e.target)) closeModelSelector();
    const picker = document.getElementById('model-profile-picker');
    if (picker && e.target instanceof Node && !picker.contains(e.target)) closeProfileDropdown();
});
