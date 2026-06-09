/**
 * Load per-card stylesheets once (bundled + custom drop-ins).
 */

const _loaded = new Set();

function _cacheQuery() {
  const bust = typeof window !== 'undefined' && window.__cacheBust
    ? String(window.__cacheBust)
    : '';
  return bust ? `?v=${encodeURIComponent(bust)}` : '';
}

/** @param {string} url Absolute path, e.g. /static/hyveview/cards/tile/styles.css */
export function ensureCardStylesheet(url) {
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

/** @param {string[]} urls */
export function ensureCardStylesheets(urls) {
  (urls || []).forEach((u) => ensureCardStylesheet(u));
}
