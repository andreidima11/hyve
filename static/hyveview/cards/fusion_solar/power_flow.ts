/**
 * Hyve Power Flow card — clean, fully self-contained SVG energy-flow diagram.
 *
 * Three nodes (solar top-center, grid bottom-left, home bottom-right) connected
 * by smooth gradient lines with animated flow whose speed scales with power.
 * Each node is a glass bubble (lit when power flows; kW value shown as text).
 * Grid import = light red, grid export = green, home = accent blue, solar = amber.
 */

const VB_W = 360;
const VB_H = 264;

interface FlowNode {
  x: number;
  y: number;
  r: number;
  icon: string;
  label: string;
}

type FlowLineId = 'solar_grid' | 'solar_home' | 'grid_home' | 'solar_battery' | 'battery_home';
type HomeSource = 'idle' | 'solar' | 'grid' | 'mixed';

interface FlowMetrics {
  power?: number;
  load?: number;
  grid_export_live?: number;
  grid_import_live?: number;
}

interface FlowFmt {
  fmtPowerSmart?: (v: number | null | undefined) => string;
}

interface FlowBattery {
  soc?: number | null;
  power?: number;
}

const NODES: Record<string, FlowNode> = {
  solar: { x: 180, y: 68, r: 41, icon: 'mdi-solar-power-variant', label: 'Panouri' },
  grid: { x: 66, y: 196, r: 41, icon: 'mdi-transmission-tower', label: 'Rețea' },
  home: { x: 294, y: 196, r: 41, icon: 'mdi-home-lightning-bolt', label: 'Casă' },
  battery: { x: 180, y: 232, r: 30, icon: 'mdi-battery-high', label: 'Baterie' },
};

