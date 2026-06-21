"""MQTT discovery and Zigbee2MQTT expose parsing → Hyve entities (facade)."""

from __future__ import annotations

from components.mosquitto.entities import (
    _apply_ha_mqtt_light_discovery,
    _bridge_mod,
    _build_command,
    _build_device_meta,
    _drain_broker,
    _entities_from_z2m_bridge,
    _entities_from_z2m_exposes,
    _find_entity_record,
    _infer_light_capabilities_from_attributes,
    _merge_light_attributes,
    _merge_payload,
    _normalize_light_capabilities,
    _optimistic_z2m_state_patch,
    _publish,
    _resolve_control_caps,
    _rewrite_z2m_command_topic,
    extract_mosquitto_candidates,
)
from components.mosquitto.parse import (
    _live_z2m_payload,
    _resolve_z2m_display_name,
    z2m_get_payload_for_device,
)
from components.mosquitto.widgets import (
    extract_z2m_candidates,
    extract_z2m_widget_candidates,
)

__all__ = [
    "extract_mosquitto_candidates",
    "extract_z2m_candidates",
    "extract_z2m_widget_candidates",
    "z2m_get_payload_for_device",
    "_apply_ha_mqtt_light_discovery",
    "_bridge_mod",
    "_build_command",
    "_build_device_meta",
    "_drain_broker",
    "_entities_from_z2m_bridge",
    "_entities_from_z2m_exposes",
    "_find_entity_record",
    "_infer_light_capabilities_from_attributes",
    "_live_z2m_payload",
    "_merge_light_attributes",
    "_merge_payload",
    "_normalize_light_capabilities",
    "_optimistic_z2m_state_patch",
    "_publish",
    "_resolve_control_caps",
    "_resolve_z2m_display_name",
    "_rewrite_z2m_command_topic",
]
