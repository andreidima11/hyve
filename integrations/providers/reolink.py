"""Legacy import path — implementation lives in components/reolink/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

ReolinkEntity = get_component_entity_class('reolink')
if ReolinkEntity is None:
    raise ImportError("reolink component failed to load from components/reolink/")

__all__ = ["ReolinkEntity"]
