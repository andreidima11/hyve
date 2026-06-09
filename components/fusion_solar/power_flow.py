"""Computed live power-flow sensors for FusionSolar (HA template equivalent)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from integrations.component_import import import_sibling

_extract = import_sibling(Path(__file__).resolve().parent, "extract")

DEV_GRID_METER = _extract.DEV_GRID_METER
DEV_POWER_SENSOR = _extract.DEV_POWER_SENSOR
DEV_RESIDENTIAL_INVERTER = _extract.DEV_RESIDENTIAL_INVERTER
DEV_STRING_INVERTER = _extract.DEV_STRING_INVERTER
_append_sensor = _extract._append_sensor
_api_has_value = _extract._api_has_value
_fusion_attrs = _extract._fusion_attrs
_safe_float = _extract._safe_float
_slugify = _extract._slugify

_INVERTER_TYPES = {DEV_STRING_INVERTER, DEV_RESIDENTIAL_INVERTER}
_METER_TYPES = {DEV_GRID_METER, DEV_POWER_SENSOR}

_FLOW_FIELDS = (
    ("flow_production", "Producție solară", "kW"),
    ("flow_consumption", "Consum casă", "kW"),
    ("flow_grid_export", "Livrat în rețea", "kW"),
    ("flow_grid_import", "Tras din rețea", "kW"),
    ("flow_from_solar", "Din panouri", "kW"),
)


def _device_active_power_w(dev: dict[str, Any]) -> float | None:
    kpi = dev.get("realtime_kpi") if isinstance(dev.get("realtime_kpi"), dict) else {}
    raw = _safe_float(kpi.get("active_power"))
    if raw is None:
        return None
    tid = int(dev.get("device_type_id") or 0)
    if tid == DEV_POWER_SENSOR:
        return raw
    if tid == DEV_GRID_METER and abs(raw) > 50:
        raw /= 1000.0
    return raw * 1000.0


def compute_power_flow(
    *,
    inverters: list[dict[str, Any]],
    meter: dict[str, Any] | None,
    station: dict[str, Any] | None = None,
) -> dict[str, float | None]:
    """Return live power-flow metrics in kW."""
    inv_w = 0.0
    has_inv = False
    for dev in inverters:
        w = _device_active_power_w(dev)
        if w is None:
            continue
        inv_w += max(0.0, w)
        has_inv = True

    meter_w = _device_active_power_w(meter) if meter else None

    if meter_w is not None:
        export_w = max(0.0, meter_w)
        import_w = max(0.0, -meter_w)
        production_w = inv_w if has_inv else None
        consumption_w = None
        from_solar_w = None
        if has_inv:
            if export_w <= 0.05:
                consumption_w = import_w + inv_w
            else:
                consumption_w = import_w + inv_w - export_w
            from_solar_w = max(0.0, consumption_w - import_w)
        return {
            "flow_production": (production_w / 1000.0) if production_w is not None else None,
            "flow_grid_export": export_w / 1000.0,
            "flow_grid_import": import_w / 1000.0,
            "flow_consumption": (consumption_w / 1000.0) if consumption_w is not None else None,
            "flow_from_solar": (from_solar_w / 1000.0) if from_solar_w is not None else None,
        }

    st = station if isinstance(station, dict) else {}
    production = _safe_float(st.get("realtime_power_kw"))
    load = _safe_float(st.get("load_power_kw"))
    export = _safe_float(st.get("grid_export_power_kw"))
    import_kw = _safe_float(st.get("grid_import_power_kw"))
    grid = _safe_float(st.get("grid_power_kw"))
    if export is None and grid is not None and grid > 0:
        export = grid
    if import_kw is None and grid is not None and grid < 0:
        import_kw = -grid

    if not any(v is not None for v in (production, load, export, import_kw)):
        if has_inv:
            return {
                "flow_production": inv_w / 1000.0,
                "flow_consumption": inv_w / 1000.0,
                "flow_grid_export": None,
                "flow_grid_import": None,
                "flow_from_solar": inv_w / 1000.0,
            }
        return {}

    consumption = load
    if consumption is None and production is not None:
        export_v = export or 0.0
        import_v = import_kw or 0.0
        if export_v <= 0.05:
            consumption = import_v + production
        else:
            consumption = import_v + production - export_v

    from_solar = None
    if consumption is not None and import_kw is not None:
        from_solar = max(0.0, consumption - import_kw)
    elif consumption is not None and production is not None and (export or 0) <= 0.05:
        from_solar = min(consumption, production)

    prod_out = (inv_w / 1000.0) if has_inv else production
    return {
        "flow_production": prod_out,
        "flow_consumption": consumption,
        "flow_grid_export": export,
        "flow_grid_import": import_kw,
        "flow_from_solar": from_solar,
    }


def _group_devices_by_station(devices: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for dev in devices:
        if not isinstance(dev, dict):
            continue
        code = str(dev.get("station_code") or "").strip() or "_default"
        grouped.setdefault(code, []).append(dev)
    return grouped


def append_power_flow_entities(
    items: list[dict[str, Any]],
    *,
    realtime: list[dict[str, Any]],
    devices: list[dict[str, Any]],
    station_attrs_by_code: dict[str, dict[str, str]],
) -> None:
    """Emit ``fusion_solar:station_N_flow_*`` computed sensors per plant."""
    station_by_code = {
        str(st.get("station_code") or ""): st
        for st in realtime
        if isinstance(st, dict)
    }
    station_idx_by_code = {
        str(st.get("station_code") or ""): idx
        for idx, st in enumerate(realtime[:12], start=1)
        if isinstance(st, dict)
    }
    grouped = _group_devices_by_station(devices)

    seen_codes: set[str] = set()
    for code, devs in grouped.items():
        seen_codes.add(code)
        idx = station_idx_by_code.get(code)
        if idx is None and len(realtime) == 1:
            idx = 1
            code = str(realtime[0].get("station_code") or code)
        if idx is None:
            continue

        inverters = [d for d in devs if int(d.get("device_type_id") or 0) in _INVERTER_TYPES]
        meters = [d for d in devs if int(d.get("device_type_id") or 0) in _METER_TYPES]
        meter = meters[0] if meters else None
        station = station_by_code.get(code) or (realtime[idx - 1] if idx <= len(realtime) else None)

        flow = compute_power_flow(inverters=inverters, meter=meter, station=station)
        if not flow:
            continue

        station_name = str((station or {}).get("station_name") or code or f"Stație {idx}")
        attrs = station_attrs_by_code.get(code) or _fusion_attrs(
            f"fusion_solar_station_{_slugify(code or f'station_{idx}')}",
            station_name,
            "Power flow",
        )
        attrs = {
            **attrs,
            "computed": True,
            "power_flow": True,
            "meter_device_id": str(meter.get("device_id") or "") if meter else "",
            "inverter_device_ids": [str(d.get("device_id") or "") for d in inverters],
        }
        prefix = f"fusion_solar:station_{idx}"

        for suffix, label, unit in _FLOW_FIELDS:
            value = flow.get(suffix)
            if not _api_has_value(value):
                continue
            _append_sensor(
                items,
                entity_id=f"{prefix}_{suffix}",
                name=f"{station_name} • {label}",
                state=f"{float(value):.3f}".rstrip("0").rstrip("."),
                unit=unit,
                domain="sensor",
                attrs=attrs,
                aliases=[label, suffix.replace("_", " "), "power flow"],
            )

    if not seen_codes and realtime:
        st = realtime[0]
        code = str(st.get("station_code") or "")
        idx = 1
        inverters = [d for d in devices if int(d.get("device_type_id") or 0) in _INVERTER_TYPES]
        meters = [d for d in devices if int(d.get("device_type_id") or 0) in _METER_TYPES]
        flow = compute_power_flow(inverters=inverters, meter=(meters[0] if meters else None), station=st)
        if not flow:
            return
        station_name = str(st.get("station_name") or code or "Stație 1")
        attrs = station_attrs_by_code.get(code) or _fusion_attrs(
            f"fusion_solar_station_{_slugify(code or 'station_1')}",
            station_name,
            "Power flow",
        )
        attrs = {**attrs, "computed": True, "power_flow": True}
        prefix = f"fusion_solar:station_{idx}"
        for suffix, label, unit in _FLOW_FIELDS:
            value = flow.get(suffix)
            if not _api_has_value(value):
                continue
            _append_sensor(
                items,
                entity_id=f"{prefix}_{suffix}",
                name=f"{station_name} • {label}",
                state=f"{float(value):.3f}".rstrip("0").rstrip("."),
                unit=unit,
                domain="sensor",
                attrs=attrs,
                aliases=[label, suffix.replace("_", " "), "power flow"],
            )
