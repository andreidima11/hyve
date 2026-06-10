/**
 * <hv-card-fusion-solar> — Huawei FusionSolar energy overview card.
 */
import { HyveviewCardBase } from '../../core/card-base.js';
import { host } from '../../host.js';
import {
  computeAutoconsumPct,
  renderFlowCard,
  updateFlowCard,
} from './power_flow.js';
import type { CardWidget, HyveviewEntityState } from '../../types/card-widget.js';
import type { HyveviewWidgetSpan } from '../../types/widget.js';

interface FusionSolarStateSnap {
  entity_id?: string;
  state?: unknown;
  unit?: string;
  available?: boolean;
  attributes?: Record<string, unknown>;
}

function normalizePowerKw(value: unknown, unit: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  if (value == null || value === '' || !Number.isFinite(n)) return null;
  const u = String(unit || '').trim().toLowerCase();
  if (u === 'w' || u === 'watt' || u === 'watts') return n / 1000;
  if (u === 'mw') return n * 1000;
  if (u === 'kw' || u === 'kilowatt' || u === 'kilowatts' || !u) {
    if (Math.abs(n) >= 100) return n / 1000;
    return n;
  }
  return n;
}

function _deviceFieldMap(prefix: string, sep: string): Record<string, string> {
  const join = (field: string) => (sep === ':' ? `${prefix}:${field}` : `${prefix}_${field}`);
  return {
    power: join('active_power'),
    daily: join('day_cap'),
    monthly: join('month_cap'),
    yearly: join('year_cap'),
    total: join('total_cap'),
    load: join('load_power'),
    grid: join('grid_power'),
    grid_export: join('reverse_active_cap'),
    grid_import: join('active_cap'),
  };
}

function _stationFieldMap(prefix: string, sep: string): Record<string, string> {
  const join = (field: string) => (sep === ':' ? `${prefix}:${field}` : `${prefix}_${field}`);
  return {
    power: join('power'),
    load: join('load'),
    grid: join('grid'),
    grid_export: join('grid_export'),
    grid_import: join('grid_import'),
    daily: join('daily'),
    monthly: join('monthly'),
    yearly: join('yearly'),
    lifetime: join('lifetime'),
    feed_in: join('feed_in'),
    consumption: join('consumption'),
  };
}

/** @returns {Record<string, string>} role → entity_id */
export function deriveFusionSolarEntityMap(powerEntityId: unknown) {
  const id = String(powerEntityId || '').trim();
  if (!id) return {};

  const devColon = id.match(/^(fusion_solar:device:\d+)(?::\w+)?$/);
  if (devColon) return _deviceFieldMap(devColon[1], ':');

  const devSensor = id.match(/^sensor\.fusion_solar_device_(\d+)(?:_\w+)?$/);
  if (devSensor) return _deviceFieldMap(`sensor.fusion_solar_device_${devSensor[1]}`, '_');

  const stColon = id.match(/^(fusion_solar:station_\d+)(?:[:_]\w+)?$/);
  if (stColon) return _stationFieldMap(stColon[1].replace(/:\w+$/, ''), ':');

  if (/_power$/.test(id) && id.includes('station_')) {
    const prefix = id.replace(/_power$/, '');
    return _stationFieldMap(prefix, '_');
  }

  if (/realtime_power/.test(id)) {
    const base = id.replace(/(:|_)realtime_power$/, '');
    const sep = id.includes(':') ? ':' : '_';
    return {
      power: id,
      daily: `${base}${sep}daily_energy`,
      monthly: `${base}${sep}month_energy`,
      yearly: `${base}${sep}yearly_energy`,
      lifetime: `${base}${sep}lifetime_energy`,
    };
  }

  return { power: id };
}

