from __future__ import annotations

import asyncio
from typing import Any

import open_meteo_client
from integrations.base import BaseEntity
from pathlib import Path

from integrations.component_import import import_sibling

_extract_mod = import_sibling(Path(__file__).resolve().parent, "extract")
extract_weather_candidates = _extract_mod.extract_weather_candidates


_TEST_TIMEOUT_SECONDS = 55.0


class OpenMeteoEntity(BaseEntity):
    slug = "open_meteo"
    label = "Open Meteo"
    description = "Prognoza meteo locală (temperatură, umiditate, vânt, precipitații) de la serviciul gratuit Open-Meteo."
    icon = "fa-cloud-sun"
    color = "text-sky-400"
    scan_interval_seconds = 900
    uses_refresh_layers = True
    probe_interval_cycles = 4
    SUPPORTS_MULTIPLE = True

    CONFIG_SCHEMA = [
        {"key": "location", "label": "Locație (nume)", "type": "text", "placeholder": "București"},
        {"key": "latitude", "label": "Latitudine", "type": "text", "placeholder": "44.4268"},
        {"key": "longitude", "label": "Longitudine", "type": "text", "placeholder": "26.1025"},
        {"key": "scan_interval", "label": "Interval sync (sec)", "type": "number", "default": 900, "min": 300},
    ]

    def is_configured(self, cfg: dict[str, Any]) -> bool:
        section = self.config_section(cfg)
        has_location = bool((section.get("location") or "").strip()) or bool(
            isinstance(section.get("locations"), list) and section.get("locations")
        )
        has_coordinates = section.get("latitude") not in (None, "") and section.get("longitude") not in (None, "")
        return has_location or has_coordinates

    @classmethod
    async def async_test_connection(cls, data: dict[str, Any]) -> dict[str, Any]:
        try:
            from open_meteo_client import OpenMeteoClient, _parse_coordinate

            d = dict(data or {})
            location = str(d.get("location") or "").strip()
            lat = _parse_coordinate(d.get("latitude"))
            lon = _parse_coordinate(d.get("longitude"))
            if not location and (lat is None or lon is None):
                return {"ok": False, "message_key": "integrations.open_meteo_location"}
            client = OpenMeteoClient(
                location_query=location,
                latitude=lat,
                longitude=lon,
                forecast_days=int(d.get("forecast_days") or 5),
                cache_ttl=int(d.get("scan_interval") or 900),
            )
            return await asyncio.wait_for(client.test_connection(), timeout=_TEST_TIMEOUT_SECONDS)
        except asyncio.TimeoutError:
            return {"ok": False, "message_key": "integrations.open_meteo_slow"}
        except Exception as exc:
            return {"ok": False, "message": str(exc) or exc.__class__.__name__}

    async def _fetch_payload(self, *, force: bool) -> dict[str, Any]:
        if self.entry_data:
            from open_meteo_client import OpenMeteoClient, _parse_coordinate

            d = self.entry_data
            location = str(d.get("location") or "").strip()
            lat = _parse_coordinate(d.get("latitude"))
            lon = _parse_coordinate(d.get("longitude"))
            if not location and (lat is None or lon is None):
                raise ValueError("Open Meteo entry needs a location or coordinates")
            client = OpenMeteoClient(
                location_query=location,
                latitude=lat,
                longitude=lon,
                forecast_days=int(d.get("forecast_days") or 5),
                cache_ttl=int(d.get("scan_interval") or 900),
                temperature_unit=str(d.get("temperature_unit") or "celsius"),
                wind_speed_unit=str(d.get("wind_speed_unit") or "kmh"),
                precipitation_unit=str(d.get("precipitation_unit") or "mm"),
            )
            return await client.fetch_all(force=force)
        raise ValueError("Open Meteo is not configured — add a config entry")

    async def fetch_entities(self) -> dict[str, Any]:
        return await self.probe_source()

    async def probe_source(self) -> dict[str, Any]:
        return await self._fetch_payload(force=True)

    async def pull_live_states(self, cached: dict[str, Any]) -> dict[str, Any]:
        del cached
        return await self._fetch_payload(force=False)

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        return extract_weather_candidates(payload, self.slug)

    def format_context(self, entities: dict[str, Any]) -> str:
        return open_meteo_client.format_open_meteo_context(entities)
