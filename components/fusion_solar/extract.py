"""FusionSolar entity extraction — aligned with HomeAssistant-FusionSolar field maps."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable

from integrations.entity_utils import finalize_entities as _finalize, slugify as _slugify

# Device type IDs (Huawei Northbound API)
DEV_STRING_INVERTER = 1
DEV_EMI = 10
DEV_GRID_METER = 17
DEV_RESIDENTIAL_INVERTER = 38
DEV_BATTERY = 39
DEV_C_I_ESS = 41
DEV_POWER_SENSOR = 47

_SUPPORTED_DEV_TYPES = {
    DEV_STRING_INVERTER,
    DEV_EMI,
    DEV_GRID_METER,
    DEV_RESIDENTIAL_INVERTER,
    DEV_BATTERY,
    DEV_C_I_ESS,
    DEV_POWER_SENSOR,
}


@dataclass(frozen=True)
class KpiField:
    key: str
    label: str
    unit: str
    kind: str = "number"
    domain: str = "sensor"


def _pv_voltage(n: int) -> KpiField:
    return KpiField(f"pv{n}_u", f"PV{n} tensiune intrare", "V", "voltage")


def _pv_current(n: int) -> KpiField:
    return KpiField(f"pv{n}_i", f"PV{n} curent intrare", "A", "current")


def _mppt_cap(n: int) -> KpiField:
    return KpiField(f"mppt_{n}_cap", f"MPPT {n} producție DC totală", "kWh", "energy")


def _phase_voltages(prefix: str = "Tensiune") -> list[KpiField]:
    return [
        KpiField("ab_u", f"{prefix} AB", "V", "voltage"),
        KpiField("bc_u", f"{prefix} BC", "V", "voltage"),
        KpiField("ca_u", f"{prefix} CA", "V", "voltage"),
        KpiField("a_u", f"{prefix} faza A", "V", "voltage"),
        KpiField("b_u", f"{prefix} faza B", "V", "voltage"),
        KpiField("c_u", f"{prefix} faza C", "V", "voltage"),
    ]


def _phase_currents() -> list[KpiField]:
    return [
        KpiField("a_i", "Curent faza A", "A", "current"),
        KpiField("b_i", "Curent faza B", "A", "current"),
        KpiField("c_i", "Curent faza C", "A", "current"),
    ]


def _phase_powers_kw() -> list[KpiField]:
    return [
        KpiField("active_power_a", "Putere activă PA", "kW", "power_kw"),
        KpiField("active_power_b", "Putere activă PB", "kW", "power_kw"),
        KpiField("active_power_c", "Putere activă PC", "kW", "power_kw"),
    ]


def _phase_powers_w() -> list[KpiField]:
    return [
        KpiField("active_power_a", "Putere activă PA", "W", "power_w"),
        KpiField("active_power_b", "Putere activă PB", "W", "power_w"),
        KpiField("active_power_c", "Putere activă PC", "W", "power_w"),
    ]


def _phase_reactive_kvar() -> list[KpiField]:
    return [
        KpiField("reactive_power_a", "Putere reactivă QA", "kVar", "reactive_kvar"),
        KpiField("reactive_power_b", "Putere reactivă QB", "kVar", "reactive_kvar"),
        KpiField("reactive_power_c", "Putere reactivă QC", "kVar", "reactive_kvar"),
    ]


def _tou_active_energy(prefix: str, key_prefix: str) -> list[KpiField]:
    return [
        KpiField(f"{key_prefix}_peak", f"{prefix} (vârf)", "kWh", "energy"),
        KpiField(f"{key_prefix}_power", f"{prefix} (zi)", "kWh", "energy"),
        KpiField(f"{key_prefix}_valley", f"{prefix} (noapte)", "kWh", "energy"),
        KpiField(f"{key_prefix}_top", f"{prefix} (critical)", "kWh", "energy"),
    ]


def _inverter_core(max_pv: int, max_mppt: int) -> list[KpiField]:
    fields: list[KpiField] = [
        KpiField("inverter_state", "Stare invertor", "", "translated"),
        *_phase_voltages("Tensiune rețea"),
        *_phase_currents(),
        KpiField("efficiency", "Eficiență invertor", "%", "percent"),
        KpiField("temperature", "Temperatură internă invertor", "°C", "temperature"),
        KpiField("power_factor", "Factor de putere", "%", "power_factor"),
        KpiField("elec_freq", "Frecvență rețea", "Hz", "frequency"),
        KpiField("active_power", "Putere activă", "kW", "power_kw"),
        KpiField("reactive_power", "Putere reactivă", "kVar", "reactive_kvar"),
        KpiField("day_cap", "Producție azi", "kWh", "energy_increasing"),
        KpiField("mppt_power", "Putere totală MPPT", "kW", "power_kw"),
    ]
    fields.extend(_pv_voltage(i) for i in range(1, max_pv + 1))
    fields.extend(_pv_current(i) for i in range(1, max_pv + 1))
    fields.append(KpiField("total_cap", "Producție totală", "kWh", "energy_increasing"))
    fields.extend(_mppt_cap(i) for i in range(1, max_mppt + 1))
    fields.extend([
        KpiField("open_time", "Pornire invertor", "", "timestamp"),
        KpiField("close_time", "Oprire invertor", "", "timestamp"),
        KpiField("run_state", "Status", "", "run_state", "binary_sensor"),
    ])
    return fields


def _grid_meter_fields() -> list[KpiField]:
    fields: list[KpiField] = [
        *_phase_voltages("Tensiune rețea"),
        *_phase_currents(),
        KpiField("active_power", "Putere activă", "kW", "power_kw"),
        KpiField("power_factor", "Factor de putere", "%", "power_factor"),
        KpiField("active_cap", "Energie activă (forward)", "kWh", "energy"),
        KpiField("reactive_power", "Putere reactivă", "kVar", "reactive_kvar"),
        KpiField("reverse_active_cap", "Energie activă inversă", "kWh", "energy"),
        KpiField("forward_reactive_cap", "Energie reactivă forward", "kWh", "energy"),
        KpiField("reverse_reactive_cap", "Energie reactivă inversă", "kWh", "energy"),
        *_phase_powers_kw(),
        *_phase_reactive_kvar(),
        KpiField("total_apparent_power", "Putere aparentă totală", "kVA", "apparent"),
        KpiField("grid_frequency", "Frecvență rețea", "Hz", "frequency"),
    ]
    fields.extend(_tou_active_energy("Energie activă inversă", "reverse_active"))
    fields.extend(_tou_active_energy("Energie activă forward", "positive_active"))
    fields.extend(_tou_active_energy("Energie reactivă inversă", "reverse_reactive"))
    fields.extend(_tou_active_energy("Energie reactivă forward", "positive_reactive"))
    return fields


def _power_sensor_fields() -> list[KpiField]:
    fields: list[KpiField] = [
        KpiField("meter_status", "Stare contor", "", "translated"),
        KpiField("meter_u", "Tensiune rețea", "V", "voltage"),
        KpiField("meter_i", "Curent rețea", "A", "current"),
        KpiField("active_power", "Putere activă", "W", "power_w"),
        KpiField("reactive_power", "Putere reactivă", "var", "reactive_var"),
        KpiField("power_factor", "Factor de putere", "%", "power_factor"),
        KpiField("grid_frequency", "Frecvență rețea", "Hz", "frequency"),
        KpiField("active_cap", "Energie activă (forward)", "kWh", "energy"),
        KpiField("reverse_active_cap", "Energie activă inversă", "kWh", "energy"),
        KpiField("run_state", "Status", "", "run_state", "binary_sensor"),
        *_phase_voltages("Tensiune linie"),
        *_phase_currents(),
        KpiField("forward_reactive_cap", "Energie reactivă pozitivă", "kWh", "energy"),
        KpiField("reverse_reactive_cap", "Energie reactivă negativă", "kWh", "energy"),
        *_phase_powers_w(),
        *_phase_reactive_kvar(),
        KpiField("total_apparent_power", "Putere aparentă totală", "kVA", "apparent"),
    ]
    fields.extend(_tou_active_energy("Energie activă negativă", "reverse_active"))
    fields.extend(_tou_active_energy("Energie activă pozitivă", "positive_active"))
    fields.extend(_tou_active_energy("Energie reactivă negativă", "reverse_reactive"))
    fields.extend(_tou_active_energy("Energie reactivă pozitivă", "positive_reactive"))
    return fields


def _battery_fields() -> list[KpiField]:
    return [
        KpiField("battery_status", "Stare baterie", "", "translated"),
        KpiField("max_charge_power", "Putere maximă încărcare", "W", "power_w"),
        KpiField("max_discharge_power", "Putere maximă descărcare", "W", "power_w"),
        KpiField("ch_discharge_power", "Putere încărcare/descărcare", "W", "power_w"),
        KpiField("busbar_u", "Tensiune baterie", "V", "voltage"),
        KpiField("battery_soc", "Stare încărcare (SOC)", "%", "percent"),
        KpiField("battery_soh", "Sănătate baterie (SOH)", "%", "percent"),
        KpiField("ch_discharge_model", "Mod încărcare/descărcare", "", "translated"),
        KpiField("charge_cap", "Capacitate încărcare", "kWh", "energy_increasing"),
        KpiField("discharge_cap", "Capacitate descărcare", "kWh", "energy_increasing"),
        KpiField("run_state", "Status", "", "run_state", "binary_sensor"),
    ]


def _emi_fields() -> list[KpiField]:
    return [
        KpiField("temperature", "Temperatură", "°C", "temperature"),
        KpiField("pv_temperature", "Temperatură PV", "°C", "temperature"),
        KpiField("wind_speed", "Viteză vânt", "m/s", "wind"),
        KpiField("wind_direction", "Direcție vânt", "°", "number"),
        KpiField("radiant_total", "Iradiere zilnică", "kWh/m²", "energy"),
        KpiField("radiant_line", "Iradiere", "W/m²", "number"),
        KpiField("horiz_radiant_line", "Iradiere orizontală", "W/m²", "number"),
        KpiField("horiz_radiant_total", "Iradiere orizontală zilnică", "kWh/m²", "energy"),
        KpiField("run_state", "Status", "", "run_state", "binary_sensor"),
    ]


def _ess_fields() -> list[KpiField]:
    return [
        KpiField("ch_discharge_power", "Putere încărcare/descărcare", "W", "power_w"),
        KpiField("battery_soc", "Stare încărcare (SOC)", "%", "percent"),
        KpiField("battery_soh", "Sănătate baterie (SOH)", "%", "percent"),
        KpiField("charge_cap", "Capacitate încărcare", "kWh", "energy_increasing"),
        KpiField("discharge_cap", "Capacitate descărcare", "kWh", "energy_increasing"),
        KpiField("run_state", "Status", "", "run_state", "binary_sensor"),
    ]


def device_kpi_schema(device_type_id: int | None) -> list[KpiField]:
    tid = int(device_type_id or 0)
    if tid == DEV_STRING_INVERTER:
        return _inverter_core(24, 10)
    if tid == DEV_RESIDENTIAL_INVERTER:
        return _inverter_core(8, 4)
    if tid == DEV_GRID_METER:
        return _grid_meter_fields()
    if tid == DEV_POWER_SENSOR:
        return _power_sensor_fields()
    if tid == DEV_BATTERY:
        return _battery_fields()
    if tid == DEV_C_I_ESS:
        return _ess_fields()
    if tid == DEV_EMI:
        return _emi_fields()
    return []


def _fusion_attrs(device_id: str, device_name: str, model: str = "") -> dict[str, str]:
    return {
        "device_id": device_id,
        "device_name": device_name,
        "device_model": model,
        "device_manufacturer": "Huawei FusionSolar",
    }


def _station_attrs(station: dict[str, Any], idx: int) -> dict[str, str]:
    station_code = str(station.get("station_code") or f"station_{idx}").strip()
    station_name = str(station.get("station_name") or station_code or f"Stație {idx}").strip()
    return _fusion_attrs(f"fusion_solar_station_{_slugify(station_code)}", station_name, "Station")


def _safe_float(value: Any) -> float | None:
    if value is None or value == "" or value == "N/A":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _api_has_value(value: Any) -> bool:
    return _safe_float(value) is not None if isinstance(value, (int, float, str)) else value not in (None, "", "N/A")


def _normalize_kpi_number(value: Any, spec: KpiField, device_type_id: int | None) -> float | None:
    numeric = _safe_float(value)
    if numeric is None:
        return None
    tid = int(device_type_id or 0)
    kind = spec.kind

    if kind in {"power_kw"}:
        if tid == DEV_GRID_METER and abs(numeric) > 50:
            numeric /= 1000.0
        return numeric
    if kind == "reactive_kvar":
        return numeric * 1000.0
    if kind == "power_factor":
        return numeric * 100.0
    return numeric


def _format_kpi_state(value: Any, spec: KpiField, device_type_id: int | None) -> tuple[str, str]:
    if spec.kind == "run_state":
        numeric = _safe_float(value)
        if numeric is None:
            return "unknown", spec.unit
        if numeric == 1:
            return "on", spec.unit
        if numeric == 0:
            return "off", spec.unit
        return str(int(numeric)), spec.unit

    if spec.kind == "translated":
        numeric = _safe_float(value)
        if numeric is None:
            return "unknown", spec.unit
        return str(int(numeric)), spec.unit

    if spec.kind == "timestamp":
        numeric = _safe_float(value)
        if numeric is None:
            return "unknown", spec.unit
        return f"{int(numeric)}", spec.unit

    numeric = _normalize_kpi_number(value, spec, device_type_id)
    if numeric is None:
        return "unknown", spec.unit
    if spec.kind in {"percent", "power_factor"}:
        return f"{numeric:.1f}".rstrip("0").rstrip("."), spec.unit
    if abs(numeric) >= 100:
        return f"{numeric:.0f}", spec.unit
    return f"{numeric:.2f}".rstrip("0").rstrip("."), spec.unit


def _humanize_kpi_key(key: str) -> str:
    return re.sub(r"\s+", " ", key.replace("_", " ")).strip().title()


def _infer_extra_unit(key: str) -> str:
    lowered = key.lower()
    if lowered.endswith("_u") or "_u_" in lowered:
        return "V"
    if lowered.endswith("_i") or "_i_" in lowered:
        return "A"
    if "power" in lowered and "cap" not in lowered:
        return "kW"
    if lowered.endswith("_cap") or "energy" in lowered:
        return "kWh"
    if "freq" in lowered:
        return "Hz"
    if "temp" in lowered:
        return "°C"
    if lowered.endswith("_soc") or lowered.endswith("_soh") or "efficiency" in lowered:
        return "%"
    return ""


def _append_sensor(
    items: list[dict[str, Any]],
    *,
    entity_id: str,
    name: str,
    state: str,
    unit: str,
    domain: str,
    attrs: dict[str, Any],
    aliases: list[str] | None = None,
) -> None:
    items.append({
        "entity_id": entity_id,
        "name": name,
        "state": state,
        "domain": domain,
        "source": "fusion_solar",
        "aliases": [a for a in (aliases or [name]) if a],
        "unit": unit,
        "controllable": False,
        "attributes": attrs,
    })


def _append_device_static_entities(items: list[dict[str, Any]], dev: dict[str, Any], dev_attrs: dict[str, str]) -> None:
    dev_id = str(dev.get("device_id") or "")
    dev_name = str(dev.get("device_name") or dev_id)
    static_fields = [
        ("device_id", "ID device", dev_id, ""),
        ("device_name", "Nume device", dev_name, ""),
        ("station_code", "Cod stație", dev.get("station_code") or "", ""),
        ("esn_code", "Număr serial", dev.get("esn_code") or "", ""),
        ("device_type_id", "Tip device (ID)", dev.get("device_type_id"), ""),
        ("device_type", "Tip device", dev.get("device_type") or "", ""),
        ("latitude", "Latitudine", dev.get("latitude"), "°"),
        ("longitude", "Longitudine", dev.get("longitude"), "°"),
    ]
    if dev.get("device_type_id") in (DEV_STRING_INVERTER, DEV_RESIDENTIAL_INVERTER):
        static_fields.append(("inverter_type", "Model invertor", dev.get("inverter_type") or "", ""))

    always = {"device_id", "device_name", "device_type", "device_type_id", "station_code", "station_name"}
    for suffix, label, raw, unit in static_fields:
        if suffix not in always and not _api_has_value(raw):
            continue
        if raw in (None, ""):
            state = "unknown"
        elif isinstance(raw, float):
            state = f"{raw:.6f}".rstrip("0").rstrip(".")
        else:
            state = str(raw)
        _append_sensor(
            items,
            entity_id=f"fusion_solar:device:{dev_id}:{suffix}",
            name=f"{dev_name} • {label}",
            state=state,
            unit=unit,
            domain="sensor",
            attrs=dev_attrs,
            aliases=[f"{dev_name} {label}"],
        )


def _append_device_kpi_entities(items: list[dict[str, Any]], dev: dict[str, Any], dev_attrs: dict[str, str]) -> None:
    dev_id = str(dev.get("device_id") or "")
    dev_name = str(dev.get("device_name") or dev_id)
    dev_type_id = dev.get("device_type_id")
    if dev_type_id not in _SUPPORTED_DEV_TYPES:
        return

    kpi = dev.get("realtime_kpi") if isinstance(dev.get("realtime_kpi"), dict) else {}
    schema = device_kpi_schema(dev_type_id)
    seen_keys: set[str] = set()

    for spec in schema:
        seen_keys.add(spec.key)
        raw = kpi.get(spec.key)
        if not _api_has_value(raw):
            continue
        state, unit = _format_kpi_state(raw, spec, dev_type_id)
        if state == "unknown":
            continue
        _append_sensor(
            items,
            entity_id=f"fusion_solar:device:{dev_id}:{spec.key}",
            name=f"{dev_name} • {spec.label}",
            state=state,
            unit=unit or spec.unit,
            domain=spec.domain,
            attrs={**dev_attrs, "kpi_key": spec.key},
            aliases=[f"{dev_name} {spec.label}"],
        )

    for key, raw in sorted(kpi.items()):
        if key in seen_keys or raw in (None, "", "N/A"):
            continue
        state, _ = _format_kpi_state(raw, KpiField(key, _humanize_kpi_key(key), _infer_extra_unit(key), "number"), dev_type_id)
        if state == "unknown":
            continue
        _append_sensor(
            items,
            entity_id=f"fusion_solar:device:{dev_id}:{key}",
            name=f"{dev_name} • {_humanize_kpi_key(key)}",
            state=state,
            unit=_infer_extra_unit(key),
            domain="sensor",
            attrs={**dev_attrs, "kpi_key": key, "auto_discovered": True},
            aliases=[f"{dev_name} {key}"],
        )


def extract_fusion_solar_candidates(payload: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if not isinstance(payload, dict):
        return items

    summary = payload.get("summary") or {}
    summary_attrs = _fusion_attrs("fusion_solar_summary", "Fusion Solar", "Plant summary")
    summary_metrics = [
        ("realtime_power", "Fusion Solar • Putere live", summary.get("realtime_power_kw"), "kW"),
        ("daily_energy", "Fusion Solar • Producție azi", summary.get("daily_energy_kwh"), "kWh"),
        ("month_energy", "Fusion Solar • Producție lună", summary.get("month_energy_kwh"), "kWh"),
        ("yearly_energy", "Fusion Solar • Producție an", summary.get("yearly_energy_kwh"), "kWh"),
        ("lifetime_energy", "Fusion Solar • Producție totală", summary.get("lifetime_energy_kwh"), "kWh"),
    ]
    for suffix, label, value, unit in summary_metrics:
        if value is None:
            continue
        _append_sensor(
            items,
            entity_id=f"fusion_solar:{suffix}",
            name=label,
            state=f"{float(value):.2f}",
            unit=unit,
            domain="sensor",
            attrs=summary_attrs,
            aliases=[label, suffix.replace("_", " ")],
        )

    station_count = summary.get("station_count")
    if station_count is not None:
        _append_sensor(
            items,
            entity_id="fusion_solar:station_count",
            name="Fusion Solar • Nr. stații",
            state=str(station_count),
            unit="",
            domain="sensor",
            attrs=summary_attrs,
            aliases=["station count", "numar statii"],
        )

    status = summary.get("status")
    if status:
        _append_sensor(
            items,
            entity_id="fusion_solar:status",
            name="Fusion Solar • Status",
            state=str(status),
            unit="",
            domain="sensor",
            attrs=summary_attrs,
            aliases=["solar status", "status"],
        )

    realtime = payload.get("realtime") or []
    station_attrs_by_code: dict[str, dict[str, str]] = {}
    for idx, station in enumerate(realtime[:12], start=1):
        if not isinstance(station, dict):
            continue
        station_name = str(station.get("station_name") or station.get("station_code") or f"Stație {idx}").strip()
        station_code = str(station.get("station_code") or f"station_{idx}").strip()
        attrs = _station_attrs(station, idx)
        station_attrs_by_code[station_code] = attrs
        prefix = f"fusion_solar:station_{idx}"

        for suffix, label, raw, unit in (
            ("station_code", "Cod stație", station_code, ""),
            ("station_name", "Nume stație", station_name, ""),
            ("station_address", "Adresă stație", station.get("station_address") or "", ""),
            ("capacity", "Capacitate", station.get("capacity_kw"), "kW"),
            ("contact_person", "Persoană contact", station.get("contact_person") or "", ""),
            ("contact_phone", "Telefon contact", station.get("contact_phone") or "", ""),
        ):
            if suffix not in {"station_code", "station_name"} and not _api_has_value(raw):
                continue
            if raw in (None, ""):
                continue
            if isinstance(raw, float):
                state = f"{raw:.2f}"
            else:
                state = str(raw)
            _append_sensor(
                items,
                entity_id=f"{prefix}_{suffix}",
                name=f"{station_name} • {label}",
                state=state,
                unit=unit,
                domain="sensor",
                attrs=attrs,
                aliases=[f"{station_name} {label}"],
            )

        station_metrics = [
            ("power", "Putere live", station.get("realtime_power_kw"), "kW"),
            ("load", "Locuință live", station.get("load_power_kw"), "kW"),
            ("grid", "Rețea live", station.get("grid_power_kw"), "kW"),
            ("grid_import", "Tras din rețea", station.get("grid_import_power_kw"), "kW"),
            ("grid_export", "Injectat în rețea", station.get("grid_export_power_kw"), "kW"),
            ("daily", "Producție azi", station.get("daily_energy_kwh"), "kWh"),
            ("monthly", "Producție lună", station.get("month_energy_kwh"), "kWh"),
            ("yearly", "Producție an", station.get("yearly_energy_kwh"), "kWh"),
            ("lifetime", "Producție totală", station.get("lifetime_energy_kwh"), "kWh"),
            ("feed_in", "Energie injectată", station.get("feed_in_energy_kwh"), "kWh"),
            ("consumption", "Consum", station.get("consumption_kwh"), "kWh"),
            ("revenue", "Venit", station.get("revenue"), "RON"),
        ]
        for suffix, label, value, unit in station_metrics:
            if not _api_has_value(value):
                continue
            state = f"{float(value):.2f}"
            _append_sensor(
                items,
                entity_id=f"{prefix}_{suffix}",
                name=f"{station_name} • {label}",
                state=state,
                unit=unit,
                domain="sensor",
                attrs=attrs,
                aliases=[f"{station_name} {label}"],
            )

    yearly_current = payload.get("yearly_current") or {}
    current_year_fields = [
        ("installed_capacity", "Capacitate instalată (an curent)", "kW"),
        ("radiation_intensity", "Radiație globală (an curent)", "kWh/m²"),
        ("theory_power", "Producție teoretică (an curent)", "kWh"),
        ("performance_ratio", "Raport performanță (an curent)", ""),
        ("inverter_power", "Producție invertor (an curent)", "kWh"),
        ("ongrid_power", "Energie injectată (an curent)", "kWh"),
        ("use_power", "Consum (an curent)", "kWh"),
        ("power_profit", "Venit (an curent)", "RON"),
        ("perpower_ratio", "Energie specifică (an curent)", "kWh/kWp"),
        ("reduction_total_co2", "Reducere CO₂ (an curent)", "kg"),
        ("reduction_total_coal", "Cărbune economisit (an curent)", "kg"),
        ("reduction_total_tree", "Copaci echivalent (an curent)", ""),
    ]
    for code, year_data in yearly_current.items():
        if not isinstance(year_data, dict):
            continue
        attrs = station_attrs_by_code.get(str(code)) or _fusion_attrs(f"fusion_solar_station_{_slugify(str(code))}", str(code), "Station")
        for field, label, unit in current_year_fields:
            value = year_data.get(field)
            if value is None:
                continue
            numeric = float(value)
            if field in {"reduction_total_co2", "reduction_total_coal"}:
                numeric *= 1000
            _append_sensor(
                items,
                entity_id=f"fusion_solar:{code}:year_{field}",
                name=f"Fusion Solar • {label}",
                state=f"{numeric:.2f}",
                unit=unit,
                domain="sensor",
                attrs=attrs,
                aliases=[label, f"{field} an curent"],
            )

    yearly_lifetime = payload.get("yearly_lifetime") or {}
    lifetime_fields = [
        ("inverter_power", "Producție invertor (total)", "kWh"),
        ("ongrid_power", "Energie injectată (total)", "kWh"),
        ("use_power", "Consum (total)", "kWh"),
        ("power_profit", "Venit (total)", "RON"),
        ("perpower_ratio", "Energie specifică (total)", "kWh/kWp"),
        ("reduction_total_co2", "Reducere CO₂ (total)", "kg"),
        ("reduction_total_coal", "Cărbune economisit (total)", "kg"),
        ("reduction_total_tree", "Copaci echivalent (total)", ""),
    ]
    for code, life_data in yearly_lifetime.items():
        if not isinstance(life_data, dict):
            continue
        attrs = station_attrs_by_code.get(str(code)) or _fusion_attrs(f"fusion_solar_station_{_slugify(str(code))}", str(code), "Station")
        for field, label, unit in lifetime_fields:
            value = life_data.get(field)
            if value is None:
                continue
            numeric = float(value)
            if field in {"reduction_total_co2", "reduction_total_coal"}:
                numeric *= 1000
            _append_sensor(
                items,
                entity_id=f"fusion_solar:{code}:lifetime_{field}",
                name=f"Fusion Solar • {label}",
                state=f"{numeric:.2f}",
                unit=unit,
                domain="sensor",
                attrs=attrs,
                aliases=[label, f"{field} lifetime"],
            )

    devices = payload.get("devices") or []
    for dev in devices:
        if not isinstance(dev, dict):
            continue
        dev_id = str(dev.get("device_id") or "")
        dev_name = str(dev.get("device_name") or dev_id)
        dev_type = str(dev.get("device_type") or "")
        dev_attrs = _fusion_attrs(f"fusion_solar_device_{_slugify(dev_id)}", dev_name, dev_type or "Device")
        _append_sensor(
            items,
            entity_id=f"fusion_solar:device:{dev_id}",
            name=f"{dev_name} ({dev_type})",
            state=dev_type or "unknown",
            unit="",
            domain="sensor",
            attrs=dev_attrs,
            aliases=[dev_name, str(dev.get("esn_code") or "")],
        )
        _append_device_static_entities(items, dev, dev_attrs)
        _append_device_kpi_entities(items, dev, dev_attrs)

    from integrations.fusion_solar_power_flow import append_power_flow_entities

    append_power_flow_entities(
        items,
        realtime=realtime,
        devices=devices,
        station_attrs_by_code=station_attrs_by_code,
    )

    return _finalize(items, default_source="fusion_solar")
