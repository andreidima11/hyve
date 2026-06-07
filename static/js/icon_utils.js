/**
 * Shared icon spec normalization for dashboard + Hyveview cards.
 * Accepts: "fa-bolt", "fas fa-bolt", "mdi:home", "mdi-home", emoji, etc.
 */
export function normalizeIconClass(spec) {
    const raw = String(spec || '').trim();
    if (!raw) return '';
    if (raw.startsWith('mdi:')) return `mdi mdi-${raw.slice(4)}`;
    if (/^mdi(\s|-)/.test(raw)) return raw.startsWith('mdi-') ? `mdi ${raw}` : raw;
    if (/\bfa[srlbd]?\b/.test(raw)) return raw;
    if (raw.startsWith('fa-')) return `fas ${raw}`;
    return raw;
}

export function widgetIconSpec(widget) {
    if (!widget || typeof widget !== 'object') return '';
    const cfg = widget.config && typeof widget.config === 'object' ? widget.config : {};
    return String(widget.icon || cfg.icon || '').trim();
}

export function applyIconClass(el, spec, fallback = '') {
    if (!el) return;
    const normalized = normalizeIconClass(spec || fallback);
    if (!normalized) return;
    if (normalized.startsWith('mdi')) {
        el.className = normalized;
        return;
    }
    el.className = normalized;
}
