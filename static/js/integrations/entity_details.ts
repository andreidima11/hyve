import { t, getLanguage } from '../lang/index.js';
import { escapeHtml } from '../utils.js';
import type { EntityMetaDef, EntityMetaInfo } from '../types/features_integrations_settings.js';

const _ENTITY_META: Record<string, EntityMetaDef> = {
    profil:          { icon: 'fa-user',                labelKey: 'profil' },
    abonament:       { icon: 'fa-id-badge',            labelKey: 'abonament' },
    carduri:         { icon: 'fa-credit-card',         labelKey: 'carduri' },
    vehicule:        { icon: 'fa-car',                 labelKey: 'vehicule' },
    facturi:         { icon: 'fa-file-invoice-dollar', labelKey: 'facturi' },
    conturi_facturi: { icon: 'fa-building',            labelKey: 'conturi_facturi' },
    plati:           { icon: 'fa-receipt',             labelKey: 'plati' },
    summary:         { icon: 'fa-solar-panel',         labelKey: 'summary' },
    stations:        { icon: 'fa-industry',            labelKey: 'stations' },
    realtime:        { icon: 'fa-bolt',                labelKey: 'realtime' },
    yearly:          { icon: 'fa-chart-line',          labelKey: 'yearly' },
    yearly_current:  { icon: 'fa-calendar-check',      labelKey: 'yearly_current' },
    yearly_lifetime: { icon: 'fa-infinity',            labelKey: 'yearly_lifetime' },
    devices:         { icon: 'fa-microchip',           labelKey: 'devices' },
};

function _detailLocale(): string {
    return getLanguage() === 'ro' ? 'ro-RO' : 'en-US';
}

export function detailLocale(): string {
    return _detailLocale();
}

function _ed(key: string, params?: Record<string, unknown>) {
    return t('integrations.entity_detail.' + key, params);
}

export function entityDetailText(key: string, params?: Record<string, unknown>) {
    return _ed(key, params);
}

function _entityMeta(key: string): EntityMetaInfo {
    const meta = _ENTITY_META[key];
    if (meta) return { icon: meta.icon, label: _ed(meta.labelKey) };
    return { icon: 'fa-database', label: key };
}

export function entityMeta(key: string): EntityMetaInfo {
    return _entityMeta(key);
}

function _detailRow(labelKey: string, value: unknown) {
    if (value == null || value === '') return '';
    return `<div class="flex justify-between gap-2"><span class="text-slate-500">${escapeHtml(_ed(labelKey))}</span><span class="text-slate-300 text-right">${value}</span></div>`;
}

// ---- detail renderers per entity key ------------------------------------

