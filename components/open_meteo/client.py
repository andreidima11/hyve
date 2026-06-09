"""Open Meteo integration client and AI context formatter."""

from __future__ import annotations

import asyncio
import re
import time
import unicodedata
from dataclasses import dataclass
from typing import Any

import httpx

import settings

_HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=45.0, write=10.0, pool=10.0)
_HTTP_HEADERS = {"User-Agent": "Hyve/1.0 (open-meteo)"}
_MAX_HTTP_ATTEMPTS = 3


WMO_LABELS: dict[int, str] = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Light rain",
    63: "Rain",
    65: "Heavy rain",
    66: "Freezing rain",
    67: "Heavy freezing rain",
    71: "Light snow",
    73: "Snow",
    75: "Heavy snow",
    77: "Snow grains",
    80: "Rain showers",
    81: "Heavy rain showers",
    82: "Violent rain showers",
    85: "Snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Severe thunderstorm with hail",
}


def weather_label(code: Any) -> str:
    try:
        return WMO_LABELS.get(int(code), f"Weather {int(code)}")
    except (TypeError, ValueError):
        return "Unknown"


def weather_icon_key(code: Any, is_day: Any = True) -> str:
    try:
        value = int(code)
    except (TypeError, ValueError):
        return "cloud"

    if value == 0:
        return "sun" if bool(is_day) else "moon"
    if value in {1, 2}:
        return "partly-cloudy-day" if bool(is_day) else "partly-cloudy-night"
    if value in {3, 45, 48}:
        return "cloud"
    if value in {51, 53, 55, 56, 57, 61, 63, 66, 80, 81}:
        return "rain"
    if value in {65, 67, 82}:
        return "storm-rain"
    if value in {71, 73, 75, 77, 85, 86}:
        return "snow"
    if value in {95, 96, 99}:
        return "thunder"
    return "cloud"


@dataclass
class ResolvedLocation:
    latitude: float
    longitude: float
    name: str


def _slugify_location(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(value or "").strip().lower()).strip("_") or "location"


