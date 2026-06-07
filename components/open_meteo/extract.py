from __future__ import annotations

from typing import Any

from integrations.entity_utils import finalize_entities as _finalize

def extract_weather_candidates(payload: Any, source: str = "open_meteo") -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    if not isinstance(payload, dict):
        return items

    location_payloads = payload.get("locations") if isinstance(payload.get("locations"), list) else None
    if location_payloads:
        for location_payload in location_payloads:
            if isinstance(location_payload, dict):
                items.extend(extract_weather_candidates(location_payload, source))
        return items

    weather = payload.get("weather") if isinstance(payload.get("weather"), dict) else payload
    if not isinstance(weather, dict) or not weather:
        return items

    source_slug = str(source or weather.get("source") or "weather").strip() or "weather"
    entity_id = str(weather.get("entity_id") or f"weather.{source_slug.replace('_', '')}").strip()
    condition = str(weather.get("condition") or weather.get("state") or "Unknown").strip() or "Unknown"
    temperature = weather.get("temperature")
    temp_unit = str(weather.get("temperature_unit") or "").strip()
    location_name = str(weather.get("friendly_name") or weather.get("name") or source_slug.replace("_", " ").title()).strip()
    state = condition
    if temperature is not None:
        state = f"{temperature}{temp_unit} • {condition}".strip()

    aliases = [location_name, condition, "weather", "forecast"]
    if source_slug == "open_meteo":
        aliases.append("open meteo")

    items.append({
        "entity_id": entity_id,
        "name": location_name,
        "state": state,
        "domain": "weather",
        "source": source_slug,
        "aliases": aliases,
        "unit": temp_unit,
        "controllable": False,
        "attributes": {
            "condition": condition,
            "weather_code": weather.get("weather_code"),
            "temperature": weather.get("temperature"),
            "temperature_unit": weather.get("temperature_unit"),
            "humidity": weather.get("humidity"),
            "wind_speed": weather.get("wind_speed"),
            "wind_speed_unit": weather.get("wind_speed_unit"),
            "apparent_temperature": weather.get("apparent_temperature"),
            "daylight_duration": weather.get("daylight_duration"),
            "sunshine_duration": weather.get("sunshine_duration"),
            "precipitation": weather.get("precipitation"),
            "precipitation_unit": weather.get("precipitation_unit"),
            "cloud_cover": weather.get("cloud_cover"),
            "is_day": weather.get("is_day"),
            "forecast": weather.get("forecast") if isinstance(weather.get("forecast"), list) else [],
            "hourly": weather.get("hourly") if isinstance(weather.get("hourly"), list) else [],
            "attribution": weather.get("attribution") or "",
            "timezone": weather.get("timezone") or "",
        },
    })
    return _finalize(items, default_source=source)
