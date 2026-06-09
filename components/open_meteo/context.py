"""AI context formatter for Open-Meteo payloads."""

from __future__ import annotations

from typing import Any


def format_open_meteo_context(entities: dict[str, Any]) -> str:
    location_payloads = entities.get("locations") if isinstance(entities.get("locations"), list) else []
    if location_payloads:
        blocks: list[str] = []
        for payload in location_payloads[:4]:
            weather = payload.get("weather") if isinstance(payload, dict) else None
            if not isinstance(weather, dict) or not weather:
                continue
            location = str(weather.get("friendly_name") or weather.get("name") or "Weather").strip()
            temperature = weather.get("temperature")
            temperature_unit = str(weather.get("temperature_unit") or "").strip()
            condition = str(weather.get("condition") or weather.get("state") or "").strip()
            line = f"{location}: {temperature}{temperature_unit} • {condition}" if temperature is not None else f"{location}: {condition}"
            blocks.append(line.strip())
        return "[Open Meteo]\n" + "\n".join(blocks) if blocks else ""

    weather = entities.get("weather") or {}
    if not isinstance(weather, dict) or not weather:
        return ""

    parts: list[str] = []
    location = str(weather.get("friendly_name") or weather.get("name") or "Weather").strip()
    parts.append(f"Locație: {location}")

    temperature = weather.get("temperature")
    temperature_unit = str(weather.get("temperature_unit") or "").strip()
    condition = str(weather.get("condition") or weather.get("state") or "").strip()
    if temperature is not None:
        parts.append(f"Acum: {temperature}{temperature_unit} • {condition}")
    elif condition:
        parts.append(f"Acum: {condition}")

    humidity = weather.get("humidity")
    if humidity is not None:
        parts.append(f"Umiditate: {humidity}%")

    wind = weather.get("wind_speed")
    wind_unit = str(weather.get("wind_speed_unit") or "").strip()
    if wind is not None:
        parts.append(f"Vânt: {wind} {wind_unit}".strip())

    forecast = weather.get("forecast") or []
    if isinstance(forecast, list) and forecast:
        preview = []
        for item in forecast[:3]:
            if not isinstance(item, dict):
                continue
            day = str(item.get("datetime") or "")[:10]
            condition = str(item.get("condition") or "").strip()
            hi = item.get("temperature")
            low = item.get("templow")
            band = ""
            if hi is not None and low is not None:
                band = f" {low}–{hi}{weather.get('forecast_temperature_unit') or weather.get('temperature_unit') or ''}"
            preview.append(f"{day}{band} {condition}".strip())
        if preview:
            parts.append("Prognoză: " + "; ".join(preview))

    return "[Open Meteo]\n" + "\n".join(parts)