function _stationPrefixFromSources(...sourceLists: unknown[]) {
  for (const raw of sourceLists.flat()) {
    const id = typeof raw === 'string' ? raw : String((raw as { entity_id?: string })?.entity_id || '');
    const m = id.match(/^(sensor\.fusion_solar_station_\d+|fusion_solar:station_\d+)/);
    if (m) return m[1];
  }
  return 'sensor.fusion_solar_station_1';
}

/** Flow entities for a station prefix, e.g. sensor.fusion_solar_station_1 */
function inferStationFlowEntities(stationPrefix: unknown) {
  const prefix = String(stationPrefix || '').trim();
  if (!prefix) return {};
  const sep = prefix.includes(':') ? ':' : '_';
  const join = (field: string) => (sep === ':' ? `${prefix}:${field}` : `${prefix}_${field}`);
  return {
    load: join('flow_consumption'),
    from_solar: join('flow_from_solar'),
    grid_export: join('flow_grid_export'),
    grid_import: join('flow_grid_import'),
    flow_production: join('flow_production'),
  };
}

function _assignFlowEntities(
  pool: unknown[],
  assign: (eid: string, role: string) => void,
  rolesTaken: Set<string>,
  isMapped: (eid: string) => boolean,
) {
  const flowMap = [
    ['flow_consumption', 'load'],
    ['flow_from_solar', 'from_solar'],
    ['flow_grid_export', 'grid_export'],
    ['flow_grid_import', 'grid_import'],
    ['flow_production', 'flow_production'],
  ];
  for (const raw of pool) {
    const eid = String(raw || '').trim();
    if (!eid || isMapped(eid)) continue;
    const lower = eid.toLowerCase();
    for (const [needle, role] of flowMap) {
      if (!lower.includes(needle) || rolesTaken.has(role)) continue;
      assign(eid, role);
      rolesTaken.add(role);
      break;
    }
  }
}

/** Guess metric role from entity_id suffix (for config.entity_ids auto-map). */
function _guessRoleFromEntityId(entityId: string): string | null {
  const id = String(entityId || '').toLowerCase();
  if (!id) return null;
  if (/active_power|realtime_power|(?:^|[_:])power$/.test(id) && !/use_power|ongrid/.test(id)) return 'power';
  if (/load_power|(?:^|[_:])load$/.test(id)) return 'load';
  if (/grid_export|reverse_active/.test(id)) return 'grid_export';
  if (/grid_import/.test(id)) return 'grid_import';
  if (/grid_power|(?:^|[_:])grid$/.test(id)) return 'grid';
  if (/day_cap|daily_energy|(?:^|[_:])daily$/.test(id)) return 'daily';
  if (/month_cap|month_energy|(?:^|[_:])monthly$/.test(id)) return 'monthly';
  if (/year_cap|year_energy|(?:^|[_:])yearly$/.test(id)) return 'yearly';
  if (/feed_in|ongrid_power/.test(id)) return 'feed_in';
  if (/consumption|use_power/.test(id)) return 'consumption';
  if (/flow_consumption/.test(id)) return 'load';
  if (/flow_grid_export/.test(id)) return 'grid_export';
  if (/flow_grid_import/.test(id)) return 'grid_import';
  if (/flow_from_solar/.test(id)) return 'from_solar';
  if (/flow_production/.test(id)) return 'flow_production';
  return null;
}

export function fusionSolarEntityIdsFromPower(powerEntityId: unknown) {
  const seen = new Set<string>();
  for (const eid of Object.values(deriveFusionSolarEntityMap(powerEntityId))) {
    if (eid) seen.add(eid);
  }
  return Array.from(seen);
}

export const CONFIG_SLOTS = {
  entity_load: 'load',
  entity_grid: 'grid',
  entity_grid_export: 'grid_export',
  entity_grid_import: 'grid_import',
};

