/**
 * Shared icon spec normalization for dashboard + Hyveview cards.
 * Accepts: "fa-bolt", "fas fa-bolt", "fa-solid fa-house", "mdi:home", "mdi-home", emoji, etc.
 */

const FA_STYLE_RE = /\b(fa-solid|fa-regular|fa-brands|fa-light|fa-duotone|fa-sharp|fas|far|fab|fal|fad)\b/i;

export function normalizeIconClass(spec: unknown): string {
    const raw = String(spec || '').trim();
    if (!raw) return '';

    const lower = raw.toLowerCase();
    if (lower.startsWith('mdi:')) {
        const name = lower.slice(4).trim().replace(/^mdi-/, '');
        return name ? `mdi mdi-${name}` : '';
    }
    if (/^mdi(\s|-)/i.test(raw)) {
        return /^mdi-/i.test(raw) ? `mdi ${raw}` : raw;
    }

    if (FA_STYLE_RE.test(raw)) return raw;
    if (/^fa-/i.test(raw)) return `fas ${raw}`;

    return raw;
}

/** Resolve icon class for DOM — always normalizes, optional fallback glyph. */
export function resolveIconClass(spec: unknown, fallback = 'fas fa-bolt'): string {
    const normalized = normalizeIconClass(spec);
    if (normalized) return normalized;
    return normalizeIconClass(fallback) || fallback;
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
