"""Declarative Mammotion entity specs (HA-style platforms)."""

from components.mammotion.specs.identifiers import (
    base_entity,
    device_id,
    slugify_device_name,
    unique_id,
)
from components.mammotion.specs.mower import build_mower_entities
from components.mammotion.specs.rtk import build_rtk_entities
from components.mammotion.specs.spino import build_spino_entities
from components.mammotion.specs.value import number_value_usable, sensor_value_usable

__all__ = [
    "base_entity",
    "build_mower_entities",
    "build_rtk_entities",
    "build_spino_entities",
    "device_id",
    "number_value_usable",
    "sensor_value_usable",
    "slugify_device_name",
    "unique_id",
]
