"""Legacy import path — implementation lives in components/ariston_net/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

AristonNetEntity = get_component_entity_class('ariston_net')
if AristonNetEntity is None:
    raise ImportError("ariston_net component failed to load from components/ariston_net/")

__all__ = ["AristonNetEntity"]
