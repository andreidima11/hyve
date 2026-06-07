"""Legacy import path — implementation lives in components/hyve_scenes/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

HyveScenesEntity = get_component_entity_class('hyve_scenes')
if HyveScenesEntity is None:
    raise ImportError("hyve_scenes component failed to load from components/hyve_scenes/")

__all__ = ["HyveScenesEntity"]