function _fmtDateStr(s: string) {
    if (!s || s.length < 10) return s || '—';
    const d = new Date(s.slice(0, 10) + 'T00:00:00');
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString(_detailLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}
function _fmtTs(ms: number) {
    if (!ms) return '—';
    const d = new Date(ms);
    return d.toLocaleDateString(_detailLocale(), { day: '2-digit', month: 'short', year: 'numeric' });
}
function _daysUntil(dateStr: string) {
    if (!dateStr || dateStr.length < 10) return null;
    const d = new Date(dateStr.slice(0, 10) + 'T00:00:00');
    if (isNaN(d.getTime())) return null;
    const now = new Date(); now.setHours(0, 0, 0, 0);
    return Math.floor((d.getTime() - now.getTime()) / 86400000);
}

function _renderDetailProfil(data: Record<string, unknown>) {
    if (!data || data.error) return `<span class="text-red-400 text-[10px]">${escapeHtml(_ed('error'))}</span>`;
    return [
        _detailRow('field_name', `${data.nume || ''} ${data.prenume || ''}`.trim()),
        _detailRow('field_email', data.email),
        _detailRow('field_phone', data.telefon ? `+${data.telefon}` : null),
        _detailRow('field_id', data.pos_user_id),
        _detailRow('field_member_since', data.creat_la ? _fmtTs(Number(data.creat_la)) : null),
    ].join('');
}

function _renderDetailAbonament(data: Record<string, unknown>) {
    if (!data || data.error) return `<span class="text-red-400 text-[10px]">${escapeHtml(_ed('error'))}</span>`;
    const active = data.activ
        ? `<span class="text-emerald-400">${escapeHtml(_ed('active'))}</span>`
        : `<span class="text-red-400">${escapeHtml(_ed('inactive'))}</span>`;
    return [
        _detailRow('field_status', active),
        _detailRow('field_period', data.inceput && data.sfarsit ? `${data.inceput} → ${data.sfarsit}` : null),
        _detailRow('field_period_days', data.perioada_zile),
        _detailRow('field_bills_per_month', data.facturi_lunare != null ? `${data.plati_folosite ?? 0} / ${data.facturi_lunare}` : null),
        _detailRow('field_payments_remaining', data.plati_ramase != null ? `<span class="${Number(data.plati_ramase) > 0 ? 'text-emerald-400' : 'text-amber-400'}">${data.plati_ramase}</span>` : null),
    ].join('');
}

function _renderDetailCarduri(data: unknown[]) {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_cards'))}</span>`;
    return (data as Record<string, unknown>[]).map((c) => {
        const last4 = c.last4 || '????';
        const type = c.tip_card || '';
        const alias = c.alias || '';
        const active = c.activ !== false;
        const isDefault = c.default;
        const defaultBadge = isDefault ? ` <span class="text-orange-400 text-[9px]">${escapeHtml(_ed('default_badge'))}</span>` : '';
        return `<div class="flex items-center justify-between gap-2">`
            + `<span class="text-slate-300 font-mono">****${last4}</span>`
            + `<span class="text-slate-500">${type}${alias ? ' · ' + alias : ''}${defaultBadge}</span>`
            + `<span class="${active ? 'text-emerald-400' : 'text-red-400'} text-[9px]">${active ? '●' : '○'}</span>`
            + `</div>`;
    }).join('');
}

function _renderDetailVehicule(data: Record<string, unknown>): string {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_vehicles'))}</span>`;
    const alertLabels = {
        rca_expira: 'alert_rca', itp_expira: 'alert_itp',
        vinieta_expira: 'alert_vignette', rovinieta_expira: 'alert_vignette', casco_expira: 'alert_casco',
    };
    return data.map(v => {
        const plate = v.nr_inmatriculare || '?';
        const alerte = v.alerte || {};
        const rcaDays = _daysUntil(alerte.rca_expira);
        const itpDays = _daysUntil(alerte.itp_expira);
        let status = _ed('vehicle_status_ok'), statusCls = 'text-emerald-400';
        if (rcaDays !== null && rcaDays < 0) { status = _ed('vehicle_rca_expired'); statusCls = 'text-red-400'; }
        else if (itpDays !== null && itpDays < 0) { status = _ed('vehicle_itp_expired'); statusCls = 'text-red-400'; }
        else if (!alerte.rca_expira) { status = _ed('vehicle_no_rca'); statusCls = 'text-amber-400'; }
        const tags = [];
        for (const [key, labelKey] of Object.entries(alertLabels)) {
            const val = alerte[key];
            if (!val) continue;
            const days = _daysUntil(val);
            const dateStr = _fmtDateStr(val);
            let cls = 'text-emerald-400';
            let extra = '';
            if (days !== null) {
                if (days < 0) { cls = 'text-red-400'; extra = _ed('expired_suffix'); }
                else { extra = _ed('days_suffix', { days }); }
            }
            tags.push(`<span class="${cls}">${escapeHtml(_ed(labelKey))} ${dateStr}${escapeHtml(extra)}</span>`);
        }
        const notifs = [];
        if (alerte.rca_notificare_sms) notifs.push('SMS');
        if (alerte.rca_notificare_email) notifs.push('Email');
        const notifStr = notifs.length ? `<div class="text-[9px] text-slate-600">${escapeHtml(_ed('rca_notifications', { channels: notifs.join(', ') }))}</div>` : '';
        return `<div class="space-y-0.5 pb-1.5 ${data.indexOf(v) < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="flex items-center justify-between"><span class="text-slate-300 font-mono font-bold">${plate}</span><span class="${statusCls} text-[10px] font-semibold">${escapeHtml(status)}</span></div>`
            + `<div class="text-[10px] flex flex-wrap gap-x-1.5 gap-y-0.5">${tags.join('')}</div>`
            + notifStr
            + `</div>`;
    }).join('');
}

function _renderDetailFacturi(data: Record<string, unknown>): string {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_bills'))}</span>`;
    const total = data.reduce((s, b) => s + (b.suma_datorata || 0), 0);
    const today = new Date().toISOString().slice(0, 10);
    const restante = data.filter(b => b.scadenta && b.scadenta <= today).length;
    let header = `<div class="flex justify-between gap-2 pb-1 mb-1 border-b border-white/5">`
        + `<span class="text-slate-400">${escapeHtml(_ed('total_due'))}</span>`
        + `<span class="text-slate-200 font-mono font-bold">${total.toFixed(2)} RON</span></div>`;
    if (restante > 0) {
        header += `<div class="text-red-400 text-[10px] mb-1"><i class="fas fa-exclamation-triangle mr-1"></i>${escapeHtml(restante === 1 ? _ed('overdue_one') : _ed('overdue_many', { count: restante }))}</div>`;
    }
    return header + data.map(b => {
        const amt = b.suma_datorata != null ? `${b.suma_datorata.toFixed(2)} RON` : '—';
        const scad = b.scadenta || '—';
        const overdue = b.scadenta && b.scadenta <= today;
        const cls = overdue ? 'text-red-400' : 'text-slate-300';
        return `<div class="flex justify-between gap-2"><span class="${cls} font-mono">${amt}</span><span class="text-slate-500">${escapeHtml(_ed('due_on', { date: _fmtDateStr(scad) }))}${overdue ? ' <i class="fas fa-exclamation-triangle text-red-400 text-[9px] ml-1"></i>' : ''}</span></div>`;
    }).join('');
}

function _renderDetailConturiFurnizori(data: Record<string, unknown>): string {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_providers'))}</span>`;
    return data.map((c: Record<string, unknown>) => {
        const name = c.furnizor_nume || c.furnizor || '?';
        const loc = c.locatie || '';
        const suma = c.ultima_plata_suma;
        const dataPlata = c.ultima_plata_data ? _fmtDateStr(String(c.ultima_plata_data)) : '';
        const auto = c.auto_plata ? `<span class="text-blue-400 text-[9px] ml-1">${escapeHtml(_ed('auto_pay'))}</span>` : '';
        const when = dataPlata ? _ed('last_payment_on', { date: dataPlata }) : '';
        const paymentLine = suma != null
            ? `<div class="text-[10px] text-slate-400">${escapeHtml(_ed('last_payment', { amount: `${Number(suma).toFixed(2)} RON`, when }))}</div>`
            : '';
        return `<div class="space-y-0.5 pb-1 ${data.indexOf(c) < data.length - 1 ? 'border-b border-white/5 mb-1' : ''}">`
            + `<div class="flex items-center justify-between gap-2"><span class="text-slate-300 font-semibold">${name}</span>${auto}</div>`
            + (loc ? `<div class="text-[10px] text-slate-500"><i class="fas fa-map-marker-alt text-[8px] mr-1"></i>${loc}${c.tip_locatie ? ' · ' + c.tip_locatie : ''}</div>` : '')
            + paymentLine
            + `</div>`;
    }).join('');
}

function _renderDetailPlati(data: Record<string, unknown>): string {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_payments'))}</span>`;
    const typeKeys: Record<string, string> = { provider: 'payment_type_bill', rca: 'payment_type_rca', recharge: 'payment_type_recharge', vignette: 'payment_type_vignette' };
    const recent = data.slice(0, 12);
    return recent.map((p: Record<string, unknown>) => {
        const amt = p.suma != null ? `${Number(p.suma).toFixed(2)} RON` : (p.suma_platita != null ? `${Number(p.suma_platita).toFixed(2)} RON` : '—');
        const date = p.data ? _fmtDateStr(String(p.data)) : '—';
        const tipKey = String(p.tip || '');
        const type = typeKeys[tipKey] ? _ed(typeKeys[tipKey]) : tipKey;
        const furn = p.furnizor_nume || '';
        const loc = p.locatie || '';
        const ok = p.status === 'finalized';
        const label = furn || type || '?';
        return `<div class="flex items-center justify-between gap-1">`
            + `<span class="text-slate-300 font-mono text-[10px] shrink-0">${amt}</span>`
            + `<span class="text-slate-500 truncate text-[10px]">${escapeHtml(label)}${loc ? ' · ' + escapeHtml(loc) : ''}</span>`
            + `<span class="text-slate-600 text-[10px] shrink-0">${date}</span>`
            + `<span class="${ok ? 'text-emerald-400' : 'text-amber-400'} text-[9px] shrink-0">${ok ? '✓' : '…'}</span>`
            + `</div>`;
    }).join('')
        + (data.length > 12 ? `<div class="text-[10px] text-slate-600 text-center mt-1">${escapeHtml(_ed('older_payments', { count: data.length - 12 }))}</div>` : '');
}

type FusionDetailRow = [string, string | number | unknown];

function _fusionSummaryRows(item: Record<string, unknown>): FusionDetailRow[] {
    return [
        item.station_address ? ['field_address', item.station_address] : null,
        item.capacity_kw != null ? ['field_capacity', `${Number(item.capacity_kw).toFixed(2)} kW`] : null,
        item.realtime_power_kw != null ? ['field_live_power', `${Number(item.realtime_power_kw).toFixed(2)} kW`] : null,
        item.daily_energy_kwh != null ? ['field_daily_production', `${Number(item.daily_energy_kwh).toFixed(2)} kWh`] : null,
        item.month_energy_kwh != null ? ['field_monthly_production', `${Number(item.month_energy_kwh).toFixed(2)} kWh`] : null,
        item.yearly_energy_kwh != null ? ['field_yearly_production', `${Number(item.yearly_energy_kwh).toFixed(2)} kWh`] : null,
        item.lifetime_energy_kwh != null ? ['field_total_production', `${Number(item.lifetime_energy_kwh).toFixed(2)} kWh`] : null,
        item.feed_in_energy_kwh != null ? ['field_feed_in', `${Number(item.feed_in_energy_kwh).toFixed(2)} kWh`] : null,
        item.consumption_kwh != null ? ['field_consumption', `${Number(item.consumption_kwh).toFixed(2)} kWh`] : null,
        item.revenue != null ? ['field_revenue', `${Number(item.revenue).toFixed(2)} RON`] : null,
    ].filter(Boolean) as FusionDetailRow[];
}

function _fusionYearlyKpiRows(kpi: Record<string, unknown>): FusionDetailRow[] {
    return [
        kpi.installed_capacity != null ? ['field_installed_capacity', `${Number(kpi.installed_capacity).toFixed(2)} kW`] : null,
        kpi.radiation_intensity != null ? ['field_global_radiation', `${(Number(kpi.radiation_intensity) * 1000).toFixed(1)} Wh/m²`] : null,
        kpi.theory_power != null ? ['field_theoretical_production', `${Number(kpi.theory_power).toFixed(2)} kWh`] : null,
        kpi.performance_ratio != null ? ['field_performance_ratio', `${Number(kpi.performance_ratio).toFixed(3)}`] : null,
        kpi.inverter_power != null ? ['field_inverter_production', `${Number(kpi.inverter_power).toFixed(2)} kWh`] : null,
        kpi.ongrid_power != null ? ['field_feed_in', `${Number(kpi.ongrid_power).toFixed(2)} kWh`] : null,
        kpi.use_power != null ? ['field_consumption', `${Number(kpi.use_power).toFixed(2)} kWh`] : null,
        kpi.power_profit != null ? ['field_revenue', `${Number(kpi.power_profit).toFixed(2)} RON`] : null,
        kpi.perpower_ratio != null ? ['field_specific_energy', `${Number(kpi.perpower_ratio).toFixed(2)} kWh/kWp`] : null,
        kpi.reduction_total_co2 != null ? ['field_co2_reduction', `${(Number(kpi.reduction_total_co2) * 1000).toFixed(1)} kg`] : null,
        kpi.reduction_total_coal != null ? ['field_coal_saved', `${(Number(kpi.reduction_total_coal) * 1000).toFixed(1)} kg`] : null,
        kpi.reduction_total_tree != null ? ['field_tree_equivalent', `${Number(kpi.reduction_total_tree).toFixed(0)}`] : null,
    ].filter(Boolean) as FusionDetailRow[];
}

const _FUSION_KPI_KEYS: Record<string, [string, string]> = {
    active_power: ['kpi_active_power', 'kW'], day_cap: ['kpi_day_cap', 'kWh'],
    total_cap: ['kpi_total_cap', 'kWh'], efficiency: ['kpi_efficiency', '%'],
    temperature: ['kpi_temperature', '°C'], elec_freq: ['kpi_elec_freq', 'Hz'],
    power_factor: ['kpi_power_factor', ''], reactive_power: ['kpi_reactive_power', 'kVar'],
    mppt_power: ['kpi_mppt_power', 'kW'], battery_soc: ['kpi_battery_soc', '%'],
    battery_soh: ['kpi_battery_soh', '%'], ch_discharge_power: ['kpi_ch_discharge_power', 'W'],
    charge_cap: ['kpi_charge_cap', 'kWh'], discharge_cap: ['kpi_discharge_cap', 'kWh'],
    meter_u: ['kpi_meter_u', 'V'], meter_i: ['kpi_meter_i', 'A'],
    grid_frequency: ['kpi_grid_frequency', 'Hz'], active_cap: ['kpi_active_cap', 'kWh'],
    reverse_active_cap: ['kpi_reverse_active_cap', 'kWh'], inverter_state: ['kpi_inverter_state', ''],
    run_state: ['kpi_run_state', ''],
};

function _renderDetailFusionSummary(data: Record<string, unknown>): string {
    if (!data || typeof data !== 'object') return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_data'))}</span>`;
    const rows = [
        ['field_stations', data.station_count],
        ['field_live_power', data.realtime_power_kw != null ? `${Number(data.realtime_power_kw).toFixed(2)} kW` : null],
        ['field_daily_production', data.daily_energy_kwh != null ? `${Number(data.daily_energy_kwh).toFixed(2)} kWh` : null],
        ['field_monthly_production', data.month_energy_kwh != null ? `${Number(data.month_energy_kwh).toFixed(2)} kWh` : null],
        ['field_total_production', data.lifetime_energy_kwh != null ? `${Number(data.lifetime_energy_kwh).toFixed(2)} kWh` : null],
        ['field_status', data.status || null],
    ].filter(([, v]) => v !== null && v !== undefined && v !== '');
    return rows.map(([lk, v]) => _detailRow(String(lk), v)).join('');
}

function _renderDetailFusionStations(data: Record<string, unknown>): string {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_stations'))}</span>`;
    return data.map((item, i) => {
        const rows = _fusionSummaryRows(item as Record<string, unknown>);
        return `<div class="space-y-0.5 pb-1.5 ${i < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${escapeHtml(item.station_name || item.station_code || _ed('default_station'))}</div>`
            + rows.map(([lk, v]) => _detailRow(lk, v)).join('')
            + `</div>`;
    }).join('');
}

function _renderDetailFusionRealtime(data: Record<string, unknown>): string {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_live_data'))}</span>`;
    return data.map((item, i) => {
        const rows = [
            ['field_power', `${Number(item.realtime_power_kw || 0).toFixed(2)} kW`],
            ['field_today', `${Number(item.daily_energy_kwh || 0).toFixed(2)} kWh`],
            item.month_energy_kwh != null ? ['field_month', `${Number(item.month_energy_kwh).toFixed(2)} kWh`] : null,
            item.lifetime_energy_kwh != null ? ['field_total', `${Number(item.lifetime_energy_kwh).toFixed(2)} kWh`] : null,
        ].filter(Boolean) as FusionDetailRow[];
        return `<div class="space-y-0.5 pb-1.5 ${i < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${escapeHtml(String(item.station_name || item.station_code || _ed('default_station')))}</div>`
            + rows.map(([lk, v]) => _detailRow(lk, v)).join('')
            + `</div>`;
    }).join('');
}

function _renderDetailFusionYearly(data: Record<string, unknown>): string {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_yearly_data'))}</span>`;
    return data.map((item, i) => {
        if (!item || typeof item !== 'object') return '';
        const code = String(item.stationCode || '?');
        const kpi = (item.dataItemMap || {}) as Record<string, unknown>;
        const ct = item.collectTime as string | number | undefined;
        const yearLabel = ct ? new Date(ct).getFullYear() : '?';
        const rows = _fusionYearlyKpiRows(kpi as Record<string, unknown>);
        if (!rows.length) return '';
        return `<div class="space-y-0.5 pb-1.5 ${i < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${escapeHtml(code)} <span class="text-amber-400 text-xs ml-1">${escapeHtml(_ed('year_label', { year: yearLabel }))}</span></div>`
            + rows.map(([lk, v]) => _detailRow(lk, v)).join('')
            + `</div>`;
    }).filter(Boolean).join('') || `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_data'))}</span>`;
}

function _renderDetailFusionYearlyCurrent(data: Record<string, unknown>): string {
    if (!data || typeof data !== 'object' || !Object.keys(data).length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_current_year_data'))}</span>`;
    return Object.entries(data).map(([code, rawKpi], i, arr) => {
        const kpi = rawKpi as Record<string, unknown>;
        if (!kpi || typeof kpi !== 'object') return '';
        const ct = kpi.collect_time as string | number | undefined;
        const yearLabel = ct ? new Date(ct).getFullYear() : new Date().getFullYear();
        const rows = _fusionYearlyKpiRows(kpi as Record<string, unknown>);
        if (!rows.length) return '';
        return `<div class="space-y-0.5 pb-1.5 ${i < arr.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${escapeHtml(code)} <span class="text-amber-400 text-xs ml-1">${escapeHtml(_ed('year_label', { year: yearLabel }))}</span></div>`
            + rows.map(([lk, v]) => _detailRow(lk, v)).join('')
            + `</div>`;
    }).filter(Boolean).join('') || `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_data'))}</span>`;
}

function _renderDetailFusionYearlyLifetime(data: Record<string, unknown>): string {
    if (!data || typeof data !== 'object' || !Object.keys(data).length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_lifetime_data'))}</span>`;
    return Object.entries(data).map(([code, rawKpi], i, arr) => {
        const kpi = rawKpi as Record<string, unknown>;
        if (!kpi || typeof kpi !== 'object') return '';
        const rows = [
            (kpi as Record<string, unknown>).inverter_power != null ? ['field_inverter_production', `${Number((kpi as Record<string, unknown>).inverter_power).toFixed(2)} kWh`] : null,
            kpi.ongrid_power != null ? ['field_feed_in', `${Number(kpi.ongrid_power).toFixed(2)} kWh`] : null,
            kpi.use_power != null ? ['field_consumption', `${Number(kpi.use_power).toFixed(2)} kWh`] : null,
            kpi.power_profit != null ? ['field_revenue', `${Number(kpi.power_profit).toFixed(2)} RON`] : null,
            kpi.perpower_ratio != null ? ['field_specific_energy', `${Number(kpi.perpower_ratio).toFixed(2)} kWh/kWp`] : null,
            kpi.reduction_total_co2 != null ? ['field_co2_reduction', `${(Number(kpi.reduction_total_co2) * 1000).toFixed(1)} kg`] : null,
            kpi.reduction_total_coal != null ? ['field_coal_saved', `${(Number(kpi.reduction_total_coal) * 1000).toFixed(1)} kg`] : null,
            kpi.reduction_total_tree != null ? ['field_tree_equivalent', `${Number(kpi.reduction_total_tree).toFixed(0)}`] : null,
        ].filter(Boolean) as FusionDetailRow[];
        if (!rows.length) return '';
        return `<div class="space-y-0.5 pb-1.5 ${i < arr.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${escapeHtml(code)} <span class="text-purple-400 text-xs ml-1">${escapeHtml(_ed('lifetime_tag'))}</span></div>`
            + rows.map(([lk, v]) => _detailRow(lk, v)).join('')
            + `</div>`;
    }).filter(Boolean).join('') || `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_data'))}</span>`;
}

function _renderDetailFusionDevices(data: Record<string, unknown>): string {
    if (!Array.isArray(data) || !data.length) return `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_devices'))}</span>`;
    return data.map((dev, i) => {
        if (!dev || typeof dev !== 'object') return '';
        const devRec = dev as Record<string, unknown>;
        const kpi = (devRec.realtime_kpi || {}) as Record<string, unknown>;
        const infoRows = [
            devRec.device_type ? ['field_type', devRec.device_type] : null,
            devRec.esn_code ? ['field_serial', devRec.esn_code] : null,
            devRec.inverter_type ? ['field_inverter_model', devRec.inverter_type] : null,
            devRec.software_version ? ['field_software', devRec.software_version] : null,
            devRec.station_code ? ['field_station', devRec.station_code] : null,
        ].filter(Boolean) as FusionDetailRow[];
        const kpiRows = Object.entries(kpi).map(([k, v]) => {
            if (v == null) return null;
            const cfg = _FUSION_KPI_KEYS[k];
            const formatted = cfg && cfg[1] ? `${Number(v).toFixed(2)} ${cfg[1]}` : String(v);
            return { labelKey: cfg ? cfg[0] : null, rawKey: k, value: formatted };
        }).filter((row): row is { labelKey: string | null; rawKey: string; value: string } => row != null);
        type KpiRow = { labelKey: string | null; rawKey: string; value: string };
        const allRows: Array<FusionDetailRow | KpiRow> = [...infoRows, ...kpiRows];
        if (!allRows.length) return '';
        const rowHtml = (row: FusionDetailRow | KpiRow) => {
            if (Array.isArray(row)) return _detailRow(row[0], row[1]);
            if ('labelKey' in row && row.labelKey) return _detailRow(row.labelKey, row.value);
            if ('rawKey' in row) return `<div class="flex justify-between gap-2"><span class="text-slate-500">${escapeHtml(row.rawKey)}</span><span class="text-slate-300 text-right">${escapeHtml(row.value)}</span></div>`;
            return '';
        };
        return `<div class="space-y-0.5 pb-1.5 ${i < data.length - 1 ? 'border-b border-white/5 mb-1.5' : ''}">`
            + `<div class="text-slate-300 font-semibold">${escapeHtml(String(devRec.device_name || devRec.device_id || _ed('default_device')))} <span class="text-sky-400 text-xs ml-1">${escapeHtml(String(devRec.device_type || ''))}</span></div>`
            + allRows.map(rowHtml).join('')
            + `</div>`;
    }).filter(Boolean).join('') || `<span class="text-slate-500 text-[10px]">${escapeHtml(_ed('no_data'))}</span>`;
}

export const detailRenderers = {
    profil: _renderDetailProfil,
    abonament: _renderDetailAbonament,
    carduri: _renderDetailCarduri,
    vehicule: _renderDetailVehicule,
    facturi: _renderDetailFacturi,
    conturi_facturi: _renderDetailConturiFurnizori,
    plati: _renderDetailPlati,
    summary: _renderDetailFusionSummary,
    stations: _renderDetailFusionStations,
    realtime: _renderDetailFusionRealtime,
    yearly: _renderDetailFusionYearly,
    yearly_current: _renderDetailFusionYearlyCurrent,
    yearly_lifetime: _renderDetailFusionYearlyLifetime,
    devices: _renderDetailFusionDevices,
} as Record<string, (data: unknown) => string>;
