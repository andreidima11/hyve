"""Mosquitto / Zigbee2MQTT control command building."""

from __future__ import annotations

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


def test_rewrite_z2m_command_topic_uses_friendly_name():
    record = {
        "attributes": {
            "device_id": "0xa4c138fe8b1226ab",
            "zigbee_ieee": "0xa4c138fe8b1226ab",
            "device_name": "releu_dormitor2",
        }
    }
    topic = _rewrite_z2m_command_topic("zigbee2mqtt/0xa4c138fe8b1226ab/set", record)
    assert topic == "zigbee2mqtt/releu_dormitor2/set"


def test_ha_discovery_infers_z2m_property_from_value_template():
    caps = {
        "command_topic": "zigbee2mqtt/lamp/set",
        "value_template": "{{ value_json.state_l1 }}",
        "payload_on": "ON",
        "payload_off": "OFF",
    }
    topic, payload = _build_command("switch", "turn_on", caps, None)
    assert payload == '{"state_l1": "ON"}'
