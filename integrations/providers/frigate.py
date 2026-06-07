"""Legacy import path — implementation lives in components/frigate/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

FrigateEntity = get_component_entity_class('frigate')
if FrigateEntity is None:
    raise ImportError("frigate component failed to load from components/frigate/")

__all__ = ["FrigateEntity"]
