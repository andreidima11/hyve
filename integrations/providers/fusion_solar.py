"""Legacy import path — implementation lives in components/fusion_solar/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

FusionSolarEntity = get_component_entity_class('fusion_solar')
if FusionSolarEntity is None:
    raise ImportError("fusion_solar component failed to load from components/fusion_solar/")

__all__ = ["FusionSolarEntity"]
