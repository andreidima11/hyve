"""Legacy import path — implementation lives in components/xiaomi_home/."""

from __future__ import annotations

from integrations.component_loader import get_component_entity_class

XiaomiHomeEntity = get_component_entity_class('xiaomi_home')
if XiaomiHomeEntity is None:
    raise ImportError("xiaomi_home component failed to load from components/xiaomi_home/")

__all__ = ["XiaomiHomeEntity"]
