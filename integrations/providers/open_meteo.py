"""Legacy import path — implementation lives in components/open_meteo/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

OpenMeteoEntity = get_component_entity_class("open_meteo")
if OpenMeteoEntity is None:
    raise ImportError("open_meteo component failed to load from components/open_meteo/")

__all__ = ["OpenMeteoEntity"]
