"""Hyve Sun integration — astronomical sunrise/sunset/elevation."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from integrations.base import BaseEntity
from integrations.component_import import import_sibling

log = logging.getLogger("integrations.sun")

_COMPONENT_DIR = Path(__file__).resolve().parent
_calc = import_sibling(_COMPONENT_DIR, "calculator")
find_next_event = _calc.find_next_event
find_next_extremum = _calc.find_next_extremum
solar_position = _calc.solar_position


class SunEntity(BaseEntity):
    slug = "sun"
    label = "Sun"
    description = "Poziția soarelui (răsărit, apus, elevație, azimut)"
    icon = "fa-sun"
    color = "text-amber-400"
    scan_interval_seconds = 60
    uses_refresh_layers = True
    probe_interval_cycles = 30
    SUPPORTS_MULTIPLE = False

    CONFIG_SCHEMA = [
        {"key": "latitude", "label": "Latitudine", "type": "text", "placeholder": "44.4268"},
        {"key": "longitude", "label": "Longitudine", "type": "text", "placeholder": "26.1025"},
    ]

    def is_configured(self, cfg: dict[str, Any]) -> bool:
        section = self.config_section(cfg)
        return section.get("latitude") not in (None, "") and section.get("longitude") not in (None, "")

    def _coords(self) -> tuple[float, float]:
        def _parse(value):
            try:
                return float(str(value).strip())
            except (TypeError, ValueError, AttributeError):
                return None

        lat = _parse(self.entry_data.get("latitude"))
        lon = _parse(self.entry_data.get("longitude"))
        if lat is not None and lon is not None:
            return lat, lon
        try:
            from integrations import config_entries as _ce

            for entry in _ce.list_entries("sun"):
                data = entry.get("data") or {}
                fl = _parse(data.get("latitude"))
                fo = _parse(data.get("longitude"))
                if fl is not None and fo is not None:
                    return fl, fo
        except Exception:
            pass
        try:
            import settings

            section = (settings.CFG or {}).get("location") or {}
            return float(section.get("latitude") or 44.4268), float(section.get("longitude") or 26.1025)
        except Exception:
            return 44.4268, 26.1025

    def _sun_payload(self) -> dict[str, Any]:
        lat, lon = self._coords()
        now_utc = datetime.now(timezone.utc)
        elevation, azimuth = solar_position(now_utc, lat, lon)
        next_rising = find_next_event(now_utc, lat, lon, -0.833, rising=True)
        next_setting = find_next_event(now_utc, lat, lon, -0.833, rising=False)
        next_dawn = find_next_event(now_utc, lat, lon, -6.0, rising=True)
        next_dusk = find_next_event(now_utc, lat, lon, -6.0, rising=False)
        next_noon = find_next_extremum(now_utc, lat, lon, maximum=True)
        next_midnight = find_next_extremum(now_utc, lat, lon, maximum=False)
        rising = bool(next_noon and next_midnight and next_noon < next_midnight)

        def _fmt(dt: datetime | None) -> str | None:
            if dt is None:
                return None
            return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S")

        return {
            "elevation": round(elevation, 2),
            "azimuth": round(azimuth, 2),
            "next_rising": _fmt(next_rising),
            "next_setting": _fmt(next_setting),
            "next_dawn": _fmt(next_dawn),
            "next_dusk": _fmt(next_dusk),
            "next_noon": _fmt(next_noon),
            "next_midnight": _fmt(next_midnight),
            "rising": rising,
        }

    async def fetch_entities(self) -> dict[str, Any]:
        return await self.probe_source()

    async def probe_source(self) -> dict[str, Any]:
        return self._sun_payload()

    async def pull_live_states(self, cached: dict[str, Any]) -> dict[str, Any]:
        del cached
        return self._sun_payload()

    def extract_entities(self, payload: Any) -> list[dict[str, Any]]:
        if not isinstance(payload, dict):
            return []
        elevation = payload.get("elevation", 0.0)
        state = "above_horizon" if elevation > -0.833 else "below_horizon"
        attrs = {
            "elevation": payload.get("elevation"),
            "azimuth": payload.get("azimuth"),
            "next_rising": payload.get("next_rising"),
            "next_setting": payload.get("next_setting"),
            "next_dawn": payload.get("next_dawn"),
            "next_dusk": payload.get("next_dusk"),
            "next_noon": payload.get("next_noon"),
            "next_midnight": payload.get("next_midnight"),
            "rising": payload.get("rising"),
        }
        entities: list[dict[str, Any]] = [
            {
                "entity_id": "sun.sun",
                "name": "Sun",
                "friendly_name": "Sun",
                "state": state,
                "domain": "sun",
                "source": self.slug,
                "controllable": False,
                "icon": "fas fa-sun",
                "attributes": attrs,
            }
        ]
        sensor_specs = [
            ("sensor.sun_next_dawn", "Next dawn", payload.get("next_dawn"), "fas fa-cloud-sun", "timestamp"),
            ("sensor.sun_next_dusk", "Next dusk", payload.get("next_dusk"), "fas fa-cloud-moon", "timestamp"),
            ("sensor.sun_next_midnight", "Next midnight", payload.get("next_midnight"), "fas fa-moon", "timestamp"),
            ("sensor.sun_next_noon", "Next noon", payload.get("next_noon"), "fas fa-sun", "timestamp"),
            ("sensor.sun_next_rising", "Next rising", payload.get("next_rising"), "fas fa-sun", "timestamp"),
            ("sensor.sun_next_setting", "Next setting", payload.get("next_setting"), "fas fa-sun", "timestamp"),
            ("sensor.sun_solar_elevation", "Solar elevation", payload.get("elevation"), "fas fa-arrows-up-down", "°"),
            ("sensor.sun_solar_azimuth", "Solar azimuth", payload.get("azimuth"), "fas fa-compass", "°"),
        ]
        for entity_id, friendly, value, icon, unit in sensor_specs:
            entities.append(
                {
                    "entity_id": entity_id,
                    "name": friendly,
                    "friendly_name": friendly,
                    "state": value,
                    "domain": "sensor",
                    "source": self.slug,
                    "controllable": False,
                    "icon": icon,
                    "attributes": {"unit_of_measurement": unit} if unit else {},
                }
            )
        entities.append(
            {
                "entity_id": "binary_sensor.sun_solar_rising",
                "name": "Solar rising",
                "friendly_name": "Solar rising",
                "state": "on" if payload.get("rising") else "off",
                "domain": "binary_sensor",
                "source": self.slug,
                "controllable": False,
                "icon": "fas fa-arrow-trend-up",
                "attributes": {},
            }
        )
        return entities

    def format_context(self, entities: dict[str, Any]) -> str:
        if not isinstance(entities, dict):
            return ""
        elev = entities.get("elevation")
        if elev is None:
            return ""
        return (
            f"Sun elevation {elev}°, next sunrise {entities.get('next_rising')}, "
            f"next sunset {entities.get('next_setting')}."
        )


def ensure_default_entry() -> None:
    """Auto-create a Sun entry using Open-Meteo or app coordinates."""
    from integrations import config_entries

    if config_entries.list_entries("sun"):
        return
    lat = lon = None
    for entry in config_entries.list_entries("open_meteo"):
        data = entry.get("data") or {}
        try:
            lat = float(str(data.get("latitude") or "").strip())
            lon = float(str(data.get("longitude") or "").strip())
            break
        except (TypeError, ValueError):
            continue
    if lat is None or lon is None:
        try:
            import settings

            section = (settings.CFG or {}).get("location") or {}
            lat = float(section.get("latitude") or 44.4268)
            lon = float(section.get("longitude") or 26.1025)
        except Exception:
            lat, lon = 44.4268, 26.1025
    config_entries.create_entry(
        slug="sun",
        title="Sun",
        data={"latitude": str(lat), "longitude": str(lon)},
        schema=SunEntity.CONFIG_SCHEMA,
    )
    log.info("Sun integration auto-created at (%s, %s)", lat, lon)