/** Curved path between two node edges with a slight outward bow. */
function _edgePath(a: FlowNode, b: FlowNode, bow: number): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;
  const sx = a.x + ux * a.r;
  const sy = a.y + uy * a.r;
  const ex = b.x - ux * b.r;
  const ey = b.y - uy * b.r;
  const mx = (sx + ex) / 2;
  const my = (sy + ey) / 2;
  const px = -uy;
  const py = ux;
  const cx = mx + px * bow;
  const cy = my + py * bow;
  return `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
}

const LINES: Record<FlowLineId, { d: string; from: string; to: string }> = {
  solar_grid: { d: _edgePath(NODES.solar, NODES.grid, -22), from: 'solar', to: 'grid' },
  solar_home: { d: _edgePath(NODES.solar, NODES.home, 22), from: 'solar', to: 'home' },
  grid_home: { d: _edgePath(NODES.grid, NODES.home, 26), from: 'grid', to: 'home' },
  solar_battery: { d: _edgePath(NODES.solar, NODES.battery, 0), from: 'solar', to: 'battery' },
  battery_home: { d: _edgePath(NODES.battery, NODES.home, 0), from: 'battery', to: 'home' },
};

const COLOR = {
  solar: 'var(--fsolar-solar)',
  gridImport: 'var(--fsolar-grid-import)',
  gridExport: 'var(--fsolar-grid-export)',
  home: 'var(--fsolar-home)',
  battery: 'var(--fsolar-grid-export)',
};

function _endpointColor(nodeId: string, lineId: string): string {
  if (nodeId === 'grid') {
    return lineId === 'solar_grid' ? COLOR.gridExport : COLOR.gridImport;
  }
  if (nodeId === 'solar') return COLOR.solar;
  if (nodeId === 'home') return COLOR.home;
  if (nodeId === 'battery') return COLOR.battery;
  return COLOR.home;
}

function _glowColor(nodeId: string): string {
  if (nodeId === 'grid') return COLOR.gridImport;
  if (nodeId === 'solar') return COLOR.solar;
  if (nodeId === 'home') return COLOR.home;
  if (nodeId === 'battery') return COLOR.battery;
  return COLOR.home;
}

function _glowGrad(id: string, variant: string | null = null): string {
  const gradId = variant ? `hvflow-glow-${id}-${variant}` : `hvflow-glow-${id}`;
  let c = _glowColor(id);
  if (id === 'grid' && variant === 'export') c = COLOR.gridExport;
  if (id === 'grid' && variant === 'import') c = COLOR.gridImport;
  if (id === 'home' && variant === 'solar') c = 'var(--fsolar-home-solar)';
  if (id === 'home' && variant === 'grid') c = 'var(--fsolar-home-grid)';
  return `
    <radialGradient id="${gradId}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${c}" stop-opacity="0.3"/>
      <stop offset="35%" stop-color="${c}" stop-opacity="0.12"/>
      <stop offset="58%" stop-color="${c}" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="${c}" stop-opacity="0"/>
    </radialGradient>`;
}

function _node(id: string): string {
  const n = NODES[id]!;
  const { x, y, r } = n;
  const glowR = r + 28;
  const haloR = r + 16;
  const glowRef = id === 'grid' ? 'url(#hvflow-glow-grid-import)' : `url(#hvflow-glow-${id})`;
  const labelY = id === 'solar' ? y - r - 11 : y + r + 17;
  return `
    <g class="hvflow__node hvflow__node--${id}" data-node="${id}"${id === 'home' ? ' data-source="idle"' : ''}>
      <circle class="hvflow__glow" cx="${x}" cy="${y}" r="${glowR}" fill="${glowRef}" data-glow="${id}"/>
      <circle class="hvflow__halo" cx="${x}" cy="${y}" r="${haloR}" fill="${glowRef}" data-glow="${id}"/>
      <foreignObject x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${r * 2}" height="${r * 2}">
        <div xmlns="http://www.w3.org/1999/xhtml" class="hvflow__glass-disc"></div>
      </foreignObject>
      <circle class="hvflow__bubble" cx="${x}" cy="${y}" r="${r}" data-bubble="${id}"/>
      <foreignObject x="${x - 14}" y="${(y - r * 0.52).toFixed(1)}" width="28" height="20">
        <div xmlns="http://www.w3.org/1999/xhtml" class="hvflow__icon">
          <span class="mdi ${n.icon}"></span>
        </div>
      </foreignObject>
      <text class="hvflow__value" x="${x}" y="${(y + r * 0.38).toFixed(1)}" text-anchor="middle">
        <tspan class="hvflow__num" data-num="${id}">—</tspan><tspan class="hvflow__unit" dx="2" data-unit="${id}"></tspan>
      </text>
      <text class="hvflow__label" x="${x}" y="${labelY.toFixed(1)}" text-anchor="middle">${n.label}</text>
    </g>`;
}

function _line(id: string): string {
  const L = LINES[id as FlowLineId];
  return `
    <g class="hvflow__flow" data-flow="${id}" data-active="false"
      data-from="${L.from}" data-to="${L.to}">
      <path id="hvflow-${id}" class="hvflow__line" d="${L.d}" vector-effect="non-scaling-stroke"
        stroke="url(#hvflow-grad-${id})"/>
      <path class="hvflow__pulse" d="${L.d}" pathLength="100" vector-effect="non-scaling-stroke"
        fill="none" stroke="url(#hvflow-grad-${id})" stroke-linecap="round"
        stroke-dasharray="14 86">
        <animate class="hvflow__pulse-anim" attributeName="stroke-dashoffset"
          values="100;0" dur="2s" repeatCount="indefinite"/>
      </path>
    </g>`;
}

function _grad(id: FlowLineId, c1: string, c2: string): string {
  const line = LINES[id];
  return `
    <linearGradient id="hvflow-grad-${id}" gradientUnits="userSpaceOnUse"
      x1="${NODES[line.from].x}" y1="${NODES[line.from].y}"
      x2="${NODES[line.to].x}" y2="${NODES[line.to].y}">
      <stop offset="0%" stop-color="${c1}" stop-opacity="0.95"/>
      <stop offset="55%" stop-color="${c1}" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="${c2}" stop-opacity="0.95"/>
    </linearGradient>`;
}

