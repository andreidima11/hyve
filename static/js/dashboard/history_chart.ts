/**
 * History chart rendering for dashboard modals and sparklines.
 */

export interface HistoryPoint {
  ts: number;
  value: number;
}

export interface HistoryChartStats {
  current: number | null;
  min: number | null;
  max: number | null;
  avg: number | null;
  delta: number | null;
}

export interface HistoryChartOptions {
  width?: number;
  height?: number;
  mode?: 'line' | 'step' | 'auto';
  gradientId?: string;
  showAxes?: boolean;
}

function isStepSeries(points: HistoryPoint[], domain = ''): boolean {
  if (domain === 'binary_sensor') return true;
  if (!points.length) return false;
  const values = new Set(points.map((p) => Math.round(p.value * 1000) / 1000));
  return values.size <= 2 && [...values].every((v) => v === 0 || v === 1);
}

export function computeHistoryStats(points: HistoryPoint[]): HistoryChartStats {
  if (!points.length) {
    return { current: null, min: null, max: null, avg: null, delta: null };
  }
  const values = points.map((p) => p.value);
  const current = values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
  const delta = values.length > 1 ? current - values[0] : 0;
  return { current, min, max, avg, delta };
}

function formatAxisTime(ts: number): string {
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function renderHistoryChartSVG(
  points: HistoryPoint[],
  opts: HistoryChartOptions = {},
  domain = '',
): string {
  if (!Array.isArray(points) || points.length < 2) return '';
  const width = opts.width ?? 640;
  const height = opts.height ?? 220;
  const pad = { top: 12, right: 12, bottom: opts.showAxes === false ? 8 : 28, left: 8 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.value);
  const minX = xs[0];
  const maxX = xs[xs.length - 1];
  const spanX = Math.max(1, maxX - minX);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const spanY = maxY - minY;

  const mode = opts.mode === 'auto' || !opts.mode
    ? (isStepSeries(points, domain) ? 'step' : 'line')
    : opts.mode;
  const gradId = opts.gradientId || 'hyve-history-fill';

  const mapX = (ts: number) => pad.left + ((ts - minX) / spanX) * innerW;
  const mapY = (value: number) => pad.top + innerH - ((value - minY) / spanY) * innerH;

  let linePath = '';
  if (mode === 'step') {
    const first = points[0];
    linePath = `M${mapX(first.ts).toFixed(2)},${mapY(first.value).toFixed(2)}`;
    for (let i = 1; i < points.length; i += 1) {
      const p = points[i];
      linePath += ` H${mapX(p.ts).toFixed(2)} V${mapY(p.value).toFixed(2)}`;
    }
  } else {
    linePath = points.map((p, i) => {
      const x = mapX(p.ts).toFixed(2);
      const y = mapY(p.value).toFixed(2);
      return i === 0 ? `M${x},${y}` : `L${x},${y}`;
    }).join(' ');
  }

  const last = points[points.length - 1];
  const areaPath = `${linePath} L${mapX(last.ts).toFixed(2)},${(pad.top + innerH).toFixed(2)} L${mapX(points[0].ts).toFixed(2)},${(pad.top + innerH).toFixed(2)} Z`;

  const axis = opts.showAxes === false ? '' : `
    <text x="${pad.left}" y="${height - 8}" fill="var(--text-tertiary,#94a3b8)" font-size="10">${formatAxisTime(minX)}</text>
    <text x="${width - pad.right}" y="${height - 8}" text-anchor="end" fill="var(--text-tertiary,#94a3b8)" font-size="10">${formatAxisTime(maxX)}</text>`;

  return `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">
      <defs>
        <linearGradient id="${gradId}" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="var(--accent, #60a5fa)" stop-opacity="0.32"/>
          <stop offset="100%" stop-color="var(--accent, #60a5fa)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect x="${pad.left}" y="${pad.top}" width="${innerW}" height="${innerH}" rx="8" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.05)"/>
      <path d="${areaPath}" fill="url(#${gradId})" stroke="none"/>
      <path d="${linePath}" fill="none" stroke="var(--accent, #60a5fa)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      ${axis}
    </svg>`;
}

export function renderSparklineSVG(points: HistoryPoint[]): string {
  if (!Array.isArray(points) || points.length < 2) return '';
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
  if (minY === maxY) { minY -= 1; maxY += 1; }
  const spanY = maxY - minY;

  const coords = points.map((p) => {
    const x = ((p.ts - minX) / spanX) * width;
    const y = height - padY - ((p.value - minY) / spanY) * (height - padY * 2);
    return [x, y] as const;
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
