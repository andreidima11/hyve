"""Legacy import path — implementation lives in components/reteleelectrice/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

ReteleElectriceEntity = get_component_entity_class('reteleelectrice')
if ReteleElectriceEntity is None:
    raise ImportError("reteleelectrice component failed to load from components/reteleelectrice/")

__all__ = ["ReteleElectriceEntity"]