export function renderFlowCard({ showBattery = false }: { showBattery?: boolean } = {}): string {
  const lineIds: FlowLineId[] = ['solar_grid', 'solar_home', 'grid_home'];
  const nodeIds = ['solar', 'grid', 'home'];
  if (showBattery) {
    lineIds.push('solar_battery', 'battery_home');
    nodeIds.push('battery');
  }

  const glowDefs = nodeIds
    .filter((id) => id !== 'grid' && id !== 'home')
    .map((id) => _glowGrad(id))
    .concat([
      _glowGrad('home'),
      _glowGrad('home', 'solar'),
      _glowGrad('home', 'grid'),
      _homeMixedGlowGrad(),
      _glowGrad('grid', 'import'),
      _glowGrad('grid', 'export'),
    ]);
  const defs = [
    ...lineIds.map((lid) => _grad(lid, _endpointColor(LINES[lid].from, lid), _endpointColor(LINES[lid].to, lid))),
    ...glowDefs,
  ].join('');

  return `
    <div class="hvflow" data-show-battery="${showBattery}">
      <svg class="hvflow__svg" viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet">
        <defs>${defs}</defs>
        <g class="hvflow__lines">${lineIds.map(_line).join('')}</g>
        <g class="hvflow__nodes">${nodeIds.map(_node).join('')}</g>
      </svg>
    </div>`;
}

const TH = 0.04;

const HOME_GLOW: Record<string, string> = {
  idle: 'url(#hvflow-glow-home)',
  solar: 'url(#hvflow-glow-home-solar)',
  grid: 'url(#hvflow-glow-home-grid)',
  mixed: 'url(#hvflow-glow-home-mixed)',
};

/** @returns {number|null} 0–100 self-consumption share of home load */
export function computeAutoconsumPct(
  solarToHome: number | null | undefined,
  gridImport: number | null | undefined,
  load: number | null | undefined,
): number | null {
  const loadVal = load ?? 0;
  const consuming = loadVal > TH;
  if (!consuming) return null;
  const solarPart = Math.min(loadVal, Math.max(0, solarToHome ?? 0));
  return Math.round(Math.min(100, Math.max(0, (solarPart / loadVal) * 100)));
}

export function computeHomeSource(
  solarToHome: number | null | undefined,
  gridImport: number | null | undefined,
  load: number | null | undefined,
): HomeSource {
  const fromSolar = (solarToHome ?? 0) > TH;
  const fromGrid = (gridImport ?? 0) > TH;
  const consuming = (load ?? 0) > TH;
  if (!consuming) return 'idle';
  if (fromSolar && fromGrid) return 'mixed';
  if (fromSolar) return 'solar';
  if (fromGrid) return 'grid';
  return 'idle';
}

function _homeMixedGlowGrad() {
  return `
    <radialGradient id="hvflow-glow-home-mixed" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="var(--fsolar-home-solar)" stop-opacity="0.3"/>
      <stop offset="28%" stop-color="var(--fsolar-home-solar)" stop-opacity="0.14"/>
      <stop offset="35%" stop-color="var(--fsolar-home-grid)" stop-opacity="0.12"/>
      <stop offset="58%" stop-color="var(--fsolar-home-grid)" stop-opacity="0.04"/>
      <stop offset="100%" stop-color="var(--fsolar-home-grid)" stop-opacity="0"/>
    </radialGradient>`;
}

function _dur(kw: number | null | undefined): string {
  const v = Math.min(Math.abs(kw || 0), 10);
  return (3 - (v / 10) * 2.3).toFixed(2);
}

function _lineWidth(kw: number | null | undefined): string {
  const v = Math.min(Math.abs(kw || 0), 10);
  return (2.2 + v * 0.18).toFixed(2);
}

function _setFlow(
  root: ParentNode,
  id: string,
  active: boolean,
  kw: number,
  reverse = false,
): void {
  const g = root.querySelector(`[data-flow="${id}"]`) as HTMLElement | null;
  if (!g) return;
  g.dataset.active = active ? 'true' : 'false';
  const durNum = parseFloat(_dur(kw));
  const dur = `${durNum}s`;
  const width = _lineWidth(kw);
  const line = g.querySelector('.hvflow__line') as SVGElement | null;
  const pulse = g.querySelector('.hvflow__pulse') as SVGElement | null;
  if (line) line.style.strokeWidth = active ? `${width}px` : '';
  if (pulse) pulse.style.strokeWidth = active ? `${width}px` : '';
  const anim = g.querySelector('.hvflow__pulse-anim');
  if (anim) {
    anim.setAttribute('dur', dur);
    anim.setAttribute('values', reverse ? '0;100' : '100;0');
  }
}

