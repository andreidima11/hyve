"""Legacy import path — implementation lives in components/pago/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

PagoEntity = get_component_entity_class('pago')
if PagoEntity is None:
    raise ImportError("pago component failed to load from components/pago/")

__all__ = ["PagoEntity"]
