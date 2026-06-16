/**
 * Shared list-page chrome for config hub sections (scenes, areas, automations).
 */

const _wiredSearches = new Set<string>();

export function wireConfigListSearch(inputId: string, onFilter: (query: string) => void): void {
    if (_wiredSearches.has(inputId)) return;
    const el = document.getElementById(inputId) as HTMLInputElement | null;
    if (!el) return;
    _wiredSearches.add(inputId);
    el.addEventListener('input', () => onFilter((el.value || '').trim().toLowerCase()));
}

export function listShellLoadingHtml(message: string): string {
    return `<div class="hyd-list-placeholder" role="status"><i class="fas fa-spinner fa-spin" aria-hidden="true"></i><span>${message}</span></div>`;
}

export function listShellErrorHtml(message: string): string {
    return `<div class="hyd-list-placeholder hyd-list-placeholder--error" role="alert"><i class="fas fa-circle-exclamation" aria-hidden="true"></i><span>${message}</span></div>`;
}
