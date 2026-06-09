/**
 * Shared icon spec normalization for dashboard + Hyveview cards.
 * Accepts: "fa-bolt", "fas fa-bolt", "mdi:home", "mdi-home", emoji, etc.
 */

export function normalizeIconClass(spec: unknown): string {
    const raw = String(spec || '').trim();
    if (!raw) return '';
    if (raw.startsWith('mdi:')) return `mdi mdi-${raw.slice(4)}`;
    if (/^mdi(\s|-)/.test(raw)) return raw.startsWith('mdi-') ? `mdi ${raw}` : raw;
    if (/\bfa[srlbd]?\b/.test(raw)) return raw;
    if (raw.startsWith('fa-')) return `fas ${raw}`;
    return raw;
}

export function widgetIconSpec(widget: unknown): string {
    if (!widget || typeof widget !== 'object') return '';
    const w = widget as { icon?: unknown; config?: { icon?: unknown } };
    const cfg = w.config && typeof w.config === 'object' ? w.config : {};
    return String(w.icon || cfg.icon || '').trim();
}

export function applyIconClass(el: HTMLElement | null, spec: unknown, fallback = ''): void {
    if (!el) return;
    const normalized = normalizeIconClass(spec || fallback);
    if (!normalized) return;
    el.className = normalized;
}
