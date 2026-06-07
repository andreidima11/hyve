"""Legacy import path — implementation lives in components/tapo/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

TapoEntity = get_component_entity_class('tapo')
if TapoEntity is None:
    raise ImportError("tapo component failed to load from components/tapo/")

__all__ = ["TapoEntity"]
