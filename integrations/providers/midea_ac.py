"""Legacy import path — implementation lives in components/midea_ac/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

MideaAcEntity = get_component_entity_class('midea_ac')
if MideaAcEntity is None:
    raise ImportError("midea_ac component failed to load from components/midea_ac/")

__all__ = ["MideaAcEntity"]