def _parse_coordinate(value: Any) -> float | None:
    try:
        if value in (None, ""):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _fold_location_query(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", str(value or ""))
    folded = normalized.encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", folded).strip()


def _location_query_variants(value: str) -> list[str]:
    variants: list[str] = []
    seen: set[str] = set()
    for candidate in (str(value or "").strip(), _fold_location_query(value)):
        candidate = re.sub(r"\s+", " ", candidate).strip()
        if not candidate:
            continue
        key = candidate.casefold()
        if key in seen:
            continue
        seen.add(key)
        variants.append(candidate)
    return variants


def _location_is_configured(entry: dict[str, Any]) -> bool:
    location = str(entry.get("location") or "").strip()
    latitude = entry.get("latitude")
    longitude = entry.get("longitude")
    return bool(location or (latitude not in (None, "") and longitude not in (None, "")))


def _config_location_entries(cfg: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    cfg = cfg or (settings.CFG.get("open_meteo") or {})
    defaults = {
        "forecast_days": int(cfg.get("forecast_days") or 5),
        "scan_interval": int(cfg.get("scan_interval") or 900),
        "temperature_unit": str(cfg.get("temperature_unit") or "celsius"),
        "wind_speed_unit": str(cfg.get("wind_speed_unit") or "kmh"),
        "precipitation_unit": str(cfg.get("precipitation_unit") or "mm"),
    }

    entries: list[dict[str, Any]] = []
    raw_locations = cfg.get("locations")
    if isinstance(raw_locations, list):
        for index, raw in enumerate(raw_locations):
            if not isinstance(raw, dict):
                continue
            merged = {**defaults, **raw}
            if not _location_is_configured(merged):
                continue
            entry_id = str(merged.get("id") or "").strip()
            if not entry_id:
                fallback = str(merged.get("location") or "").strip() or f"loc_{index + 1}"
                entry_id = _slugify_location(fallback)
            merged["id"] = entry_id
            entries.append(merged)

    if not entries and _location_is_configured(cfg):
        fallback = str(cfg.get("location") or "").strip() or "openmeteo"
        entries.append({
            **defaults,
            "id": "openmeteo",
            "location": str(cfg.get("location") or "").strip(),
            "latitude": cfg.get("latitude"),
            "longitude": cfg.get("longitude"),
            "name": fallback,
        })

    deduped: list[dict[str, Any]] = []
    seen: set[str] = set()
    for entry in entries:
        entry_id = str(entry.get("id") or "").strip() or _slugify_location(str(entry.get("location") or "location"))
        if entry_id in seen:
            suffix = 2
            next_id = f"{entry_id}_{suffix}"
            while next_id in seen:
                suffix += 1
                next_id = f"{entry_id}_{suffix}"
            entry_id = next_id
        seen.add(entry_id)
        normalized = dict(entry)
        normalized["id"] = entry_id
        deduped.append(normalized)
    return deduped


def _entity_id_for_entry(index: int, entry: dict[str, Any]) -> str:
    return "weather.openmeteo" if index == 0 else f"weather.openmeteo_{entry['id']}"


class OpenMeteoClient:
    def __init__(
        self,
        *,
        location_query: str = "",
        latitude: float | None = None,
        longitude: float | None = None,
        forecast_days: int = 5,
        cache_ttl: int = 900,
        temperature_unit: str = "celsius",
        wind_speed_unit: str = "kmh",
        precipitation_unit: str = "mm",
    ):
        self.location_query = str(location_query or "").strip()
        self.latitude = _parse_coordinate(latitude)
        self.longitude = _parse_coordinate(longitude)
        self.forecast_days = max(3, min(int(forecast_days or 5), 7))
        self.cache_ttl = max(int(cache_ttl or 900), 60)
        self.temperature_unit = str(temperature_unit or "celsius").strip() or "celsius"
        self.wind_speed_unit = str(wind_speed_unit or "kmh").strip() or "kmh"
        self.precipitation_unit = str(precipitation_unit or "mm").strip() or "mm"
        self._cache: dict[str, Any] | None = None
        self._cache_at = 0.0
        self._resolved_location: ResolvedLocation | None = None

    def clear_cache(self):
        self._cache = None
        self._cache_at = 0.0
        self._resolved_location = None

    async def _get_json(self, url: str, params: dict[str, Any]) -> dict[str, Any]:
        last_exc: Exception | None = None
        for attempt in range(1, _MAX_HTTP_ATTEMPTS + 1):
            try:
                async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT, headers=_HTTP_HEADERS) as client:
                    response = await client.get(url, params=params)
                    response.raise_for_status()
                    return response.json()
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_exc = exc
                if attempt >= _MAX_HTTP_ATTEMPTS:
                    break
                await asyncio.sleep(min(1.5 * attempt, 4.0))
        if isinstance(last_exc, httpx.TimeoutException):
            raise ValueError(
                "Open-Meteo nu a răspuns la timp. Verifică conexiunea la internet sau încearcă din nou."
            ) from last_exc
        raise ValueError("Open-Meteo este temporar indisponibil. Încearcă din nou.") from last_exc

    def _location_from_open_meteo(self, payload: Any, query: str) -> ResolvedLocation | None:
        if not isinstance(payload, dict):
            return None
        results = payload.get("results") or []
        if not results:
            return None

        first = results[0]
        label_parts = [first.get("name") or query]
        for key in ("admin1", "country"):
            value = str(first.get(key) or "").strip()
            if value:
                label_parts.append(value)

        return ResolvedLocation(
            latitude=float(first["latitude"]),
            longitude=float(first["longitude"]),
            name=", ".join(label_parts),
        )

    def _location_from_nominatim(self, payload: Any, query: str) -> ResolvedLocation | None:
        if not isinstance(payload, list) or not payload:
            return None
        first = payload[0]
        if not isinstance(first, dict):
            return None

        address = first.get("address") if isinstance(first.get("address"), dict) else {}
        name = str(first.get("name") or address.get("city") or address.get("town") or address.get("village") or query).strip()
        label_parts = [name]
        for key in ("state", "county", "country"):
            value = str(address.get(key) or "").strip()
            if value and value.casefold() not in {part.casefold() for part in label_parts}:
                label_parts.append(value)

        if len(label_parts) == 1:
            display_name = str(first.get("display_name") or "").strip()
            if display_name:
                label_parts = [part.strip() for part in display_name.split(",")[:3] if part.strip()]

        return ResolvedLocation(
            latitude=float(first["lat"]),
            longitude=float(first["lon"]),
            name=", ".join(label_parts) or query,
        )

    async def _resolve_with_open_meteo_geocoding(self, queries: list[str]) -> tuple[ResolvedLocation | None, Exception | None]:
        last_error: Exception | None = None
        for query in queries:
            try:
                payload = await self._get_json(
                    "https://geocoding-api.open-meteo.com/v1/search",
                    {"name": query, "count": 1, "format": "json", "language": "en"},
                )
            except (httpx.HTTPError, ValueError) as exc:
                last_error = exc
                continue
            location = self._location_from_open_meteo(payload, query)
            if location:
                return location, None
        return None, last_error

    async def _resolve_with_nominatim_geocoding(self, queries: list[str]) -> ResolvedLocation | None:
        for query in queries:
            try:
                payload = await self._get_json(
                    "https://nominatim.openstreetmap.org/search",
                    {"q": query, "format": "jsonv2", "limit": 1, "addressdetails": 1, "accept-language": "en"},
                )
            except (httpx.HTTPError, ValueError):
                continue
            location = self._location_from_nominatim(payload, query)
            if location:
                return location
        return None

    async def _resolve_location(self) -> ResolvedLocation:
        if self._resolved_location is not None:
            return self._resolved_location

        if self.latitude is not None and self.longitude is not None:
            location = ResolvedLocation(
                latitude=float(self.latitude),
                longitude=float(self.longitude),
                name=self.location_query or f"{float(self.latitude):.2f}, {float(self.longitude):.2f}",
            )
            self._resolved_location = location
            return location

        if not self.location_query:
            raise ValueError("Location is not configured")

        queries = _location_query_variants(self.location_query)
        location, last_error = await self._resolve_with_open_meteo_geocoding(queries)
        if location:
            self._resolved_location = location
            return location

        location = await self._resolve_with_nominatim_geocoding(queries)
        if location:
            self._resolved_location = location
            return location

        if last_error:
            raise ValueError(f"Location '{self.location_query}' could not be resolved right now. Try again later or configure latitude and longitude.") from last_error
        else:
            raise ValueError(f"Location '{self.location_query}' was not found")

    async def test_connection(self) -> dict[str, Any]:
        try:
            data = await self.fetch_all(force=True)
            location_name = ((data.get("location") or {}).get("name") or "configured location").strip()
            return {"ok": True, "message": f"Forecast available for {location_name}"}
        except Exception as exc:
            return {"ok": False, "message": str(exc)}

    async def fetch_all(self, force: bool = False) -> dict[str, Any]:
        now = time.time()
        if not force and self._cache and now - self._cache_at < self.cache_ttl:
            return self._cache

        location = await self._resolve_location()
        payload = await self._get_json(
            "https://api.open-meteo.com/v1/forecast",
            {
                "latitude": location.latitude,
                "longitude": location.longitude,
                "timezone": "auto",
                "forecast_days": self.forecast_days,
                # Default API returns ~7 days hourly; we only need a few hours ahead.
                "forecast_hours": 24,
                "past_hours": 1,
                "temperature_unit": self.temperature_unit,
                "wind_speed_unit": self.wind_speed_unit,
                "precipitation_unit": self.precipitation_unit,
                "current": ",".join([
                    "temperature_2m",
                    "apparent_temperature",
                    "relative_humidity_2m",
                    "weather_code",
                    "wind_speed_10m",
                    "wind_gusts_10m",
                    "wind_direction_10m",
                    "precipitation",
                    "cloud_cover",
                    "surface_pressure",
                    "is_day",
                ]),
                "daily": ",".join([
                    "weather_code",
                    "temperature_2m_max",
                    "temperature_2m_min",
                    "precipitation_sum",
                    "precipitation_probability_max",
                    "uv_index_max",
                    "sunrise",
                    "sunset",
                ]),
                "hourly": ",".join([
                    "temperature_2m",
                    "weather_code",
                    "precipitation_probability",
                    "is_day",
                ]),
            },
        )

        current = payload.get("current") or {}
        daily = payload.get("daily") or {}
        hourly = payload.get("hourly") or {}
        current_units = payload.get("current_units") or {}
        daily_units = payload.get("daily_units") or {}

        forecast: list[dict[str, Any]] = []
        daily_times = daily.get("time") or []
        for index, day in enumerate(daily_times[: self.forecast_days]):
            weather_code = (daily.get("weather_code") or [None])[index] if index < len(daily.get("weather_code") or []) else None
            forecast.append({
                "datetime": day,
                "condition": weather_label(weather_code),
                "weather_code": weather_code,
                "icon": weather_icon_key(weather_code, True),
                "temperature": (daily.get("temperature_2m_max") or [None])[index] if index < len(daily.get("temperature_2m_max") or []) else None,
                "templow": (daily.get("temperature_2m_min") or [None])[index] if index < len(daily.get("temperature_2m_min") or []) else None,
                "precipitation": (daily.get("precipitation_sum") or [None])[index] if index < len(daily.get("precipitation_sum") or []) else None,
                "precipitation_probability": (daily.get("precipitation_probability_max") or [None])[index] if index < len(daily.get("precipitation_probability_max") or []) else None,
                "uv_index": (daily.get("uv_index_max") or [None])[index] if index < len(daily.get("uv_index_max") or []) else None,
                "sunrise": (daily.get("sunrise") or [""])[index] if index < len(daily.get("sunrise") or []) else "",
                "sunset": (daily.get("sunset") or [""])[index] if index < len(daily.get("sunset") or []) else "",
            })

        hourly_items: list[dict[str, Any]] = []
        hourly_times = hourly.get("time") or []
        current_time = str(current.get("time") or "").strip()
        start_index = hourly_times.index(current_time) if current_time and current_time in hourly_times else 0
        for index, moment in enumerate(hourly_times[start_index:start_index + 8], start=start_index):
            weather_code = (hourly.get("weather_code") or [None])[index] if index < len(hourly.get("weather_code") or []) else None
            is_day = bool((hourly.get("is_day") or [1])[index]) if index < len(hourly.get("is_day") or []) else True
            hourly_items.append({
                "datetime": moment,
                "temperature": (hourly.get("temperature_2m") or [None])[index] if index < len(hourly.get("temperature_2m") or []) else None,
                "condition": weather_label(weather_code),
                "weather_code": weather_code,
                "icon": weather_icon_key(weather_code, is_day),
                "precipitation_probability": (hourly.get("precipitation_probability") or [None])[index] if index < len(hourly.get("precipitation_probability") or []) else None,
                "is_day": is_day,
            })

        weather_code = current.get("weather_code")
        weather = {
            "entity_id": "weather.openmeteo",
            "name": f"Open Meteo • {location.name}",
            "friendly_name": location.name,
            "state": weather_label(weather_code),
            "condition": weather_label(weather_code),
            "weather_code": weather_code,
            "icon": weather_icon_key(weather_code, bool(current.get("is_day", 1))),
            "temperature": current.get("temperature_2m"),
            "temperature_unit": current_units.get("temperature_2m") or ("°F" if self.temperature_unit == "fahrenheit" else "°C"),
            "apparent_temperature": current.get("apparent_temperature"),
            "humidity": current.get("relative_humidity_2m"),
            "wind_speed": current.get("wind_speed_10m"),
            "wind_speed_unit": current_units.get("wind_speed_10m") or self.wind_speed_unit,
            "wind_gusts": current.get("wind_gusts_10m"),
            "wind_direction": current.get("wind_direction_10m"),
            "pressure": current.get("surface_pressure"),
            "pressure_unit": current_units.get("surface_pressure") or "hPa",
            "precipitation": current.get("precipitation"),
            "precipitation_unit": current_units.get("precipitation") or self.precipitation_unit,
            "cloud_cover": current.get("cloud_cover"),
            "is_day": bool(current.get("is_day", 1)),
            "forecast": forecast,
            "hourly": hourly_items,
            "forecast_temperature_unit": daily_units.get("temperature_2m_max") or current_units.get("temperature_2m") or "°C",
            "forecast_precipitation_unit": daily_units.get("precipitation_sum") or self.precipitation_unit,
            "timezone": payload.get("timezone") or "UTC",
            "attribution": "Weather data by Open-Meteo.com",
        }

        result = {
            "location": {
                "name": location.name,
                "latitude": location.latitude,
                "longitude": location.longitude,
                "timezone": payload.get("timezone") or "UTC",
            },
            "weather": weather,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        }
        self._cache = result
        self._cache_at = now
        return result

