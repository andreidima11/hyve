"""AI context formatter for FusionSolar payloads."""

from __future__ import annotations

from typing import Any


def format_fusion_solar_context(entities: dict[str, Any]) -> str:
    """Format FusionSolar entity data into a concise AI-readable block."""
    summary = entities.get("summary") or {}
    realtime = entities.get("realtime") or []
    yearly_current = entities.get("yearly_current") or {}
    devices = entities.get("devices") or []
    parts: list[str] = []

    if isinstance(summary, dict) and summary:
        power = summary.get("realtime_power_kw")
        daily = summary.get("daily_energy_kwh")
        month = summary.get("month_energy_kwh")
        lifetime = summary.get("lifetime_energy_kwh")
        if power is not None:
            parts.append(f"Putere live: {float(power):.2f} kW")
        if daily is not None:
            parts.append(f"Producție azi: {float(daily):.2f} kWh")
        if month is not None:
            parts.append(f"Producție lună: {float(month):.2f} kWh")
        if lifetime is not None:
            parts.append(f"Total viață: {float(lifetime):.2f} kWh")

    if isinstance(realtime, list) and realtime:
        stations = []
        for station in realtime[:5]:
            if not isinstance(station, dict):
                continue
            name = station.get("station_name") or station.get("station_code") or "Stație"
            power = station.get("realtime_power_kw")
            daily = station.get("daily_energy_kwh")
            label = str(name)
            if power is not None:
                label += f" {float(power):.2f} kW"
            if daily is not None:
                label += f", azi {float(daily):.2f} kWh"
            stations.append(label)
        if stations:
            parts.append("Stații: " + "; ".join(stations))

    if isinstance(yearly_current, dict) and yearly_current:
        for code, kpi in list(yearly_current.items())[:3]:
            yparts = []
            if kpi.get("inverter_power") is not None:
                yparts.append(f"producție {float(kpi['inverter_power']):.1f} kWh")
            if kpi.get("ongrid_power") is not None:
                yparts.append(f"injectat {float(kpi['ongrid_power']):.1f} kWh")
            if kpi.get("use_power") is not None:
                yparts.append(f"consum {float(kpi['use_power']):.1f} kWh")
            if yparts:
                parts.append(f"KPI an curent {code}: " + ", ".join(yparts))

    if isinstance(devices, list) and devices:
        dev_summary = []
        for dev in devices[:10]:
            if not isinstance(dev, dict):
                continue
            dev_summary.append(f"{dev.get('device_name', '?')} ({dev.get('device_type', '?')})")
        if dev_summary:
            parts.append(f"Dispozitive ({len(devices)}): " + ", ".join(dev_summary))

    if not parts:
        return ""
    return "[FusionSolar]\n" + "\n".join(parts)
