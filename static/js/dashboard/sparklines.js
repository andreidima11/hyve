/**
 * Dashboard sparkline charts (24h entity history mini-graphs).
 */
import { apiCall } from '../api.js';
export const trendCache = new Map();
const _sparklineCache = new Map();
const _SPARKLINE_TTL_MS = 60000;
const _SPARKLINE_HOURS = 24;
const _sparklineFetching = new Set();
function renderSparklineSVG(points) {
    if (!Array.isArray(points) || points.length < 2)
        return '';
    const width = 100;
    const height = 28;
    const padY = 2;
    const xs = points.map((p) => p.ts);
    const ys = points.map((p) => p.value);
    const minX = xs[0];
    const maxX = xs[xs.length - 1];
    const spanX = Math.max(1, maxX - minX);
    let minY = Math.min(...ys);
    let maxY = Math.max(...ys);
    if (minY === maxY) {
        minY -= 1;
        maxY += 1;
    }
    const spanY = maxY - minY;
    const coords = points.map((p) => {
        const x = ((p.ts - minX) / spanX) * width;
        const y = height - padY - ((p.value - minY) / spanY) * (height - padY * 2);
        return [x, y];
    });
    const linePath = coords.map((c, i) => (i === 0 ? `M${c[0].toFixed(2)},${c[1].toFixed(2)}` : `L${c[0].toFixed(2)},${c[1].toFixed(2)}`)).join(' ');
    const areaPath = `${linePath} L${width.toFixed(2)},${height.toFixed(2)} L0,${height.toFixed(2)} Z`;
    return `
        <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
                <linearGradient id="sparkfill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stop-color="var(--accent, #60a5fa)" stop-opacity="0.35"/>
                    <stop offset="100%" stop-color="var(--accent, #60a5fa)" stop-opacity="0"/>
                </linearGradient>
            </defs>
            <path d="${areaPath}" fill="url(#sparkfill)" stroke="none"/>
            <path d="${linePath}" fill="none" stroke="var(--accent, #60a5fa)" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>`;
}
async function fetchSparklineHistory(entityId) {
    if (_sparklineFetching.has(entityId))
        return null;
    _sparklineFetching.add(entityId);
    try {
        const res = await apiCall(`/api/dashboard/history?entity_id=${encodeURIComponent(entityId)}&hours=${_SPARKLINE_HOURS}`);
        if (!res?.ok)
            return null;
        const data = await res.json();
        const points = Array.isArray(data?.points) ? data.points : [];
        _sparklineCache.set(entityId, { ts: Date.now(), points });
        return points;
    }
    catch {
        return null;
    }
    finally {
        _sparklineFetching.delete(entityId);
    }
}
export function enhanceSparklines() {
    const grid = document.getElementById('dashboard-grid');
    if (!grid)
        return;
    enhanceSparklinesIn(grid);
}
/**
 * Enhance every `[data-sparkline-entity]` slot inside `root`. Used by both
 * the legacy full-grid path and Hyveview cards that mount sparklines after a state diff.
 */
export function enhanceSparklinesIn(root) {
    if (!root)
        return;
    const slots = root.querySelectorAll('[data-sparkline-entity]');
    slots.forEach((slot) => {
        if (slot instanceof HTMLElement && (slot.hidden || slot.hasAttribute('hidden')))
            return;
        const entityId = slot.getAttribute('data-sparkline-entity');
        if (!entityId || !entityId.startsWith('sensor.'))
            return;
        const cached = _sparklineCache.get(entityId);
        if (cached && (Date.now() - cached.ts) < _SPARKLINE_TTL_MS) {
            const svg = renderSparklineSVG(cached.points);
            if (svg)
                slot.innerHTML = svg;
            return;
        }
        if (cached) {
            const svg = renderSparklineSVG(cached.points);
            if (svg)
                slot.innerHTML = svg;
        }
        void fetchSparklineHistory(entityId).then((points) => {
            if (!points)
                return;
            const fresh = root.querySelector(`[data-sparkline-entity="${CSS.escape(entityId)}"]`);
            if (!fresh)
                return;
            const svg = renderSparklineSVG(points);
            if (svg)
                fresh.innerHTML = svg;
        });
    });
}