function _setNodeActive(root: ParentNode, id: string, value: number): void {
  const node = root.querySelector(`[data-node="${id}"]`) as HTMLElement | null;
  if (node) node.dataset.active = (Math.abs(value) || 0) > TH ? 'true' : 'false';
}

function _setHomeSource(root: ParentNode, source: HomeSource): void {
  const homeNode = root.querySelector('[data-node="home"]') as HTMLElement | null;
  if (!homeNode) return;
  const mode = HOME_GLOW[source] ? source : 'idle';
  homeNode.dataset.source = mode;
  const glowFill = HOME_GLOW[mode];
  homeNode.querySelectorAll('[data-glow="home"]').forEach((el) => el.setAttribute('fill', glowFill));
}

function _setValue(root: ParentNode, id: string, text: unknown): void {
  const numEl = root.querySelector(`[data-num="${id}"]`);
  const unitEl = root.querySelector(`[data-unit="${id}"]`);
  const str = String(text ?? '');
  const sp = str.lastIndexOf(' ');
  const num = sp > 0 ? str.slice(0, sp) : str;
  const unit = sp > 0 ? str.slice(sp + 1) : '';
  if (numEl) numEl.textContent = num;
  if (unitEl) unitEl.textContent = unit;
}

/**
 * @param {HTMLElement} root .hvflow container
 * @param {object} m metrics: power, load, grid_export_live, grid_import_live
 * @param {object} fmt { fmtPowerSmart }
 * @param {object} [battery] { soc, power }
 */
export function updateFlowCard(
  root: HTMLElement | null | undefined,
  m: FlowMetrics,
  fmt: FlowFmt,
  battery: FlowBattery | null = null,
): void {
  if (!root) return;
  const power = Math.max(0, m.power ?? 0);
  const load = Math.max(0, m.load ?? 0);
  const exp = Math.max(0, m.grid_export_live ?? 0);
  const imp = Math.max(0, m.grid_import_live ?? 0);
  const solarToHome = Math.max(0, power - exp);
  const fmtP = fmt?.fmtPowerSmart || ((v: number | null | undefined) => `${(v ?? 0).toFixed(1)} kW`);

  const gridVal = imp > exp ? imp : exp;
  const gridMode = imp > exp ? 'import' : 'export';

  _setValue(root, 'solar', fmtP(power));
  _setValue(root, 'home', fmtP(load));
  _setValue(root, 'grid', fmtP(gridVal));

  const gridNode = root.querySelector('[data-node="grid"]') as HTMLElement | null;
  if (gridNode) {
    gridNode.dataset.mode = gridMode;
    const gridGlow = gridMode === 'export' ? 'url(#hvflow-glow-grid-export)' : 'url(#hvflow-glow-grid-import)';
    gridNode.querySelectorAll('[data-glow="grid"]').forEach((el) => el.setAttribute('fill', gridGlow));
  }

  _setNodeActive(root, 'solar', power);
  _setNodeActive(root, 'home', load);
  _setNodeActive(root, 'grid', gridVal);
  _setHomeSource(root, computeHomeSource(solarToHome, imp, load));

  _setFlow(root, 'solar_home', solarToHome > TH, solarToHome);
  _setFlow(root, 'solar_grid', exp > TH, exp);
  _setFlow(root, 'grid_home', imp > TH, imp);

  if (battery && root.dataset.showBattery === 'true') {
    const bp = battery.power ?? 0;
    _setValue(root, 'battery', battery.soc != null ? `${Math.round(battery.soc)}%` : fmtP(bp));
    _setNodeActive(root, 'battery', battery.soc != null ? 1 : Math.abs(bp));
    const charging = bp < -TH;
    const discharging = bp > TH;
    _setFlow(root, 'solar_battery', charging, Math.abs(bp));
    _setFlow(root, 'battery_home', discharging, Math.abs(bp));
  }
}