/** All entity ids a fusion_solar widget may subscribe to. */
export function fusionSolarWidgetEntityIds(widget: CardWidget | null | undefined) {
  if (!widget) return [];
  const cfg = (widget.config && typeof widget.config === 'object' ? widget.config : {}) as Record<string, unknown>;
  const ids = new Set<string>();
  const add = (raw: unknown) => {
    const id = typeof raw === 'string' ? raw.trim() : String((raw as { entity_id?: string })?.entity_id || '').trim();
    if (id) ids.add(id);
  };
  if (Array.isArray(cfg.power_entities)) cfg.power_entities.forEach(add);
  add(widget.entity_id);
  Object.keys(CONFIG_SLOTS).forEach((k) => add(cfg[k]));
  if (Array.isArray(cfg.entity_ids)) cfg.entity_ids.forEach(add);
  if (Array.isArray(cfg.entities)) cfg.entities.forEach(add);
  const firstPower = [...ids][0] || widget.entity_id;
  if (firstPower) fusionSolarEntityIdsFromPower(firstPower).forEach((id) => ids.add(id));
  const stationPrefix = _stationPrefixFromSources(
    cfg.entity_ids,
    Array.isArray(cfg.entities) ? cfg.entities.map((e) => (typeof e === 'string' ? e : e?.entity_id)) : [],
    widget.entity_id,
    cfg.power_entities,
  );
  // Subscribe only to the flow entities for THIS widget's station (detected
  // from config, defaulting to station_1). Previously this also brute-forced
  // stations 1–12 (~60 speculative ids per card), bloating the WS fast-path
  // and entity-patch work for every fusion_solar widget.
  for (const eid of Object.values(inferStationFlowEntities(stationPrefix))) {
    if (eid) ids.add(eid);
  }
  return Array.from(ids);
}

function _parseNum(raw: unknown): number | null {
  const m = String(raw ?? '').match(/^(-?\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const _normalizePowerKw = normalizePowerKw;

function _fmtNum(n: unknown, digits = 1): string {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 100) return String(Math.round(v));
  return v.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d)0+$/, '$1');
}

