"""Legacy import path — implementation lives in components/roborock/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

RoborockEntity = get_component_entity_class('roborock')
if RoborockEntity is None:
    raise ImportError("roborock component failed to load from components/roborock/")

__all__ = ["RoborockEntity"]
