/**
 * Cache busting for Hyve static assets.
 *
 * The server injects `window.__cacheBust` (process start timestamp) in index.html.
 * Entry scripts and dynamic imports should use `withCacheBust` / `importWithCacheBust`.
 * Static ES module imports omit `?v=` and rely on no-store (see core/http/middleware.py).
 */

/** Server-provided cache token, or empty before bootstrap. */
export function cacheBust(): string {
    if (typeof window !== 'undefined' && window.__cacheBust) {
        return String(window.__cacheBust);
    }
    return '';
}

/** Append or replace `v` query param using the server cache token. */
export function withCacheBust(url: string): string {
    const raw = String(url || '').trim();
    if (!raw) return raw;
    const v = cacheBust();
    if (!v) return raw;
    const [base, query = ''] = raw.split('?');
    const params = new URLSearchParams(query);
    params.set('v', v);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
}

/** Dynamic `import()` with the current server cache token. */
export function importWithCacheBust(specifier: string): Promise<unknown> {
    return import(withCacheBust(specifier));
}
