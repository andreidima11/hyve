"""Mosquitto / Zigbee2MQTT control command building."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from components.mosquitto.extract import (
    _build_command,
    _entities_from_z2m_exposes,
    _resolve_control_caps,
    _rewrite_z2m_command_topic,
)


def test_z2m_state_l3_turn_on_uses_json_payload():
    caps = {
        "command_topic": "zigbee2mqtt/0xa4c138fe8b1226ab/set",
        "z2m_property": "state_l3",
        "payload_on": "ON",
        "payload_off": "OFF",
    }
    topic, payload = _build_command("switch", "turn_on", caps, None)
    assert topic == "zigbee2mqtt/0xa4c138fe8b1226ab/set"
    assert payload == '{"state_l3": "ON"}'


def test_z2m_state_l3_turn_off_uses_json_payload():
    caps = {
        "command_topic": "zigbee2mqtt/relay/set",
        "z2m_property": "state_l3",
    }
    topic, payload = _build_command("switch", "turn_off", caps, None)
    assert payload == '{"state_l3": "OFF"}'


def test_z2m_expose_parser_populates_command_capabilities():
    from unittest.mock import patch

    device = {
        "friendly_name": "0xa4c138fe8b1226ab",
        "ieee_address": "0xA4C138FE8B1226AB",
        "definition": {
            "model": "TS0003",
            "vendor": "Tuya",
            "exposes": [
                {
                    "type": "binary",
                    "property": "state_l3",
                    "access": 7,
                    "value_on": "ON",
                    "value_off": "OFF",
                }
            ],
        },
    }
    states = {
        "zigbee2mqtt/0xa4c138fe8b1226ab": {"state_l3": "OFF"},
    }
    with patch(
        "components.mosquitto.extract._resolve_z2m_display_name",
        return_value="0xa4c138fe8b1226ab",
    ):
        entities = _entities_from_z2m_exposes(device, states)
    assert len(entities) == 1
    ent = entities[0]
    assert ent["unique_id"] == "z2m:0xa4c138fe8b1226ab:state_l3"
    caps = ent["attributes"]["capabilities"]
    assert caps["command_topic"] == "zigbee2mqtt/0xa4c138fe8b1226ab/set"
    assert caps["z2m_property"] == "state_l3"
    topic, payload = _build_command("switch", "turn_on", _resolve_control_caps(ent), None)
    assert payload == '{"state_l3": "ON"}'


def test_resolve_control_caps_merges_legacy_attributes():
    record = {
        "domain": "switch",
        "attributes": {
            "command_topic": "zigbee2mqtt/lamp/set",
            "z2m_property": "state_l2",
            "capabilities": {},
        },
    }
    caps = _resolve_control_caps(record)
    assert caps["command_topic"] == "zigbee2mqtt/lamp/set"
    assert caps["z2m_property"] == "state_l2"


def test_ha_discovery_endpoint_topic_uses_native_z2m_set_json():
    caps = {
        "command_topic": "zigbee2mqtt/0xa4c138fe8b1226ab/l3/set",
        "state_topic": "zigbee2mqtt/0xa4c138fe8b1226ab",
        "value_template": "{{ value_json.state_l3 }}",
        "payload_on": "ON",
        "payload_off": "OFF",
    }
    topic, payload = _build_command("switch", "turn_on", caps, None)
    assert topic == "zigbee2mqtt/0xa4c138fe8b1226ab/set"
    assert payload == '{"state_l3": "ON"}'


def test_rewrite_z2m_command_topic_uses_live_z2m_friendly_not_registry():
    from unittest.mock import MagicMock, patch

    record = {
        "attributes": {
            "device_id": "0xa4c138fe8b1226ab",
            "zigbee_ieee": "0xa4c138fe8b1226ab",
            "device_name": "releu_dormitor2",
        }
    }
    bridge = MagicMock()
    bridge._z2m_devices = [
        {"ieee_address": "0xA4C138FE8B1226AB", "friendly_name": "Lampa Birou"},
    ]
    with patch("components.mosquitto.extract._bridge_mod.get_bridge", return_value=bridge):
        topic = _rewrite_z2m_command_topic("zigbee2mqtt/0xa4c138fe8b1226ab/set", record)
    assert topic == "zigbee2mqtt/Lampa Birou/set"


def test_rewrite_z2m_command_topic_replaces_stale_friendly_in_endpoint_path():
    from unittest.mock import MagicMock, patch

    record = {
        "attributes": {
            "device_id": "0xa4c138fe8b1226ab",
            "zigbee_ieee": "0xa4c138fe8b1226ab",
            "device_name": "releu_dormitor2",
        }
    }
    bridge = MagicMock()
    bridge._z2m_devices = [
        {"ieee_address": "0xA4C138FE8B1226AB", "friendly_name": "releu dormitor 2"},
    ]
    with patch("components.mosquitto.extract._bridge_mod.get_bridge", return_value=bridge):
        topic = _rewrite_z2m_command_topic(
            "zigbee2mqtt/Lampa Birou/l3/set",
            record,
        )
    assert topic == "zigbee2mqtt/releu dormitor 2/l3/set"


def test_rewrite_z2m_command_topic_keeps_ieee_when_z2m_uses_ieee():
    from unittest.mock import MagicMock, patch

    record = {
        "attributes": {
            "device_id": "0xa4c138fe8b1226ab",
            "zigbee_ieee": "0xa4c138fe8b1226ab",
            "device_name": "releu_dormitor2",
        }
    }
    bridge = MagicMock()
    bridge._z2m_devices = [
        {"ieee_address": "0xA4C138FE8B1226AB", "friendly_name": "0xa4c138fe8b1226ab"},
    ]
    with patch("components.mosquitto.extract._bridge_mod.get_bridge", return_value=bridge):
        topic = _rewrite_z2m_command_topic("zigbee2mqtt/0xa4c138fe8b1226ab/set", record)
    assert topic == "zigbee2mqtt/0xa4c138fe8b1226ab/set"


def test_mosquitto_control_entity_publishes_live_friendly_topic():
    async def run():
        from components.mosquitto.entity import MosquittoEntity

        entity = MosquittoEntity(entry_id="mqtt-entry")
        device = {
            "friendly_name": "releu dormitor 2",
            "ieee_address": "0xA4C138FE8B1226AB",
        }
        live_row = {
            "entity_id": "switch.lampa_birou_state_l3",
            "unique_id": "mqtt:old_l3",
            "domain": "switch",
            "attributes": {
                "device_id": "0xa4c138fe8b1226ab",
                "zigbee_ieee": "0xa4c138fe8b1226ab",
                "capabilities": {
                    "command_topic": "zigbee2mqtt/Lampa Birou/l3/set",
                    "value_template": "{{ value_json.state_l3 }}",
                    "payload_on": "ON",
                    "payload_off": "OFF",
                    "z2m_property": "state_l3",
                },
            },
        }
        bridge = MagicMock()
        bridge._z2m_devices = [device]
        published: list[tuple[str, str]] = []

        async def capture_publish(cfg, topic, pl, **kw):
            published.append((topic, pl))

        with patch.object(entity, "_live_entity_items", return_value=[live_row]):
            with patch("components.mosquitto.extract._bridge_mod.get_bridge", return_value=bridge):
                with patch("components.mosquitto.entity._publish", side_effect=capture_publish):
                    result = await entity.control_entity(
                        "switch.lampa_birou_state_l3",
                        "turn_on",
                    )

        assert result["payload"] == '{"state_l3": "ON"}'
        assert published[0][0] == "zigbee2mqtt/releu dormitor 2/set"

    asyncio.run(run())


def test_z2m_enum_expose_populates_select_options():
    device = {
        "friendly_name": "releu_d2",
        "ieee_address": "0xA4C138FE8B1226AB",
        "definition": {
            "model": "TS0003",
            "vendor": "Tuya",
            "exposes": [
                {
                    "type": "enum",
                    "property": "switch_type",
                    "access": 7,
                    "values": ["toggle", "momentary", "rotary"],
                }
            ],
        },
    }
    states = {"zigbee2mqtt/releu_d2": {"switch_type": "momentary"}}
    entities = _entities_from_z2m_exposes(device, states)
    assert len(entities) == 1
    ent = entities[0]
    assert ent["domain"] == "select"
    assert ent["state"] == "momentary"
    caps = ent["attributes"]["capabilities"]
    assert caps["options"] == ["toggle", "momentary", "rotary"]
    assert caps["values"] == ["toggle", "momentary", "rotary"]
    topic, payload = _build_command("select", "set", _resolve_control_caps(ent), {"value": "toggle"})
    assert topic == "zigbee2mqtt/releu_d2/set"
    assert payload == '{"switch_type": "toggle"}'


def test_resolve_control_caps_backfills_select_options_from_values():
    record = {
        "domain": "select",
        "attributes": {
            "capabilities": {
                "values": ["off", "on", "previous"],
                "command_topic": "zigbee2mqtt/lamp/set",
                "z2m_property": "indicator_mode",
            },
        },
    }
    caps = _resolve_control_caps(record)
    assert caps["options"] == ["off", "on", "previous"]


def test_ha_discovery_infers_z2m_property_from_value_template():
    caps = {
        "command_topic": "zigbee2mqtt/lamp/set",
        "value_template": "{{ value_json.state_l1 }}",
        "payload_on": "ON",
        "payload_off": "OFF",
    }
    topic, payload = _build_command("switch", "turn_on", caps, None)
    assert payload == '{"state_l1": "ON"}'
