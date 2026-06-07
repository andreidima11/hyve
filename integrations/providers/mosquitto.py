"""Legacy import path — implementation lives in components/mosquitto/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

MosquittoEntity = get_component_entity_class('mosquitto')
if MosquittoEntity is None:
    raise ImportError("mosquitto component failed to load from components/mosquitto/")

__all__ = ["MosquittoEntity"]
