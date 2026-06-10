/**
 * Load per-card stylesheets once (bundled + custom drop-ins).
 */

/// <reference path="../types/global.d.ts" />

const _loaded = new Set<string>();

function _cacheQuery(): string {
    const bust = typeof window !== 'undefined' && window.__cacheBust
        ? String(window.__cacheBust)
        : '';
    return bust ? `?v=${encodeURIComponent(bust)}` : '';
}

export function ensureCardStylesheet(url: string): void {
    const href = String(url || '').trim();
    if (!href || _loaded.has(href)) return;
    _loaded.add(href);
    if (typeof document === 'undefined') return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `${href}${_cacheQuery()}`;
    link.dataset.hvCardStyle = 'true';
    document.head.appendChild(link);
}

export function ensureCardStylesheets(urls: string[] | null | undefined): void {
    (urls || []).forEach((u) => ensureCardStylesheet(u));
}
