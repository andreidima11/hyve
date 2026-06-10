/**
 * Dashboard sparkline charts (24h entity history mini-graphs).
 */
import { apiCall } from '../api.js';
export const trendCache = new Map();
const _sparklineCache = new Map();
const _SPARKLINE_TTL_MS = 60000;
const _SPARKLINE_HOURS = 24;
const _sparklineFetching = new Set();
let _batchPromise = null;
const _batchPending = new Set();
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
function paintSparklineSlot(root, entityId, points) {
    const fresh = root.querySelector(`[data-sparkline-entity="${CSS.escape(entityId)}"]`);
    if (!fresh)
        return;
    const svg = renderSparklineSVG(points);
    if (svg)
        fresh.innerHTML = svg;
}
async function fetchSparklineHistoryBatch(entityIds) {
    const pending = entityIds.filter((id) => id && !_sparklineFetching.has(id));
    if (!pending.length)
        return;
    pending.forEach((id) => _sparklineFetching.add(id));
    try {
        const res = await apiCall('/api/dashboard/history/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entity_ids: pending, hours: _SPARKLINE_HOURS }),
        });
        if (!res?.ok)
            return;
        const data = await res.json();
        const histories = data?.histories || {};
        const now = Date.now();
        for (const entityId of pending) {
            const points = Array.isArray(histories[entityId]) ? histories[entityId] : [];
            _sparklineCache.set(entityId, { ts: now, points });
        }
    }
    catch {
        // keep stale cache if any
    }
    finally {
        pending.forEach((id) => _sparklineFetching.delete(id));
    }
}
function scheduleSparklineBatchFlush() {
    if (_batchPromise)
        return;
    _batchPromise = Promise.resolve().then(async () => {
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        const ids = [..._batchPending];
        _batchPending.clear();
        _batchPromise = null;
        if (ids.length)
            await fetchSparklineHistoryBatch(ids);
        if (_batchPending.size)
            scheduleSparklineBatchFlush();
    });
}
function queueSparklineBatch(entityId) {
    _batchPending.add(entityId);
    scheduleSparklineBatchFlush();
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
    const toFetch = [];
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
        if (!_sparklineFetching.has(entityId))
            toFetch.push(entityId);
    });
    if (!toFetch.length)
        return;
    toFetch.forEach((entityId) => queueSparklineBatch(entityId));
    void (_batchPromise || Promise.resolve()).then(() => {
        toFetch.forEach((entityId) => {
            const cached = _sparklineCache.get(entityId);
            if (cached)
                paintSparklineSlot(root, entityId, cached.points);
        });
    });
}