function _fmtEnergy(n: unknown): string {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(1)} MWh`;
  return `${_fmtNum(v, v >= 10 ? 0 : 1)} kWh`;
}

function _fmtPowerKw(n: unknown): string {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return '—';
  return `${_fmtNum(v, Math.abs(v) >= 10 ? 0 : 1)} kW`;
}

function _fmtPowerSmart(kw: unknown): string {
  const v = typeof kw === 'number' ? kw : Number(kw);
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) < 1) return `${Math.round(Math.abs(v) * 1000)} W`;
  const n = Math.abs(v);
  const txt = n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace('.', ',');
  return `${txt} kW`;
}

const METRICS = {
  live: [
    { key: 'power', label: 'Producție', unit: 'kW', fmt: _fmtPowerKw, cls: 'solar' },
    { key: 'load', label: 'Consum', unit: 'kW', fmt: _fmtPowerKw, cls: 'home' },
    { key: 'grid_export_live', label: 'Livrat rețea', unit: 'kW', fmt: _fmtPowerKw, cls: 'export' },
  ],
};

export class HyveviewFusionSolarCard extends HyveviewCardBase {
  protected _entityRoleMap: Record<string, string> = {};
  protected _powerByEntity: Record<string, FusionSolarStateSnap> = {};
  protected _powerEntityIds: string[] = [];
  protected _states: Record<string, FusionSolarStateSnap> = {};
  static meta = {
    name: 'Fusion Solar',
    description: 'Flux energie live — panouri, rețea, consum.',
    icon: '☀️',
  };
  static schema = {
    fields: [
      {
        key: 'power_entities',
        label: 'Producție live (kW)',
        type: 'multi_entity',
        hint: 'Invertoare / senzor putere stație. Se adună dacă sunt mai mulți.',
      },
      {
        key: 'entity_load',
        label: 'Consum live (kW)',
        type: 'entity',
        domains: ['sensor'],
        hint: 'Opțional — se deduce din flow_* dacă lipsește.',
      },
      {
        key: 'entity_grid_export',
        label: 'Injectat live (kW)',
        type: 'entity',
        domains: ['sensor'],
      },
      { key: 'title', label: 'Titlu card', type: 'string', placeholder: 'Opțional — lasă gol fără titlu' },
      { key: 'capacity_kw', label: 'Capacitate (kWp)', type: 'number', placeholder: 'Opțional' },
    ],
  };
  static getStubConfig(entityId?: string) {
    const ents = entityId ? [{ entity_id: entityId, title: '', subtitle: '' }] : [];
    return { power_entities: ents, title: '', capacity_kw: '' };
  }

  setConfig(widget: CardWidget | null | undefined) {
    this._config = widget || {};
    this._states = {};
    this._powerByEntity = {};
    this._buildMaps(widget);
    this._seedStates(widget);
    this._render();
    this._applyState();
  }

  setState(entity: HyveviewEntityState | null) {
    if (!entity?.entity_id) return;
    const eid = entity.entity_id;
    const role = this._entityRoleMap[eid];
    if (!role) return;
    const snap: FusionSolarStateSnap = {
      entity_id: eid,
      state: entity.state,
      unit: String(entity.unit || ''),
      available: entity.available !== false,
      attributes: { ...(role === 'power' ? this._powerByEntity[eid]?.attributes : this._states[role]?.attributes) || {}, ...(entity.attributes || {}) },
    };
    if (role === 'power') {
      this._powerByEntity[eid] = snap;
      this._states.power = snap;
      const cfg = (this._config || {}) as CardWidget;
      cfg.current_state = entity.state;
      if (entity.unit) cfg.unit = entity.unit;
      cfg.available = entity.available !== false;
      this._config = cfg;
    } else {
      this._states[role] = snap;
    }
    this._applyState();
  }

  _buildMaps(widget: CardWidget | null | undefined) {
    const cfg = (widget?.config && typeof widget.config === 'object' ? widget.config : {}) as Record<string, unknown>;
    this._powerEntityIds = [];
    this._entityRoleMap = {};

    const assign = (eid: unknown, role: string) => {
      const id = String(eid || '').trim();
      if (!id || !role) return;
      if (role === 'power') {
        if (!this._powerEntityIds.includes(id)) this._powerEntityIds.push(id);
      }
      if (!this._entityRoleMap[id]) this._entityRoleMap[id] = role;
    };

    if (Array.isArray(cfg.power_entities)) {
      cfg.power_entities.forEach((e) => assign(typeof e === 'string' ? e : e?.entity_id, 'power'));
    }
    if (!this._powerEntityIds.length && widget?.entity_id) assign(widget.entity_id, 'power');

    for (const [cfgKey, role] of Object.entries(CONFIG_SLOTS)) {
      assign(cfg[cfgKey], role);
    }

    const pool: unknown[] = [];
    if (Array.isArray(cfg.entity_ids)) pool.push(...cfg.entity_ids);
    if (Array.isArray(cfg.entities)) {
      cfg.entities.forEach((e) => pool.push(typeof e === 'string' ? e : (e as { entity_id?: string })?.entity_id));
    }

    const rolesTaken = new Set<string>(Object.values(this._entityRoleMap));

    const monthlySlot = _stationPrefixFromSources(
      pool,
      widget?.entity_id,
      cfg.power_entities,
    );
    for (const [role, eid] of Object.entries(inferStationFlowEntities(monthlySlot))) {
      if (rolesTaken.has(role)) continue;
      assign(eid, role);
      rolesTaken.add(role);
    }

    for (const idx of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      if (rolesTaken.has('flow_production')) break;
      assign(`sensor.fusion_solar_station_${idx}_flow_production`, 'flow_production');
      rolesTaken.add('flow_production');
    }

    _assignFlowEntities(pool, assign, rolesTaken, (eid) => Boolean(this._entityRoleMap[eid]));

    const derived = deriveFusionSolarEntityMap(this._powerEntityIds[0] || widget?.entity_id || '');
    for (const [role, eid] of Object.entries(derived)) {
      if (role === 'power') continue;
      if (rolesTaken.has(role)) continue;
      assign(eid, role);
      rolesTaken.add(role);
    }

    for (const raw of pool) {
      const eid = String(raw || '').trim();
      if (!eid || this._entityRoleMap[eid]) continue;
      const role = _guessRoleFromEntityId(eid);
      if (role && role !== 'power' && !rolesTaken.has(role)) {
        assign(eid, role);
        rolesTaken.add(role);
      }
    }
  }

  _seedStates(widget: CardWidget | null | undefined) {
    if (!widget) return;
    const cfg = (widget.config && typeof widget.config === 'object' ? widget.config : {}) as Record<string, unknown>;
    const ingest = (ent: FusionSolarStateSnap & { current_state?: unknown }) => {
      if (!ent?.entity_id) return;
      const role = this._entityRoleMap[ent.entity_id];
      if (!role) return;
      const snap: FusionSolarStateSnap = {
        entity_id: ent.entity_id,
        state: ent.state ?? ent.current_state ?? '—',
        unit: String(ent.unit || ''),
        available: ent.available !== false,
        attributes: (ent.attributes && typeof ent.attributes === 'object' ? ent.attributes : {}) as Record<string, unknown>,
      };
      if (role === 'power') this._powerByEntity[ent.entity_id] = snap;
      this._states[role] = snap;
    };
    if (Array.isArray(widget.entities)) widget.entities.forEach(ingest);
    if (Array.isArray(cfg.entities)) cfg.entities.forEach((ent) => ingest(typeof ent === 'string' ? { entity_id: ent } : ent));
    if (widget.entity_id && widget.current_state != null && !this._powerByEntity[widget.entity_id]) {
      const snap: FusionSolarStateSnap = {
        entity_id: String(widget.entity_id),
        state: widget.current_state,
        unit: String(widget.unit || 'kW'),
        available: widget.available !== false,
        attributes: (widget.attributes && typeof widget.attributes === 'object' ? widget.attributes : {}) as Record<string, unknown>,
      };
      this._powerByEntity[widget.entity_id] = snap;
      this._states.power = snap;
    }
  }

  _snapKw(snap: FusionSolarStateSnap | undefined) {
    return _normalizePowerKw(_parseNum(snap?.state), snap?.unit);
  }

  _stateValKw(role: string) {
    if (role === 'power') return this._powerSum();
    const snap = this._states[role];
    return this._snapKw(snap);
  }

  _flowProductionKw() {
    const kw = this._stateValKw('flow_production');
    if (kw != null) return kw;
    for (const [eid, role] of Object.entries(this._entityRoleMap || {})) {
      if (!/flow_production/.test(eid)) continue;
      const v = this._stateValKw(role);
      if (v != null) return v;
    }
    return null;
  }

  _powerSum() {
    if (this._powerEntityIds.length > 1) {
      let sum = 0;
      let any = false;
      for (const eid of this._powerEntityIds) {
        const v = this._snapKw(this._powerByEntity[eid]);
        if (v != null) { sum += v; any = true; }
      }
      return any ? sum : null;
    }
    return this._snapKw(this._states.power);
  }

  _stateVal(role: string) {
    if (role === 'power') return this._powerSum();
    return _parseNum(this._states[role]?.state);
  }

  _computedMetrics() {
    const flowProd = this._flowProductionKw();
    const rawPower = this._stateValKw('power') ?? 0;
    const power = flowProd ?? rawPower;
    const load = this._stateValKw('load');
    const fromSolarLive = this._stateValKw('from_solar');
    const gridExport = this._stateValKw('grid_export');
    const gridImport = this._stateValKw('grid_import');
    const grid = this._stateValKw('grid');

    let gridExportLive = gridExport;
    if (gridExportLive == null && grid != null && grid > 0) gridExportLive = grid;
    let gridImportLive = gridImport;
    if (gridImportLive == null && grid != null && grid < 0) gridImportLive = -grid;

    const producing = power > 0.05;
    const exporting = (gridExportLive ?? 0) > 0.05;

    return {
      power,
      load,
      from_solar_live: fromSolarLive,
      grid_export_live: gridExportLive,
      grid_import_live: gridImportLive,
      producing,
      exporting,
    };
  }

  _metricHtml(
    section: string,
    metrics: Array<{ key: string; label: string; unit?: string; cls: string }>,
    escape: (s: unknown) => string,
  ) {
    return metrics.map((m) => `
      <div class="hv-fsolar__metric hv-fsolar__metric--${m.cls}" data-metric="${m.key}">
        <span class="hv-fsolar__metric-label">${escape(m.label)}</span>
        <strong class="hv-fsolar__metric-value" data-val="${m.key}">—</strong>
        ${m.unit ? `<span class="hv-fsolar__metric-unit">${escape(m.unit)}</span>` : ''}
      </div>`).join('');
  }

  _displayTitle() {
    const w = (this._config || {}) as CardWidget;
    const raw = Object.prototype.hasOwnProperty.call(w, 'title')
      ? String(w.title ?? '').trim()
      : '';
    if (!raw) return '';
    // Legacy saves back-filled entity_id as title — treat as blank.
    if (raw.startsWith('sensor.') || raw.startsWith('fusion_solar:')) return '';
    return raw;
  }

  _resolvedTitle() {
    const w = (this._config || {}) as CardWidget;
    const rawTitle = String(w.title || '').trim();
    const titleLooksLikeId = !rawTitle || rawTitle.startsWith('sensor.') || rawTitle.startsWith('fusion_solar:');
    if (!titleLooksLikeId) return rawTitle;
    const attrs = this._states.power?.attributes || {};
    const name = attrs.device_name || attrs.friendly_name || w.entity_name || '';
    const cleaned = String(name).replace(/\s*•\s*Putere (activă|live)\s*$/i, '').trim();
    if (cleaned && !cleaned.startsWith('sensor.') && !cleaned.startsWith('fusion_solar:')) return cleaned;
    return 'Fusion Solar';
  }

  _t(key: string, params?: Record<string, unknown>) {
    const fn = typeof host.t === 'function' ? host.t : null;
    if (fn) {
      const out = fn(key, params);
      if (out && out !== key) return out;
    }
    const fallbacks = {
      'fsolar.status_idle': 'Inactiv',
      'fsolar.status_production': 'Producție',
      'fsolar.status_consumption': 'Consum',
      'fsolar.status_export': 'Injectezi {kw}',
      'fsolar.status_import': 'Import {kw}',
      'fsolar.status_autoconsum': 'Autoconsum {pct}%',
    };
    let str = fallbacks[key as keyof typeof fallbacks] || key;
    if (params && typeof params === 'object') {
      for (const [k, v] of Object.entries(params)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v ?? ''));
      }
    }
    return str;
  }

  _flowMetrics(m: ReturnType<HyveviewFusionSolarCard['_computedMetrics']>) {
    const power = Math.max(0, m.power ?? 0);
    const load = Math.max(0, m.load ?? 0);
    const exp = Math.max(0, m.grid_export_live ?? 0);
    const imp = Math.max(0, m.grid_import_live ?? 0);
    const solarToHome = Math.max(0, power - exp);
    return { power, load, exp, imp, solarToHome };
  }

  _statusChip(m: ReturnType<HyveviewFusionSolarCard['_computedMetrics']>) {
    const { load, imp, solarToHome } = this._flowMetrics(m);
    const fmt = (v: unknown) => _fmtPowerSmart(v);
    if (load <= 0.05 && (m.power ?? 0) <= 0.05) {
      return { text: this._t('fsolar.status_idle'), mode: 'idle' };
    }
    if (m.producing && m.exporting) {
      return { text: this._t('fsolar.status_export', { kw: fmt(m.grid_export_live) }), mode: 'export' };
    }
    if (m.producing && load > 0.05) {
      const pct = computeAutoconsumPct(solarToHome, imp, load);
      if (pct != null) {
        return { text: this._t('fsolar.status_autoconsum', { pct }), mode: 'solar' };
      }
    }
    if (imp > 0.05) {
      return { text: this._t('fsolar.status_import', { kw: fmt(imp) }), mode: 'import' };
    }
    if (load > 0.05) {
      return { text: this._t('fsolar.status_consumption'), mode: 'import' };
    }
    if (m.producing) {
      return { text: this._t('fsolar.status_production'), mode: 'solar' };
    }
    return { text: this._t('fsolar.status_idle'), mode: 'idle' };
  }

  _hasBattery() {
    const cfg = (this._config?.config && typeof this._config.config === 'object' ? this._config.config : {}) as Record<string, unknown>;
    return Boolean(String(cfg.entity_battery || '').trim());
  }

  _batteryState() {
    const cfg = (this._config?.config && typeof this._config.config === 'object' ? this._config.config : {}) as Record<string, unknown>;
    if (!String(cfg.entity_battery || '').trim()) return null;
    const power = this._stateValKw('battery');
    const soc = this._stateVal('battery_soc');
    return {
      power: power ?? undefined,
      soc: soc ?? undefined,
    };
  }

  _render() {
    const w = (this._config || {}) as CardWidget;
    const escape = host.escape;
    const span = (w._span && typeof w._span === 'object' ? w._span : { row: 2, col: 2 }) as HyveviewWidgetSpan;
    const title = this._displayTitle();
    const nameClass = title ? 'hv-fsolar__name' : 'hv-fsolar__name hidden';

    this.innerHTML = `
      <div class="hv-fsolar hv-fsolar--flow"
        data-span-row="${span.row}" data-span-col="${span.col}">
        <div class="hv-fsolar__top hv-fsolar__top--flow">
          <span class="${nameClass}" data-title>${escape(title)}</span>
          <span class="hv-fsolar__chip" data-status>—</span>
        </div>
        ${renderFlowCard({ showBattery: this._hasBattery() })}
      </div>`;
  }

  _updateFlow(m: ReturnType<HyveviewFusionSolarCard['_computedMetrics']>) {
    const root = this.querySelector('.hvflow') as HTMLElement | null;
    if (!root) return;
    updateFlowCard(root, {
      power: m.power,
      load: m.load ?? 0,
      grid_export_live: m.grid_export_live ?? 0,
      grid_import_live: m.grid_import_live ?? 0,
    }, { fmtPowerSmart: _fmtPowerSmart }, this._batteryState());
  }

  _setMetric(key: string, text: string) {
    this.querySelectorAll(`[data-val="${key}"]`).forEach((el) => { el.textContent = text; });
  }

  _applyState() {
    const w = (this._config || {}) as CardWidget;
    const m = this._computedMetrics();

    const titleEl = this.querySelector('[data-title]');
    if (titleEl) titleEl.textContent = this._displayTitle();

    const statusEl = this.querySelector('[data-status]');
    if (statusEl) {
      const chip = this._statusChip(m);
      statusEl.textContent = chip.text;
      (statusEl as HTMLElement).dataset.mode = chip.mode;
    }

    this._updateFlow(m);

    const article = this.parentElement?.tagName === 'ARTICLE' ? this.parentElement : this.closest('article');
    if (article) {
      article.setAttribute('data-grid-export', m.exporting ? 'true' : 'false');
      article.setAttribute('data-unavailable', w.available === false ? 'true' : 'false');
    }
  }
}
