/**
 * Hyve Power Flow card — clean, fully self-contained SVG energy-flow diagram.
 *
 * Three nodes (solar top-center, grid bottom-left, home bottom-right) connected
 * by smooth gradient lines with animated dots whose speed scales with power.
 * Everything lives in one uniformly-scaled SVG (viewBox + xMidYMid meet) so the
 * geometry never drifts out of the dashboard grid cell.
 */

const VB_W = 360;
const VB_H = 264;

const NODES = {
  solar: { x: 180, y: 68, r: 41, icon: 'mdi-solar-power-variant', label: 'Panouri' },
  grid: { x: 66, y: 196, r: 41, icon: 'mdi-transmission-tower', label: 'Rețea' },
  home: { x: 294, y: 196, r: 41, icon: 'mdi-home-lightning-bolt', label: 'Casă' },
  battery: { x: 180, y: 232, r: 30, icon: 'mdi-battery-high', label: 'Baterie' },
};

/** Curved path between two node edges with a slight outward bow. */
function _edgePath(a, b, bow) {
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
  // Perpendicular offset for the bow.
  const px = -uy;
  const py = ux;
  const cx = mx + px * bow;
  const cy = my + py * bow;
  return `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
}

const LINES = {
  solar_grid: { d: _edgePath(NODES.solar, NODES.grid, -22), from: 'solar', to: 'grid' },
  solar_home: { d: _edgePath(NODES.solar, NODES.home, 22), from: 'solar', to: 'home' },
  grid_home: { d: _edgePath(NODES.grid, NODES.home, 26), from: 'grid', to: 'home' },
  solar_battery: { d: _edgePath(NODES.solar, NODES.battery, 0), from: 'solar', to: 'battery' },
  battery_home: { d: _edgePath(NODES.battery, NODES.home, 0), from: 'battery', to: 'home' },
};

const COLOR = {
  solar: 'var(--fsolar-solar)',
  grid: 'var(--fsolar-home)',
  gridExport: 'var(--fsolar-grid-export)',
  home: 'var(--fsolar-home)',
  battery: 'var(--fsolar-grid-export)',
};

const NODE_TINT = {
  solar: COLOR.solar,
  grid: COLOR.home,
  home: COLOR.home,
  battery: COLOR.battery,
};

function _node(id) {
  const n = NODES[id];
  const { x, y, r } = n;
  const C = 2 * Math.PI * r;
  // Top node (solar) gets its label above the circle; others below.
  const labelY = id === 'solar' ? y - r - 11 : y + r + 17;
  return `
    <g class="hvflow__node hvflow__node--${id}" data-node="${id}">
      <circle class="hvflow__halo" cx="${x}" cy="${y}" r="${r + 8}"/>
      <circle class="hvflow__fill" cx="${x}" cy="${y}" r="${r - 1}" fill="url(#hvflow-fill-${id})"/>
      <circle class="hvflow__track" cx="${x}" cy="${y}" r="${r}"/>
      <circle class="hvflow__ring" cx="${x}" cy="${y}" r="${r}"
        transform="rotate(-90 ${x} ${y})"
        stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="0" data-ring="${id}"/>
      <foreignObject x="${x - 17}" y="${(y - r * 0.66).toFixed(1)}" width="34" height="24">
        <div xmlns="http://www.w3.org/1999/xhtml" class="hvflow__icon">
          <span class="mdi ${n.icon}"></span>
        </div>
      </foreignObject>
      <text class="hvflow__value" x="${x}" y="${(y + r * 0.42).toFixed(1)}" text-anchor="middle">
        <tspan class="hvflow__num" data-num="${id}">—</tspan><tspan class="hvflow__unit" dx="2" data-unit="${id}"></tspan>
      </text>
      <text class="hvflow__label" x="${x}" y="${labelY.toFixed(1)}" text-anchor="middle">${n.label}</text>
    </g>`;
}

function _line(id) {
  const L = LINES[id];
  return `
    <g class="hvflow__flow" data-flow="${id}" data-active="false">
      <path id="hvflow-${id}" class="hvflow__line" d="${L.d}" vector-effect="non-scaling-stroke"
        stroke="url(#hvflow-grad-${id})"/>
      <circle class="hvflow__dot" r="3.6" data-dot="${id}">
        <animateMotion class="hvflow__motion" dur="2s" repeatCount="indefinite"
          rotate="auto" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
          <mpath href="#hvflow-${id}"/>
        </animateMotion>
      </circle>
      <circle class="hvflow__dot hvflow__dot--trail" r="2.2" data-dot="${id}">
        <animateMotion class="hvflow__motion" dur="2s" begin="-0.5s" repeatCount="indefinite"
          rotate="auto" keyPoints="0;1" keyTimes="0;1" calcMode="linear">
          <mpath href="#hvflow-${id}"/>
        </animateMotion>
      </circle>
    </g>`;
}

function _grad(id, c1, c2) {
  return `
    <linearGradient id="hvflow-grad-${id}" gradientUnits="userSpaceOnUse"
      x1="${NODES[LINES[id].from].x}" y1="${NODES[LINES[id].from].y}"
      x2="${NODES[LINES[id].to].x}" y2="${NODES[LINES[id].to].y}">
      <stop offset="0" stop-color="${c1}"/>
      <stop offset="1" stop-color="${c2}"/>
    </linearGradient>`;
}

function _fillGrad(id) {
  const c = NODE_TINT[id];
  return `
    <radialGradient id="hvflow-fill-${id}" cx="0.5" cy="0.42" r="0.62">
      <stop offset="0" stop-color="${c}" stop-opacity="0.22"/>
      <stop offset="0.6" stop-color="${c}" stop-opacity="0.07"/>
      <stop offset="1" stop-color="${c}" stop-opacity="0"/>
    </radialGradient>`;
}

export function renderFlowCard({ showBattery = false } = {}) {
  const lineIds = ['solar_grid', 'solar_home', 'grid_home'];
  const nodeIds = ['solar', 'grid', 'home'];
  if (showBattery) {
    lineIds.push('solar_battery', 'battery_home');
    nodeIds.push('battery');
  }

  const defs = [
    _grad('solar_grid', COLOR.solar, COLOR.gridExport),
    _grad('solar_home', COLOR.solar, COLOR.home),
    _grad('grid_home', COLOR.grid, COLOR.home),
    _grad('solar_battery', COLOR.solar, COLOR.battery),
    _grad('battery_home', COLOR.battery, COLOR.home),
    _fillGrad('solar'),
    _fillGrad('grid'),
    _fillGrad('home'),
    _fillGrad('battery'),
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

/** Map a power value (kW) to a dot animation duration in seconds. */
function _dur(kw) {
  const v = Math.min(Math.abs(kw || 0), 10);
  // 0.1 kW → slow (3s), 10 kW → fast (0.7s)
  return (3 - (v / 10) * 2.3).toFixed(2);
}

function _setFlow(root, id, active, kw, reverse = false) {
  const g = root.querySelector(`[data-flow="${id}"]`);
  if (!g) return;
  g.dataset.active = active ? 'true' : 'false';
  const motion = g.querySelector('.hvflow__motion');
  if (motion) {
    motion.setAttribute('dur', `${_dur(kw)}s`);
    motion.setAttribute('keyPoints', reverse ? '1;0' : '0;1');
  }
}

function _setRing(root, id, value, maxVal) {
  const ring = root.querySelector(`[data-ring="${id}"]`);
  const node = root.querySelector(`[data-node="${id}"]`);
  if (!ring) return;
  const r = NODES[id].r;
  const C = 2 * Math.PI * r;
  const frac = Math.max(0.04, Math.min(1, (Math.abs(value) || 0) / (maxVal || 1)));
  ring.style.strokeDashoffset = String(C * (1 - frac));
  if (node) node.dataset.active = (Math.abs(value) || 0) > TH ? 'true' : 'false';
}

function _setValue(root, id, text) {
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
export function updateFlowCard(root, m, fmt, battery = null) {
  if (!root) return;
  const power = Math.max(0, m.power ?? 0);
  const load = Math.max(0, m.load ?? 0);
  const exp = Math.max(0, m.grid_export_live ?? 0);
  const imp = Math.max(0, m.grid_import_live ?? 0);
  const solarToHome = Math.max(0, power - exp);
  const fmtP = fmt?.fmtPowerSmart || ((v) => `${(v ?? 0).toFixed(1)} kW`);

  const gridVal = imp > exp ? imp : exp;
  const gridMode = imp > exp ? 'import' : 'export';

  // Node values
  _setValue(root, 'solar', fmtP(power));
  _setValue(root, 'home', fmtP(load));
  _setValue(root, 'grid', fmtP(gridVal));

  // Grid node colour depends on direction.
  const gridNode = root.querySelector('[data-node="grid"]');
  if (gridNode) gridNode.dataset.mode = gridMode;
  const gridRing = root.querySelector('[data-ring="grid"]');
  if (gridRing) gridRing.dataset.mode = gridMode;

  // Rings scaled to the largest of the visible powers.
  const maxVal = Math.max(power, load, gridVal, 1);
  _setRing(root, 'solar', power, maxVal);
  _setRing(root, 'home', load, maxVal);
  _setRing(root, 'grid', gridVal, maxVal);

  // Flows.
  _setFlow(root, 'solar_home', solarToHome > TH, solarToHome);
  _setFlow(root, 'solar_grid', exp > TH, exp);
  // grid line is import (grid→home) when consuming; if exporting the solar_grid
  // line already shows the export direction, so dim grid→home.
  _setFlow(root, 'grid_home', imp > TH, imp);

  // Battery (optional).
  if (battery && root.dataset.showBattery === 'true') {
    const bp = battery.power ?? 0;
    _setValue(root, 'battery', battery.soc != null ? `${Math.round(battery.soc)}%` : fmtP(bp));
    _setRing(root, 'battery', battery.soc != null ? (battery.soc / 100) * maxVal : Math.abs(bp), maxVal);
    const charging = bp < -TH;
    const discharging = bp > TH;
    _setFlow(root, 'solar_battery', charging, Math.abs(bp));
    _setFlow(root, 'battery_home', discharging, Math.abs(bp));
  }
}
