"""Legacy import path — implementation lives in components/eon_romania/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

EonRomaniaEntity = get_component_entity_class('eon_romania')
if EonRomaniaEntity is None:
    raise ImportError("eon_romania component failed to load from components/eon_romania/")

__all__ = ["EonRomaniaEntity"]
